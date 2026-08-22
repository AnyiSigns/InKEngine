"""评审-收敛管线（引擎 core.review 机制的产品化接线）。

review.json（维度/阈值/轮次/Beam/中性分/验证钩子）数据驱动；评审器与
再生成器为 LLM 实现（host 注入模型链），失败一律 fail-open 中性分——
评审是 best-effort 增强，不阻断主流程（不达标交闸门/人工裁决）。

实现约定：
- LLMReviewer：逐候选评审（dimensions 权重注入提示），返回引擎
  CandidateReview；LLM 异常 → 中性分（passed=False，不抛错）；
- LLMRegenerator：按评审反馈改进单个候选（不达标自动再生成）；
- converge_candidates：评审 → 收敛决策 → 再生成循环（MaxRounds
  ConvergencePolicy 硬护栏），历史可审计（ConvergenceResult）。
"""
from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from ink_engine.core.llm.messages import user
from ink_engine.core.review import (
    DEFAULT_MAX_ROUNDS,
    DEFAULT_PASS_THRESHOLD,
    NEUTRAL_SCORE,
    CandidateReview,
    ConvergenceDecision,
    ConvergenceResult,
    ConvergenceRound,
    MaxRoundsConvergencePolicy,
    ParagraphScore,
)

# 评审提示（维度/要求注入后拼到候选文稿后）
_REVIEW_PROMPT = (
    "你是评审器。按下列维度给候选文稿打质量分（每维 0-1，总分 0-1 加权）：\n"
    "{dimensions}\n"
    "要求：输出严格 JSON，格式：\n"
    '{{"score": <0-1 数值>, "reason": "<一句话理由>", '
    '"paragraphs": [{{"index": 0, "score": 0.8, "reason": "..."}}], '
    '"uncertain_claims": ["<存疑声明>", ...]}}\n'
    "候选文稿：\n{content}\n"
)

# 再生成提示（原候选 + 反馈 → 改进稿）
_REGENERATE_PROMPT = (
    "根据评审反馈改进候选文稿。只输出改进后的文稿本体：\n\n"
    "原稿：\n{content}\n\n评审反馈：\n{feedback}\n"
)

# 评审 JSON 捕获（LLM 可能包夹 ```json 围栏）
_JSON_RE = ("```json", "```")


def _extract_json(text: str) -> dict[str, Any]:
    """从 LLM 输出提取评审 JSON（剥围栏；失败抛 ValueError）。"""
    cleaned = (text or "").strip()
    for fence in _JSON_RE:
        cleaned = cleaned.replace(fence, "")
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("评审输出无可解析 JSON")
    return json.loads(cleaned[start : end + 1])


def _dimension_lines(dimensions: list[dict[str, Any]] | None) -> str:
    """维度清单渲染（name/weight/note → 提示行）。"""
    dims = dimensions or []
    if not dims:
        return "- 统一质量（0-1）：准确性、可读性、可复用性"
    return "\n".join(
        f"- {d.get('name', 'dim')}（权重 {float(d.get('weight', 1.0)):.2f}）："
        f"{d.get('note', '')}"
        for d in dims
        if isinstance(d, dict)
    )


class LLMReviewer:
    """LLM 评审器（评审失败 → 中性分 passed=False，不抛错）。"""

    def __init__(
        self,
        llm: Any,
        *,
        dimensions: list[dict[str, Any]] | None = None,
        pass_threshold: float = DEFAULT_PASS_THRESHOLD,
        neutral: float = NEUTRAL_SCORE,
    ) -> None:
        self._llm = llm
        self._dimensions = dimensions
        self.pass_threshold = pass_threshold
        self.neutral = neutral

    async def review(
        self,
        candidates: list[str],
        *,
        context: dict[str, Any] | None = None,
    ) -> list[CandidateReview]:
        results: list[CandidateReview] = []
        for index, content in enumerate(candidates):
            prompt = _REVIEW_PROMPT.format(
                dimensions=_dimension_lines(self._dimensions), content=content
            )
            obj: dict[str, Any] | None = None
            try:
                reply = await self._llm.ainvoke(
                    [user(prompt)], tools=None, params=None
                )
                obj = _extract_json(str(reply.content or ""))
                score = float(obj.get("score", self.neutral))
                paragraphs = tuple(
                    ParagraphScore(
                        candidate_index=index,
                        paragraph_index=int(p.get("index", 0)),
                        score=float(p.get("score", 0.0)),
                        reason=str(p.get("reason", "")),
                    )
                    for p in obj.get("paragraphs") or []
                    if isinstance(p, dict)
                )
                uncertain = tuple(
                    str(c) for c in obj.get("uncertain_claims") or [] if c
                )
            except Exception:
                score, paragraphs, uncertain = self.neutral, (), ()
            clamped = min(max(score, 0.0), 1.0)
            results.append(
                CandidateReview(
                    candidate_index=index,
                    score=clamped,
                    passed=clamped >= self.pass_threshold,
                    feedback=str(obj.get("reason", "")) if obj else "",
                    paragraphs=paragraphs,
                    uncertain_claims=uncertain,
                )
            )
        return results


