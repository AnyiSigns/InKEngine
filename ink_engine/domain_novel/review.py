"""小说场景评审-收敛原语。

自优化循环（"呈交前自动收敛"）：生成器产出发散候选 → 自动评审 → 不达标
自动再生成（不弹卡）→ 收敛后才呈交卡回路人类裁决。本模块提供：

- :class:`NovelReviewer`：LLM 驱动的正文评审器——按段落给质量分 + 整体
  改进意见 + 存疑事实声明（触发 web 验证）；
- :class:`NovelRegenerator`：按评审反馈改进单个候选（再生成 = 新补丁，
  非破坏性）；
- :func:`run_review_convergence`：多候选评审-收敛循环——评审 → 策略决策
  → 未达标再生成 → 再评审，直到收敛或达轮次上限（超限呈交现状 + 意见）。

容错语义（评审是 best-effort 增强，绝不阻断主流程）：
- 评审调用失败 / 结论解析失败 → 中性分（NEUTRAL_SCORE、passed=False），
  由收敛循环交卡回路人类裁决；
- 再生成失败 → 保留原候选（不丢内容）；
- web 验证失败 → 忽略（仅日志），验证结果是可选项。

LLM 依赖经构造参数注入（AsyncLLM / ModelChain / 任意带 ainvoke 的对象），
提示词可整体替换（复用的领域可覆盖默认模板）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

from ink_engine.core.review import (
    DEFAULT_PASS_THRESHOLD,
    NEUTRAL_SCORE,
    CandidateReview,
    ConvergencePolicy,
    ConvergenceResult,
    ConvergenceRound,
    MaxRoundsConvergencePolicy,
    ParagraphScore,
    Regenerator,
    Reviewer,
    WebVerifier,
)
from ink_engine.domain_novel.candidate_mix import split_paragraphs

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 护栏常量（防超长正文/超大输出撑爆上下文与解析）
# ---------------------------------------------------------------------------
# 单段评审字数上限（超长截断；中文 1 字 ≈ 1 token，800 字/段对多数小说段落充裕）
_MAX_PARAGRAPH_CHARS = 800

# 单候选最多评审段落数（长章只评审前 N 段，护栏防上下文爆炸）
_MAX_PARAGRAPHS = 40

# 存疑声明条数上限（web 验证成本护栏，超出丢弃并留痕）
_MAX_UNCERTAIN_CLAIMS = 10

# 反馈/理由长度截断（SSE 透传与日志的噪声控制）
_MAX_FEEDBACK_CHARS = 800
_MAX_REASON_CHARS = 200

# 评审输出中的存疑声明关键词（与模型输出约成的标记，供循环启发式定位）
_UNCERTAIN_HINT = "存疑"


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _score10_to01(value: float) -> float:
    """评审输出 1-10 分制 → 引擎 0-1 分制。"""
    return _clamp01(value / 10.0)


# ---------------------------------------------------------------------------
# LLM 评审/再生成提示词（默认模板，可按领域覆盖）
# ---------------------------------------------------------------------------

_DEFAULT_REVIEW_PROMPT = """你是小说创作质量评审。评审以下候选正文，正文已按段落编号列出。

评审维度：
1. 情节推进与节奏：是否有效推进情节线、承接上一章、无拖沓重复；
2. 人物一致性：言行举止是否符合该角色的性格设定；
3. 世界观一致性：设定/时间线/地点是否前后矛盾、是否存在上帝视角泄漏；
4. 文字质量：叙述流畅、用词精准。

【候选正文】
{paragraphs}

请只输出一个 JSON 对象（不要输出任何其它内容）：
{{"paragraphs": [{{"index": 0, "score": 8, "reason": "简短理由"}}, ...], "feedback": "整体改进意见", "uncertain_claims": ["存疑的事实陈述（没有则空数组）"]}}

规则：
- paragraphs 必须覆盖正文的每一个段落（index 从 0 起，与段落编号一致）；
- score 为 1-10 的整数（10 最高）；
- uncertain_claims 只列需要外部核实的硬事实（史实/地理/专有细节），纯创作内容不要列；
- 没有存疑事实时 uncertain_claims 必须是空数组。"""

_DEFAULT_REGENERATE_PROMPT = """你是小说创作修订者。根据评审反馈改进以下候选正文。
要求：保持既有设定与人物一致性，针对反馈逐条改进，直接输出改进后的完整正文——
不要任何解释前缀、不要引用原文、不要重复原文之外的说明。

