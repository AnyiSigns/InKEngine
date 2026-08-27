"""测试时专才化评审-收敛原语（评审器接口 / 确定性基线实现 / 收敛策略 / web 验证钩子）。

测试时专才化（Test-time Specialization）：不微调权重，靠「生成 → 评审 →
校验 → 迭代收敛」把输出质量逼近专才水平。奖励信号三源：评审器质量评分、
一致性校验（校验层）、卡回路人类反馈（accept/reject/edit——最真实奖励，
弹卡即收集偏好数据）。

本模块定义**机制**（接口 + 数据类 + 默认策略）与**确定性基线参考实现**，
不绑定任何领域语义：

- :class:`Reviewer` / :class:`Regenerator` / :class:`WebVerifier`：协议接口
  （对候选给质量分 / 按反馈改进候选 / 存疑声明验证）；
- :class:`DeterministicReviewer` / :class:`DeterministicRegenerator` /
  :class:`DeterministicWebVerifier`：**确定性基线参考实现**（E-P11 拍板）——
  纯启发式、无随机 / 无 LLM / 无 IO，同输入产出恒等，作为 LLM 评审的
  回归基线（对比测试锚定输出，断言不漂移）；
- :class:`ConvergencePolicy`：收敛策略接口（何时收敛 / 何时再生成哪个候选）；
- :class:`MaxRoundsConvergencePolicy`：默认策略（达阈值收敛 + Beam 宽度 +
  轮次上限）。

双轨收敛（E-P11 拍板，2026-08-26）：**产品 LLM 评审权威实现**在宿主层
（``inkling_host/review_pipeline.py`` 的 LLMReviewer / LLMRegenerator，
host 注入模型链，评审失败 fail-open 中性分）；core 侧不再承载 LLM 评审
实现，只提供协议接口与确定性基线参考实现——换评审策略 / 换验证后端
不改本模块，LLM 评审行为漂移时基线给出稳定参照。
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

    # passed 语义：评审器按自身阈值（pass_threshold）预计算的达标标志，
    # 仅供留痕/展示——收敛判定以策略 threshold 为唯一门槛（ENG1-19），
    # 不把两者叠加成双重门槛。


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
class DeterministicReviewer:
    """确定性基线评审器（E-P11 回归基线参考实现，非产品权威实现）。

    双轨收敛：产品 LLM 评审权威实现 = ``inkling_host/review_pipeline.py``
    的 :class:`LLMReviewer`；本类 = core 侧**确定性基线**——纯启发式
    质量分（长度 + 段落结构），无随机 / 无 LLM / 无 IO，同输入产出恒等
    （对比测试断言不漂移），作为 LLM 评审的回归基线：LLM 评审行为漂移时
    基线给出稳定参照，同输入断言不漂移的锚定点。

    实现约定：与 :class:`Reviewer` 协议对齐（按下标一一对应返回；
    评审不抛错——纯函数恒产出有效分）。

    Attributes:
        pass_threshold: 判定通过的质量分阈值（与引擎默认同源 0.75）。
        neutral: 中性分（保留协议语义；确定性评审永不失败，恒产出实分）。
    """

    pass_threshold: float = DEFAULT_PASS_THRESHOLD
    neutral: float = NEUTRAL_SCORE

    async def review(
        self,
        candidates: list[str],
        *,
        context: dict[str, Any] | None = None,
    ) -> list[CandidateReview]:
        results: list[CandidateReview] = []
        for index, content in enumerate(candidates):
            score, reason = self._score(text=content or "")
            results.append(
                CandidateReview(
                    candidate_index=index,
                    score=score,
                    passed=score >= self.pass_threshold,
                    feedback=reason,
                )
            )
        return results

    def _score(self, *, text: str) -> tuple[float, str]:
        """确定性质量分（纯函数）：长度分 60% + 段落结构分 40%，锚定 [0,1]。

        长度分 = min(len/500, 1)；结构分 = min(换行数/4, 1)。分数四舍五入
        到 4 位小数——同输入恒等，作为回归基线的断言锚点。
        """
        length_score = min(len(text) / 500.0, 1.0)
        structure_score = min(text.count("\n") / 4.0, 1.0)
        score = round(0.6 * length_score + 0.4 * structure_score, 4)
        reason = f"确定性基线：长度分 {length_score:.2f}，结构分 {structure_score:.2f}"
        return score, reason


@dataclass(frozen=True, slots=True)
class DeterministicRegenerator:
    """确定性基线再生成器（E-P11 回归基线参考实现，非产品权威实现）。

    产品权威实现 = ``inkling_host/review_pipeline.py`` 的
    :class:`LLMRegenerator`；本类按评审反馈**追加修订段**（无随机 / 无
    LLM / 无 IO），同输入产出恒等，作为再生成路径的回归基线。
    """

    async def regenerate(
        self,
        candidate: str,
        feedback: str,
        *,
        context: dict[str, Any] | None = None,
    ) -> str:
        if not feedback or not feedback.strip():
            return candidate
        return f"{candidate}\n\n【确定性基线修订】{feedback.strip()}"


@dataclass(frozen=True, slots=True)
class DeterministicWebVerifier:
    """确定性基线 web 验证器（E-P11 回归基线参考实现）。

    返回占位结论（不触发真实联网验证），同输入产出恒等——验证路径的
    回归基线；真实验证后端由宿主注册（协议 :class:`WebVerifier`）。
    """

    async def verify(
        self,
        claim: str,
        *,
        context: dict[str, Any] | None = None,
    ) -> str:
        return f"【确定性基线验证】{claim}（未触发真实联网验证，占位结论）"


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
    1. 存在分数 ≥ 策略 threshold 的候选 → 收敛，接受其中分数最高者
       （同分取靠前者）——threshold 是唯一收敛门槛（ENG1-19）；
    2. 未收敛但已到轮次上限 → 停止（converged=False，呈交现状 + 评审意见）；
    3. 否则取分数前 K（Beam 宽度）个候选继续再生成。

    轮次上限硬护栏：策略内部自增轮次计数，decide 按
    ``max(round_no, 已用轮次)`` 判定上限——循环驱动层误传常量（如恒 0）
    时仍有绝对硬上限兜底，不会无限再生成。
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
        self._rounds_used = 0

    def _effective_round(self, round_no: int) -> int:
        """有效轮次 = 调用方轮次与内部计数的较大者（内部计数单调自增）。

        调用方按轮递增时二者一致；调用方误传常量/回退轮次时内部计数
        保证硬上限语义（已用轮次不受调用方回拨影响）。
        """
        self._rounds_used = max(self._rounds_used, round_no)
        return self._rounds_used

    def decide(self, reviews: list[CandidateReview], *, round_no: int) -> ConvergenceDecision:
        round_no = self._effective_round(round_no)
        if not reviews:
            # 空评审集 = 无候选可判定，收敛失败（与评审器异常分支同语义：
            # 呈交现状，绝不把空集当「已收敛」——调用方按 converged 取
            # candidates[0] 会拿到空集崩溃）
            return ConvergenceDecision(
                converged=False, notes=("无候选可评审",)
            )
        # 单一阈值源（ENG1-19）：收敛判定只认策略 threshold——评审器的
        # passed 标志（自身阈值预计算）不再作为第二道门槛。双重门槛
        # （评审器 0.75 判 passed + 策略收紧 0.9）会让「达标但低于策略
        # 门槛」的候选被反复再生成直至轮次上限，可能永不收敛；策略
        # threshold 是收敛判定的唯一门槛源，评审器 passed 仅留痕展示。
        passed = [
            r for r in reviews if r.score >= self.threshold
        ]
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
        """当前候选集中得分最高者的列表位置（``candidates`` 下标）。

        按评审器协议（reviews 与 candidates 按下标一一对应）取 reviews
        中最高分者的**序列位置**作为 candidates 下标——不直接信任评审器
        的 ``candidate_index`` 字段（ENG1-6：该下标来自评审轮内枚举，候选
        被过滤/跨轮重组后直接引用会取错候选）；候选集被过滤后位置同样
        越界 = 回落 0（收敛接受的候选落在首位，与收敛决策语义一致）。
        """
        if not self.reviews:
            return 0
        best_pos = max(
            range(len(self.reviews)), key=lambda i: self.reviews[i].score
        )
        if best_pos < len(self.candidates):
            return best_pos
        return 0


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
    "DeterministicRegenerator",
    "DeterministicReviewer",
    "DeterministicWebVerifier",
    "MaxRoundsConvergencePolicy",
    "ParagraphScore",
    "Regenerator",
    "Reviewer",
    "WebVerifier",
]
