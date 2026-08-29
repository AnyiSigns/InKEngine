"""评审打分配置映射：review.json → :class:`ScoringConfig`（配置真源读取）。

推演分支评估接线：确定性 ``dimension_scorer``（启发式文本/结构特征，
零 LLM、零随机——保持可回放可断言）+ ``WeightedScorerEvaluator`` 组装。
默认实现放宿主侧（引擎只持有机制壳，评审策略归使用方/用户集）。
"""
from __future__ import annotations

import re
from typing import Any

from ink_engine.core.scoring import ScoreDimension, ScoringConfig


def build_review_scoring_config(review_data: dict[str, Any]) -> ScoringConfig:
    """review.json → ScoringConfig（维度/权重/通过阈值）。"""
    dimensions = tuple(
        ScoreDimension(name=str(dim["name"]), weight=float(dim["weight"]))
        for dim in review_data.get("dimensions") or ()
    )
    return ScoringConfig(
        dimensions=dimensions,
        overall_threshold=float(review_data["pass_threshold"]),
    )


def make_dimension_scorer() -> Any:
    """构造确定性维度打分器（分支规格 + 回流增量 → 维度得分表 0-1）。

    四维启发式（与 review.json 维度名对齐，未知维度 = 确定性中性 0.5）：
    - citation_quality：文本中 URL/来源标记（source/citation/reference/来源/引用）
      密度——可追溯证据越多分越高；
    - cross_validation：回流增量顶层键数与多条目列表（≥2 条目）——多源
      聚合形态分越高；
    - consistency：回流增量字段填充率（空值 = 结构不完整扣分）；
    - readability：文本平均句长（<=120 字句子密度高 = 高可读）。

    契约（引擎 scoring 语义）：返回 dict 的维度名集合必须与
    ScoringConfig.dimensions 完全一致，缺维度/未知维度 = fail-closed
    ValueError——本打分器按 config 维度名集合兜底（未命中启发式 = 0.5）。
    禁 LLM/随机：同输入必须产出同分数，保证 BestBranchMixer 稳定排序与
    Evaluation 版本上下文可回放。
    """

    def _overlay_text(overlay: dict) -> str:
        parts: list[str] = []

        def walk(value: Any) -> None:
            if isinstance(value, str):
                parts.append(value)
            elif isinstance(value, dict):
                for v in value.values():
                    walk(v)
            elif isinstance(value, (list, tuple)):
                for v in value:
                    walk(v)

        walk(overlay)
        return "\n".join(parts)

    def _score_citation(overlay: dict, text: str) -> float:
        urls = len(re.findall(r"https?://[^\s\"']+", text))
        source_keys = sum(
            1
            for key in overlay
            if any(tok in str(key).lower() for tok in ("source", "citation", "reference", "来源", "引用"))
        )
        return round(min(1.0, urls * 0.4 + source_keys * 0.2), 3)

    def _score_cross_validation(overlay: dict) -> float:
        if not overlay:
            return 0.5
        keys = len(overlay)
        list_entries = sum(
            1 for v in overlay.values() if isinstance(v, (list, tuple)) and len(v) >= 2
        )
        return round(min(1.0, 0.2 + keys * 0.1 + list_entries * 0.2), 3)

    def _score_consistency(overlay: dict) -> float:
        if not overlay:
            return 0.5
        total = 0
        filled = 0
        for value in overlay.values():
            total += 1
            if isinstance(value, str):
                if value.strip():
                    filled += 1
            elif value:
                filled += 1
        return round(filled / total, 3)

    def _score_readability(text: str) -> float:
        if not text.strip():
            return 0.5
        sentences = max(1, len(re.findall(r"[。！？.!?]", text)))
        chars = len(text)
        avg = chars / sentences
        if avg <= 120:
            return round(max(0.3, 1.0 - avg / 200), 3)
        return round(max(0.3, 200 / avg), 3)

    def scorer(branch: Any, overlay: dict) -> dict[str, float]:
        text = _overlay_text(overlay)
        return {
            "citation_quality": _score_citation(overlay, text),
            "cross_validation": _score_cross_validation(overlay),
            "consistency": _score_consistency(overlay),
            "readability": _score_readability(text),
        }

    return scorer


def build_simulation_evaluator(review_data: dict[str, Any]) -> Any:
    """review.json → 推演分支评估器（WeightedScorerEvaluator + 确定性打分器）。

    供宿主注入 :class:`RunOptions.evaluator`：注入后节点返回 ``__simulate__``
    才可执行（此前 evaluator=None = 引擎显式拒绝）。引擎零改动。
    """
    from ink_engine.core.simulation import WeightedScorerEvaluator

    config = build_review_scoring_config(review_data)
    scorer = make_dimension_scorer()

    def bound_scorer(branch: Any, overlay: dict) -> dict[str, float]:
        names = tuple(dim.name for dim in config.dimensions)
        heuristic = scorer(branch, overlay)
        return {name: heuristic.get(name, 0.5) for name in names}

    return WeightedScorerEvaluator(
        config,
        dimension_scorer=bound_scorer,
        rule_version="seed.review.json",
        params_snapshot={
            "dimensions": [d.name for d in config.dimensions],
            "weights": {d.name: d.weight for d in config.dimensions},
            "pass_threshold": config.overall_threshold,
        },
    )


__all__ = [
    "build_review_scoring_config",
    "build_simulation_evaluator",
    "make_dimension_scorer",
]
