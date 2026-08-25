"""推演评估装配：review.json 打分配置 → 确定性维度打分器 + 评估器。

评审/推演共用的打分语义（设计文档第六节模块 M3 执行域装配）：
- review.json 声明维度与权重（citation_quality/cross_validation/
  consistency/readability）与通过阈值；
- samples.json 顶层 facts = 评分交叉验证锚点：分支携带的事实命中数
  参与 cross_validation 维度打分（数据驱动，不写死打分逻辑）；
- 维度得分确定性由分支状态携带（state 内 ``score:<维度名>``），
  缺省中性分——stub LLM 离线评测可完全复现。
"""
from __future__ import annotations

from typing import Any

from ink_engine.core.scoring import ScoreDimension, ScoringConfig
from ink_engine.core.simulation import WeightedScorerEvaluator


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


def dimension_scorer_with_facts(
    facts: list[str],
    config: ScoringConfig,
) -> Any:
    """事实锚点维度打分器：分支状态驱动 + 交叉验证锚点。

    每个分支（SimulateSpec.state）可携带：
    - ``score:<维度名>``：该维度的确定性得分（0-1）；
    - ``facts_hit``：与基准事实重合的断言数——cross_validation
      维度按命中率打分（未携带 = 中性分）。
    产出覆盖配置的全部维度（WeightedScorer 对缺维度 fail-fast）。
    契约为同步调用（DimensionScorer = Callable[[SimulateSpec, dict],
    dict]），评估器不做 await。
    """
    names = tuple(dim.name for dim in config.dimensions)
    facts_len = max(len(facts), 1)

    def scorer(spec: Any, overlay: dict[str, Any]) -> dict[str, float]:
        state = spec.state or {}
        scores = {name: float(state.get(f"score:{name}", 0.5)) for name in names}
        if "cross_validation" in scores and "facts_hit" in state:
            hit = int(state["facts_hit"])
            scores["cross_validation"] = min(hit / facts_len, 1.0)
        return scores

    return scorer


def build_review_scorer(
    review_data: dict[str, Any],
    facts: list[str],
    *,
    scorer: Any = None,
) -> WeightedScorerEvaluator:
    """review.json + samples.json facts → 分支评估器（WeightedScorerEvaluator）。"""
    config = build_review_scoring_config(review_data)
    return WeightedScorerEvaluator(
        config,
        dimension_scorer=scorer or dimension_scorer_with_facts(facts, config),
    )


__all__ = [
    "build_review_scorer",
    "build_review_scoring_config",
    "dimension_scorer_with_facts",
]