【原正文】
{candidate}

【评审反馈】
{feedback}"""


# ---------------------------------------------------------------------------
# 评审结果解析（容错：LLM 输出不保证纯 JSON）
# ---------------------------------------------------------------------------


def _extract_json(text: str) -> dict | None:
    """从模型回答中提取 JSON 对象（正则取首个 {...} 块，解析失败返回 None）。"""
    if not text or not text.strip():
        return None
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def parse_review_output(
    candidate_index: int,
    text: str,
    *,
    threshold: float,
) -> CandidateReview:
    """把评审器模型输出解析为 CandidateReview（纯函数，可单测）。

    解析失败或字段缺失时返回中性分（fail-open：保守不通过，交卡回路裁决）。
    """
    data = _extract_json(text)
    if data is None:
        return CandidateReview(
            candidate_index=candidate_index,
            score=NEUTRAL_SCORE,
            passed=False,
            feedback="评审未能产出可解析结论，请人工审核",
        )

    paragraphs: list[ParagraphScore] = []
    scores: list[float] = []
    for item in data.get("paragraphs") or []:
        if not isinstance(item, dict):
            continue
        try:
            p_index = int(item.get("index", 0))
            p_score = _score10_to01(float(item.get("score", 0)))
        except (TypeError, ValueError):
            continue
        if p_index < 0 or p_score < 0:
            continue
        reason = str(item.get("reason") or "")[:_MAX_REASON_CHARS]
        paragraphs.append(
            ParagraphScore(candidate_index, p_index, round(p_score, 4), reason)
        )
        scores.append(p_score)

    score = (sum(scores) / len(scores)) if scores else NEUTRAL_SCORE
    feedback = str(data.get("feedback") or "")[:_MAX_FEEDBACK_CHARS]
    claims = tuple(
        str(claim).strip()
        for claim in (data.get("uncertain_claims") or [])[:_MAX_UNCERTAIN_CLAIMS]
        if str(claim).strip()
    )
    return CandidateReview(
        candidate_index=candidate_index,
        score=round(score, 4),
        passed=score >= threshold,
        feedback=feedback,
        paragraphs=tuple(paragraphs),
        uncertain_claims=claims,
    )


def _neutral_review(candidate_index: int, reason: str) -> CandidateReview:
    return CandidateReview(
        candidate_index=candidate_index,
        score=NEUTRAL_SCORE,
        passed=False,
        feedback=f"评审失败：{reason}",
    )


# ---------------------------------------------------------------------------
# 评审器 / 再生成器（LLM 依赖注入）
# ---------------------------------------------------------------------------


class NovelReviewer:
    """LLM 驱动的正文评审器：按段落评分 + 整体反馈 + 存疑声明。

    Args:
        llm: 任意支持 ``ainvoke(messages) -> LLMResult`` 的对象
            （AsyncLLM / ModelChain / 测试替身）。
        threshold: 通过阈值（0-1，默认取引擎 DEFAULT_PASS_THRESHOLD）。
        prompt: 评审提示词模板（覆盖默认模板；需含 ``{paragraphs}`` 占位）。
        max_paragraph_chars: 单段评审字数上限（护栏）。
        max_paragraphs: 单候选最多评审段落数（护栏）。
    """

    def __init__(
        self,
        llm: Any,
        *,
        threshold: float = DEFAULT_PASS_THRESHOLD,
        prompt: str | None = None,
        max_paragraph_chars: int = _MAX_PARAGRAPH_CHARS,
        max_paragraphs: int = _MAX_PARAGRAPHS,
    ) -> None:
        if not 0 <= threshold <= 1:
            raise ValueError(f"评审阈值必须在 [0, 1] 内: {threshold}")
        self._llm = llm
        self._threshold = threshold
        self._prompt = prompt or _DEFAULT_REVIEW_PROMPT
        self._max_paragraph_chars = max_paragraph_chars
        self._max_paragraphs = max_paragraphs

    async def review(
        self,
        candidates: list[str],
        *,
        context: dict[str, Any] | None = None,
    ) -> list[CandidateReview]:
        """逐候选评审（一次一候选：控制上下文预算，单候选失败不拖垮其余）。"""
        reviews: list[CandidateReview] = []
        for index, text in enumerate(candidates):
            reviews.append(await self._review_one(index, text, context))
        return reviews

    async def _review_one(
        self, index: int, text: str, context: dict[str, Any] | None
    ) -> CandidateReview:
        paragraphs = [
            p[: self._max_paragraph_chars]
            for p in split_paragraphs(text)[: self._max_paragraphs]
        ]
        if not paragraphs:
            return _neutral_review(index, "候选无有效正文段落")
        para_block = "\n\n".join(f"【段落 {i}】\n{p}" for i, p in enumerate(paragraphs))
        verifications = (context or {}).get("web_verifications") or []
        verif_block = (
            "\n\n【外部验证结果】（评审存疑声明的核实结论，供纠正判断）：\n"
            + "\n".join(str(v)[:_MAX_FEEDBACK_CHARS] for v in verifications)
            if verifications
            else ""
        )
        prompt = self._prompt.format(paragraphs=para_block) + verif_block
        from ink_engine.core.llm.messages import system, user

        try:
            result = await self._llm.ainvoke(
                [system(prompt), user("请评审并输出 JSON 结论。")]
            )
        except Exception as exc:
            logger.warning(f"[NovelReviewer] 候选[{index}] 评审调用失败: {exc}")
            return _neutral_review(index, "评审调用失败")
        text_out = getattr(result, "content", None)
        text_out = str(text_out or "")
        if not text_out.strip():
            return _neutral_review(index, "评审未产出内容")
        return parse_review_output(index, text_out, threshold=self._threshold)


class NovelRegenerator:
    """按评审反馈改进候选正文（再生成 = 新补丁，非破坏性可回退）。

    Args:
        llm: 任意支持 ``ainvoke(messages) -> LLMResult`` 的对象。
        prompt: 再生成提示词模板（需含 ``{candidate}`` / ``{feedback}`` 占位）。
        max_candidate_chars: 原正文送入提示词的截断上限（护栏）。
    """

    def __init__(
        self,
        llm: Any,
        *,
        prompt: str | None = None,
        max_candidate_chars: int = 6000,
    ) -> None:
        self._llm = llm
        self._prompt = prompt or _DEFAULT_REGENERATE_PROMPT
        self._max_candidate_chars = max_candidate_chars

    async def regenerate(
        self,
        candidate: str,
        feedback: str,
        *,
        context: dict[str, Any] | None = None,
    ) -> str:
        """按反馈改进候选；调用失败返回原文本（best-effort，不丢内容）。"""
        from ink_engine.core.llm.messages import system, user

        clipped = candidate[: self._max_candidate_chars]
        prompt = self._prompt.format(candidate=clipped, feedback=feedback)
        try:
            result = await self._llm.ainvoke(
                [system(prompt), user("请按反馈输出改进后的完整正文。")]
            )
        except Exception as exc:
            logger.warning(f"[NovelRegenerator] 再生成失败，保留原候选: {exc}")
            return candidate
        text = getattr(result, "content", None)
        text = str(text or "").strip()
        return text or candidate


# ---------------------------------------------------------------------------
# 评审-收敛循环
# ---------------------------------------------------------------------------


def _collect_uncertain_claims(reviews: list[CandidateReview]) -> list[str]:
    """汇总全部候选的存疑声明（去重保序，护栏内）。"""
    seen: set[str] = set()
    claims: list[str] = []
    for review in reviews:
        for claim in review.uncertain_claims:
            if claim and claim not in seen:
                seen.add(claim)
                claims.append(claim)
    return claims[:_MAX_UNCERTAIN_CLAIMS]


async def _verify_claim(
    web_verifier: WebVerifier,
    claim: str,
    context: dict[str, Any] | None,
):
    """一次存疑声明的验证（兼容带 verify 方法的对象与裸 callable 两种形态）。"""
    verifier = getattr(web_verifier, "verify", None)
    if callable(verifier):
        return await verifier(claim, context=context)
    return await web_verifier(claim, context=context)


async def _apply_web_verifications(
    reviews: list[CandidateReview],
    web_verifier: WebVerifier | None,
    context: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """评审存疑声明 → web 验证钩子（并发），结果注入下一轮评审上下文。

    best-effort：验证失败/无钩子/无声明时原样返回 context（不阻断循环）。
    """
    claims = _collect_uncertain_claims(reviews)
    if not claims or web_verifier is None:
        return context
    results = await asyncio.gather(
        *(_verify_claim(web_verifier, claim, context) for claim in claims),
        return_exceptions=True,
    )
    verified: list[str] = []
    for claim, result in zip(claims, results, strict=True):
        if isinstance(result, Exception):
            logger.warning(f"[web 验证] 声明失败（忽略）: {claim}: {result}")
            continue
        text = str(result or "").strip()
        if text:
            verified.append(f"声明：{claim}\n核实：{text[:_MAX_FEEDBACK_CHARS]}")
    if not verified:
        return context
    return {**(context or {}), "web_verifications": verified}


async def run_review_convergence(
    candidates: list[str],
    *,
    reviewer: Reviewer,
    regenerator: Regenerator,
    policy: ConvergencePolicy | None = None,
    web_verifier: WebVerifier | None = None,
    context: dict[str, Any] | None = None,
) -> ConvergenceResult:
    """多候选评审-收敛循环（发散候选 → 自动收敛 → 呈交前收敛）。

    循环语义（max_rounds 为自动再生成轮次上限）：
    - 评审当前候选集 → 策略决策；
    - 存在达标候选 → 收敛（接受最高分），结束；
    - 未达标且未超限 → 对策略选出的候选（Beam 宽度）按反馈再生成，
      原候选保留作兜底，进入下一轮；
    - 未达标且达上限 → 呈交现状 + 评审意见（卡回路人类裁决兜底）。

    任何评审/再生成异常均 fail-open：记入 notes 并回退，不抛出。
    """
    policy = policy or MaxRoundsConvergencePolicy()
    current = list(candidates)
    active_context = dict(context or {})
    notes: list[str] = []
    history: list[ConvergenceRound] = []
    round_no = 0

    while True:
        try:
            reviews = await reviewer.review(current, context=active_context)
        except Exception as exc:
            notes.append(f"评审失败，跳过自动收敛: {exc}")
            logger.warning(f"[评审-收敛] 评审器异常，回退原候选: {exc}")
            return ConvergenceResult(
                candidates=current,
                reviews=[],
                converged=False,
                rounds=round_no,
                notes=notes,
                history=history,
            )
        decision = policy.decide(reviews, round_no=round_no)
        history.append(
            ConvergenceRound(round_no=round_no, reviews=reviews, decision=decision)
        )
        notes.extend(decision.notes)

        if decision.converged:
            accepted = [current[i] for i in decision.accepted_indices]
            return ConvergenceResult(
                candidates=accepted,
                reviews=reviews,
                converged=True,
                rounds=round_no,
                notes=notes,
                history=history,
            )
        if not decision.regenerate_indices:
            # 超限（或策略判定不再再生成）：呈交现状 + 评审意见供人类裁决
            return ConvergenceResult(
                candidates=current,
                reviews=reviews,
                converged=False,
                rounds=round_no,
                notes=notes,
                history=history,
            )

        active_context = await _apply_web_verifications(
            reviews, web_verifier, active_context
        )

        next_candidates: list[str] = []
        regenerated: list[str] = []
        for index in decision.regenerate_indices:
            if index >= len(current):
                continue
            original = current[index]
            next_candidates.append(original)  # 原候选兜底（不丢内容）
            feedback = reviews[index].feedback or "整体质量未达标，请针对性改进"
            try:
                improved = await regenerator.regenerate(
                    original, feedback, context=active_context
                )
            except Exception as exc:
                logger.warning(f"[评审-收敛] 候选[{index}] 再生成失败: {exc}")
                improved = original
            if improved.strip() and improved != original:
                next_candidates.append(improved)
                regenerated.append(improved)

        if len(regenerated) == 0:
            notes.append("再生成未产出改进，提前呈交现状")
            return ConvergenceResult(
                candidates=next_candidates,
                reviews=reviews,
                converged=False,
                rounds=round_no,
                notes=notes,
                history=history,
            )
        history[-1].regenerated = tuple(regenerated)
        current = next_candidates
        round_no += 1


__all__ = [
    "NovelRegenerator",
    "NovelReviewer",
    "parse_review_output",
    "run_review_convergence",
]