class LLMRegenerator:
    """再生成器（按评审反馈改进；失败返回原稿——不降级）。"""

    def __init__(self, llm: Any) -> None:
        self._llm = llm

    async def regenerate(
        self,
        candidate: str,
        feedback: str,
        *,
        context: dict[str, Any] | None = None,
    ) -> str:
        prompt = _REGENERATE_PROMPT.format(content=candidate, feedback=feedback)
        try:
            reply = await self._llm.ainvoke(
                [user(prompt)], tools=None, params=None
            )
            text = str(reply.content or "").strip()
            return text if text else candidate
        except Exception:
            return candidate


async def converge_candidates(
    llm: Any,
    review_data: dict[str, Any],
    candidates: list[str],
    *,
    dimensions: list[dict[str, Any]] | None = None,
    context: dict[str, Any] | None = None,
    tier: str = "main",
    on_llm_call: Callable[[str], None] | None = None,
) -> ConvergenceResult:
    """评审 → 收敛决策 → 再生成循环（引擎策略硬护栏；历史可审计）。

    Args:
        llm: 模型实例（None = 无评审器，返回中性分一轮结果 fail-open）。
        review_data: review.json（pass_threshold/max_rounds/beam_width/
            neutral_score/dimensions）。
        candidates: 候选文稿清单。
        tier: 本次 LLM 调用归因挡位（TierCallStats 记录）。
        on_llm_call: 挡位调用统计钩子（回合级观测 llm_calls_by_tier）。
    """
    pass_threshold = float(review_data.get("pass_threshold", DEFAULT_PASS_THRESHOLD))
    max_rounds = int(review_data.get("max_rounds", DEFAULT_MAX_ROUNDS))
    beam = int(review_data.get("beam_width", 1))
    neutral = float(review_data.get("neutral_score", NEUTRAL_SCORE))

    def _record() -> None:
        if on_llm_call is not None:
            on_llm_call(tier)

    policy = MaxRoundsConvergencePolicy(
        threshold=pass_threshold, beam=beam, max_rounds=max_rounds
    )
    candidates = list(candidates)
    history: list[ConvergenceRound] = []
    notes: list[str] = []
    rounds = 0
    while True:
        _record()
        reviews = await LLMReviewer(
            llm,
            dimensions=dimensions,
            pass_threshold=pass_threshold,
            neutral=neutral,
        ).review(candidates, context=context)
        decision: ConvergenceDecision = policy.decide(reviews, round_no=rounds)
        round_record = ConvergenceRound(
            round_no=rounds, reviews=reviews, decision=decision
        )
        if decision.converged:
            notes.extend(decision.notes)
            history.append(round_record)
            return ConvergenceResult(
                candidates=candidates,
                reviews=reviews,
                converged=True,
                rounds=rounds,
                notes=notes,
                history=history,
            )
        indices = decision.regenerate_indices
        if not indices or rounds >= max_rounds:
            notes.extend(decision.notes)
            history.append(round_record)
            return ConvergenceResult(
                candidates=candidates,
                reviews=reviews,
                converged=False,
                rounds=rounds,
                notes=notes,
                history=history,
            )
        _record()
        regenerator = LLMRegenerator(llm)
        regenerated: list[str] = []
        for index in indices:
            candidate = candidates[index]
            feedback = (
                reviews[index].feedback if index < len(reviews) else ""
            )
            regenerated.append(await regenerator.regenerate(candidate, feedback, context=context))
        round_record.regenerated = tuple(regenerated)
        history.append(round_record)
        for index, text in zip(indices, regenerated):
            candidates[index] = text
        rounds += 1


def build_review_pipeline(
    llm: Any,
    review_data: dict[str, Any] | None = None,
    *,
    tier: str = "main",
    on_llm_call: Callable[[str], None] | None = None,
) -> Callable[[list[str], dict[str, Any] | None], Any] | None:
    """评审管线构建：模型缺省 → None（调用方按无评审处理）。

    返回 bound 协程包装（converge candidates），宿主直接调用。
    """
    if llm is None:
        return None
    data = review_data or {}

    async def pipeline(
        candidates: list[str],
        context: dict[str, Any] | None = None,
    ) -> ConvergenceResult:
        return await converge_candidates(
            llm,
            data,
            candidates,
            dimensions=data.get("dimensions") or [],
            context=context,
            tier=tier,
            on_llm_call=on_llm_call,
        )

    return pipeline


__all__ = [
    "LLMRegenerator",
    "LLMReviewer",
    "build_review_pipeline",
    "converge_candidates",
]
