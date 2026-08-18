"""测试时专才化评审-收敛原语（评审器接口 / 收敛策略 / 轮次上限 / web 验证钩子）。

测试时专才化（Test-time Specialization）：不微调权重，靠「生成 → 评审 →
校验 → 迭代收敛」把输出质量逼近专才水平。奖励信号三源：评审器质量评分、
一致性校验（校验层）、卡回路人类反馈（accept/reject/edit——最真实奖励，
弹卡即收集偏好数据）。

本模块只定义**机制**（接口 + 数据类 + 默认策略），不绑定任何领域语义：

- :class:`Reviewer`：评审器接口（对候选输出给质量分 / 段落级评分 / 改进意见）；
- :class:`Regenerator`：再生成器接口（按评审反馈改进一个候选，不达标自动
  再生成，不弹卡）；
- :class:`WebVerifier`：web 验证钩子接口（评审发现事实存疑时验证，结果喂回
  下一轮评审）；
- :class:`ConvergencePolicy`：收敛策略接口（何时收敛 / 何时再生成哪个候选）；
- :class:`MaxRoundsConvergencePolicy`：默认策略（达阈值收敛 + Beam 宽度 +
  轮次上限）。

领域语义（评审 prompt、候选混合）在 novel_harness 包实现，
宿主只负责注册与装配——换评审策略 / 换验证后端不改本模块。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

# 自动再生成轮次上限（2-3 轮；超限呈交现状 + 评审意见，卡回路人类裁决兜底）
DEFAULT_MAX_ROUNDS = 2

# 评审通过阈值（0-1 质量分；评审器自身也用它判定 passed）
DEFAULT_PASS_THRESHOLD = 0.75

# 未收敛时继续再生成的候选数（Beam 宽度：取前 K 个最优候选迭代）
DEFAULT_BEAM_WIDTH = 1

# 评审未产出结论时的中性分（fail-open：保守不通过，交卡回路人类裁决）
NEUTRAL_SCORE = 0.5


@dataclass(frozen=True, slots=True)
class ParagraphScore:
    """单个段落的质量评分（段落级混合的输入，混合逐段位取最高分）。

    Attributes:
        candidate_index: 所属候选下标。
        paragraph_index: 段内段落序号（0 起，与 split_paragraphs 对齐）。
        score: 归一化质量分（0-1）。
        reason: 评分理由（可读留痕）。
    """

    candidate_index: int
    paragraph_index: int
    score: float
    reason: str = ""


@dataclass(frozen=True, slots=True)
class CandidateReview:
    """单个候选的一次评审结果。

    Attributes:
        candidate_index: 候选下标。
        score: 候选整体质量分（0-1，通常为段落分均值）。
        passed: 是否达到收敛标准（score >= 阈值）。
        feedback: 改进意见（再生成指导）。
        paragraphs: 段落级评分（混合用；评审器未产出时为空）。
        uncertain_claims: 评审发现的存疑事实声明（触发 web 验证）。
    """

    candidate_index: int
    score: float
    passed: bool
    feedback: str = ""
    paragraphs: tuple[ParagraphScore, ...] = ()
    uncertain_claims: tuple[str, ...] = ()


@runtime_checkable
class Reviewer(Protocol):
    """评审器接口：对候选输出进行质量评审。

    实现约定：
    - 返回与 ``candidates`` 一一对应的评审结果（按下标对齐）；
    - 评审失败不得抛错——应返回中性分（NEUTRAL_SCORE、passed=False）或
      由循环层兜底，评审是 best-effort 增强，不得阻断主流程。
    """

    async def review(
        self,
        candidates: list[str],
        *,
        context: dict[str, Any] | None = None,
    ) -> list[CandidateReview]: ...


@runtime_checkable
class Regenerator(Protocol):
    """再生成器接口：按评审反馈改进单个候选（不达标自动再生成，不弹卡）。"""

    async def regenerate(
        self,
        candidate: str,
        feedback: str,
        *,
        context: dict[str, Any] | None = None,
    ) -> str: ...


@runtime_checkable
class WebVerifier(Protocol):
    """web 验证钩子接口：评审存疑时验证事实（宿主注册博查等实现）。

    实现约定：对单个存疑声明返回验证结果文本；返回 None 表示无需/无法验证。
    """

    async def verify(
        self,
        claim: str,
        *,
        context: dict[str, Any] | None = None,
    ) -> str | None: ...


@dataclass(frozen=True, slots=True)
class ConvergenceDecision:
    """收敛策略的一轮决策结果。

    Attributes:
        converged: 是否收敛（满足通过条件，停止迭代）。
        accepted_indices: 收敛时被接受的候选下标（按分降序，取最高分）。
        regenerate_indices: 未收敛时下一轮继续再生成的候选下标（Beam 宽度）。
        notes: 决策留痕（可读说明，如「第 2 轮仍不达标」）。
    """

    converged: bool
    accepted_indices: tuple[int, ...] = ()
    regenerate_indices: tuple[int, ...] = ()
    notes: tuple[str, ...] = ()


class ConvergencePolicy(Protocol):
    """收敛策略接口：由评审结果决定「收敛 or 再生成哪个候选」。

    语义拆分（确定性策略 vs 引擎机制）：
    - 何时收敛 / 再生成几个 = 策略决策（业务可替换）；
    - 再生成 → 评审 → 再决策 = 循环机制（引擎统一实现）。
    """

    def decide(
        self,
        reviews: list[CandidateReview],
        *,
        round_no: int,
    ) -> ConvergenceDecision: ...


class MaxRoundsConvergencePolicy:
    """默认收敛策略：达阈值即收敛，否则 Beam 再生成，直到轮次上限。

    规则：
    1. 存在 passed 的候选 → 收敛，接受其中分数最高者（同分取靠前者）；
    2. 未收敛但已到轮次上限 → 停止（converged=False，呈交现状 + 评审意见）；
    3. 否则取分数前 K（Beam 宽度）个候选继续再生成。
    """

    def __init__(
        self,
        *,
        threshold: float = DEFAULT_PASS_THRESHOLD,
        beam: int = DEFAULT_BEAM_WIDTH,
        max_rounds: int = DEFAULT_MAX_ROUNDS,
    ) -> None:
        if threshold < 0 or threshold > 1:
            raise ValueError(f"评审阈值必须在 [0, 1] 内: {threshold}")
        if beam < 1:
            raise ValueError(f"Beam 宽度必须为正: {beam}")
        if max_rounds < 0:
            raise ValueError(f"轮次上限不能为负: {max_rounds}")
        self.threshold = threshold
        self.beam = beam
        self.max_rounds = max_rounds

    def decide(self, reviews: list[CandidateReview], *, round_no: int) -> ConvergenceDecision:
        if not reviews:
            return ConvergenceDecision(converged=True, notes=("无候选可评审",))
        passed = [r for r in reviews if r.passed]
        if passed:
            best = max(passed, key=lambda r: r.score)
            return ConvergenceDecision(
                converged=True,
                accepted_indices=(best.candidate_index,),
                notes=(f"候选[{best.candidate_index}] 达标（{best.score:.2f}），收敛",),
            )
        if round_no >= self.max_rounds:
            best = max(reviews, key=lambda r: r.score)
            return ConvergenceDecision(
                converged=False,
                regenerate_indices=(),
                notes=(
                    f"达轮次上限（{round_no}/{self.max_rounds}），"
                    f"呈交现状，最优候选[{best.candidate_index}] 得分 {best.score:.2f}",
                ),
            )
        ranked = sorted(reviews, key=lambda r: r.score, reverse=True)
        picks = [r.candidate_index for r in ranked[: self.beam]]
        return ConvergenceDecision(
            converged=False,
            regenerate_indices=tuple(picks),
            notes=(f"第 {round_no + 1} 轮未达标，再生成候选 {picks}",),
        )


@dataclass(slots=True)
class ConvergenceRound:
    """一轮评审-再生成的完整留痕（循环历史可审计）。"""

    round_no: int
    reviews: list[CandidateReview]
    decision: ConvergenceDecision
    regenerated: tuple[str, ...] = ()


@dataclass(slots=True)
class ConvergenceResult:
    """评审-收敛循环的最终结果。

    Attributes:
        candidates: 收敛候选（converged=True 时为接受的候选）或最终候选集
            （超限时呈交现状，含评审意见供人类裁决）。
        reviews: 最后一轮评审结果。
        converged: 是否自动收敛（否则已超限，交卡回路人类裁决）。
        rounds: 实际执行的再生成轮数。
        notes: 全程留痕（失败回退 / 轮次记录等）。
        history: 每轮评审-再生成明细。
    """

    candidates: list[str]
    reviews: list[CandidateReview]
    converged: bool
    rounds: int
    notes: list[str] = field(default_factory=list)
    history: list[ConvergenceRound] = field(default_factory=list)

    @property
    def best_index(self) -> int:
        """当前候选集中得分最高者下标（reviews 空时取 0）。"""
        if not self.reviews:
            return 0
        return max(self.reviews, key=lambda r: r.score).candidate_index


__all__ = [
    "DEFAULT_BEAM_WIDTH",
    "DEFAULT_MAX_ROUNDS",
    "DEFAULT_PASS_THRESHOLD",
    "NEUTRAL_SCORE",
    "CandidateReview",
    "ConvergenceDecision",
    "ConvergencePolicy",
    "ConvergenceResult",
    "ConvergenceRound",
    "MaxRoundsConvergencePolicy",
    "ParagraphScore",
    "Regenerator",
    "Reviewer",
    "WebVerifier",
]
