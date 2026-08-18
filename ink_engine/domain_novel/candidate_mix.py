"""候选段落级混合原语（D2 平行创作进阶：跨候选取段落组装）。

发散-收敛从「单选」升级为「混合收敛」：评审器对多个候选按段落粒度评分
（``CandidateReview.paragraphs``），本原语逐段位取最高分段落拼接成混合稿
——挑变体 A 的开头 + 变体 B 的结尾，合并各自最优段。

交互形态：自动评分混合——混合稿作为新候选卡内容走既有 L2 用户确认
（前端零改动；候选卡 UI 的段落级勾选/拖选不在本原语内）。

设计要点：
- **段落对齐**：以段位 k（各候选的第 k 段）为对齐单位——同一写作请求的
  多个候选段落数接近，按序对齐是合理近似；段落数不同的候选在缺段位时
  自然跳过（该段位取其余候选最高分）；
- **来源留痕**：混合稿每段记录来源（候选 + 段位），审计可回溯「这段出自
  哪个变体」，也支撑后续的段落级修订原语；
- **纯函数无副作用**：输入候选 + 评审结果，输出混合稿或 None（无法混合时
  由调用方回退原候选集）。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ink_engine.core.review import CandidateReview

# 段落切分的分段分隔符（正文按空行分段的常规语义；单换行不视为分段，
# 避免把同一自然段的折行拆开）
_PARA_SEPARATOR = "\n\n"


def split_paragraphs(text: str) -> list[str]:
    """正文按空行切分段落：去首尾空白、去空段与纯空白段。

    段落序号 = 返回列表下标（0 起），与 ``ParagraphScore.paragraph_index``
    对齐——评审器与混合原语共用同一切分实现，防止分段规则漂移。
    """
    if not text:
        return []
    paragraphs: list[str] = []
    for block in text.split(_PARA_SEPARATOR):
        stripped = block.strip()
        if stripped:
            paragraphs.append(stripped)
    return paragraphs


@dataclass(frozen=True, slots=True)
class ParagraphSource:
    """混合稿中一段的来源（审计留痕）。

    Attributes:
        candidate_index: 该段取自哪个候选。
        paragraph_index: 该段在来源候选中的段位（0 起）。
    """

    candidate_index: int
    paragraph_index: int


@dataclass(slots=True)
class MixedCandidate:
    """混合稿：逐段位最高分段落拼接结果 + 每段来源。

    Attributes:
        text: 混合后的完整正文（段落间以空行分隔，与原切分逆变换）。
        sources: 与 text 段落一一对应的来源记录。
        score: 混合稿质量分（各段落得分的均值，评审器无段落分时取 0.0）。
    """

    text: str
    sources: list[ParagraphSource] = field(default_factory=list)
    score: float = 0.0


def _reviews_by_candidate(reviews: list[CandidateReview]) -> dict[int, CandidateReview]:
    """评审结果按下标建索引（缺失项忽略——评审与候选下标需严格对齐）。"""
    return {r.candidate_index: r for r in reviews if r.candidate_index >= 0}


def _paragraph_score(review: CandidateReview | None, slot: int) -> float | None:
    """候选在段位 slot 的评分（缺段落级数据返回 None——不参与择优）。"""
    if review is None:
        return None
    for ps in review.paragraphs:
        if ps.paragraph_index == slot:
            return ps.score
    return None


def _best_for_slot(
    split: list[list[str]],
    by_candidate: dict[int, CandidateReview],
    slot: int,
) -> tuple[str, ParagraphSource, float] | None:
    """段位 slot 的最优段落：存在该段且**有段落级评分**的候选中得分最高者。

    无段落级评分的候选不参与段位竞争（评审未提供数据无法择优，保守弃权）；
    该段位无任何候选提供评分时退回首个候选的段落（0 分，保证内容不丢）。
    """
    present = [i for i, paragraphs in enumerate(split) if slot < len(paragraphs)]
    if not present:
        return None
    scored = [
        (score, index)
        for index in present
        if (score := _paragraph_score(by_candidate.get(index), slot)) is not None
    ]
    if scored:
        best_score, best_index = max(scored)
    else:
        best_index = present[0]
        best_score = 0.0
    return (
        split[best_index][slot],
        ParagraphSource(candidate_index=best_index, paragraph_index=slot),
        best_score,
    )


def build_mixed_candidate(
    candidates: list[str],
    reviews: list[CandidateReview],
    *,
    min_paragraph_score: float = 0.0,
) -> MixedCandidate | None:
    """跨候选取段落组装混合稿（纯函数）。

    段位 k 的段落来自各候选的第 k 段中得分最高者；段位从 0 起逐位推进，
    直到所有候选的段落耗尽（混合稿段数 = 各候选段落数的最大值）。

    Args:
        candidates: 候选正文列表（与评审下标对齐）。
        reviews: 评审结果（含段落级评分；可缺部分候选，缺者不参与择优）。
        min_paragraph_score: 段落最低得分门槛；低于门槛的段落整体丢弃
            （默认 0 不过滤——丢段会破坏正文连贯，由调用方显式开启）。

    Returns:
        混合稿；候选不足 2 个 / 全部段落为空 / 无任何可拼段落时返回 None
        （调用方回退原候选集，不产出空混合稿）。
    """
    if len(candidates) < 2 or not reviews:
        return None
    by_candidate = _reviews_by_candidate(reviews)
    # 候选与评审下标严格对齐校验：任一候选缺评审即拒绝混合（防错位拼接）
    if any(i not in by_candidate for i in range(len(candidates))):
        return None

    split = [split_paragraphs(text) for text in candidates]
    parts: list[str] = []
    sources: list[ParagraphSource] = []
    scores: list[float] = []
    slot = 0
    while True:
        pick = _best_for_slot(split, by_candidate, slot)
        if pick is None:
            break
        text, source, score = pick
        if score >= min_paragraph_score:
            parts.append(text)
            sources.append(source)
            scores.append(score)
        slot += 1

    if not parts:
        return None
    return MixedCandidate(
        text=_PARA_SEPARATOR.join(parts),
        sources=sources,
        score=round(sum(scores) / len(scores), 4),
    )


__all__ = [
    "MixedCandidate",
    "ParagraphSource",
    "build_mixed_candidate",
    "split_paragraphs",
]
