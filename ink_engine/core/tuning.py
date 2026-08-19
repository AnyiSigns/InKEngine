"""自适应调优（Self-tuning，参数级进化：回合指标聚合 + 参数快照 + 调参器）。

回合指标聚合纳入引擎自承载（原为使用方约定）：meta 节点读执行统计
（失败率/评审分/收敛轮数）自动调整探索宽度/重试预算/web 验证阈值；
知识集权重/阈值随卡回路反馈进化（与知识孵化闭环）。

分工（与进化工厂）：调参改参数（权重/阈值），进化工厂变异规则结构
（增删改规则）——进化产物过三层闸门；参数变更过 L2 效果评估回归
（参数无「旧版」可比，L1/L3 不适用）。

与推演-回溯的交互（参数快照）：评估时记录所用规则版本 + 权重快照
（随评估记录落库）——调参不改变推演择优的可回放性，回放/审计按
快照重算，避免「标尺在动」导致推演结果不可复现。
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .exceptions import GraphDefinitionError
from .knowledge_gate import GateL2Result, KnowledgeGate
from .knowledge_set import KIND_WEIGHT, KnowledgeEntry
from .logging import get_logger
from .rules import FixtureResult, FixtureSet

logger = get_logger(__name__)

# 权重调整的下限保护（权重不得低于该值——防降权过头让维度形同虚设）
MIN_WEIGHT = 0.1
# 单次调整的权重乘数（低分反馈维度降权步长）
WEIGHT_DECAY = 0.9
# 单次调整的权重加成（高分反馈维度升权步长）
WEIGHT_GAIN = 1.1

# 失败率档位（重试预算/探索宽度的调整依据）
FAILURE_RATE_HIGH = 0.4
FAILURE_RATE_LOW = 0.1

# 机制参数调整边界（参数级进化护栏：上下限保护防失控）
DIVERGENCE_WIDTH_MIN = 1
DIVERGENCE_WIDTH_MAX = 6
RETRY_BUDGET_FLOOR = 2  # 失败率高时的重试预算保底值
WEB_THRESHOLD_MIN = 0.1
WEB_THRESHOLD_MAX = 0.9
WEB_THRESHOLD_STEP = 0.1
CONVERGENCE_AVG_HIGH = 3.0
CONVERGENCE_AVG_LOW = 1.0

# 参数回归的默认取值边界（fixture 未显式声明 bounds 时的兜底口径：
# 权重下限 = 调参下限保护，阈值非负）
_DEFAULT_WEIGHT_MIN = MIN_WEIGHT
_DEFAULT_WEIGHT_MAX = 1.0
_DEFAULT_THRESHOLD_MIN = 0.0
_DEFAULT_THRESHOLD_MAX = float("inf")


@dataclass(slots=True)
class TurnMetrics:
    """回合指标聚合（引擎自承载：失败率/评审分/收敛轮数/挡位调用）。

    触发条件与聚合语义：meta 节点回合收尾时调用 :meth:`record_*`，
    :meth:`snapshot` 汇出结构化指标（调参输入，随评估记录可落库）。
    """

    turns: int = 0
    failures: int = 0
    review_scores: tuple[float, ...] = ()
    convergence_rounds: tuple[int, ...] = ()
    llm_calls_by_tier: dict[str, int] = field(default_factory=dict)
    last_error: str = ""

    def record_turn(self, *, failed: bool = False, error: str = "") -> None:
        """记录一个回合（失败标记 + 错误摘要——失败率/根因留痕）。"""
        self.turns += 1
        if failed:
            self.failures += 1
            if error:
                self.last_error = error

    def record_review(self, score: float) -> None:
        """记录一次评审分（0-1；评审收敛循环每轮产出即记录）。"""
        if not 0 <= score <= 1:
            raise GraphDefinitionError(f"评审分必须在 [0, 1] 内: {score}")
        self.review_scores = (*self.review_scores, score)

    def record_convergence(self, rounds: int) -> None:
        """记录一次收敛循环的轮数（探索-收敛的收敛速度观测）。"""
        if rounds < 0:
            raise GraphDefinitionError(f"收敛轮数不能为负: {rounds}")
        self.convergence_rounds = (*self.convergence_rounds, rounds)

    def record_llm_calls(self, tier_stats: dict[str, int]) -> None:
        """并入挡位调用统计（TierCallStats.snapshot 产物，逐挡位累加）。"""
        for tier, count in (tier_stats or {}).items():
            self.llm_calls_by_tier[tier] = (
                self.llm_calls_by_tier.get(tier, 0) + int(count)
            )

    @property
    def failure_rate(self) -> float:
        """失败率（0-1；无回合 = 0，不除零）。"""
        return self.failures / self.turns if self.turns else 0.0

    @property
    def avg_review_score(self) -> float:
        """平均评审分（无评审记录 = 0）。"""
        return (
            sum(self.review_scores) / len(self.review_scores)
            if self.review_scores
            else 0.0
        )

    def snapshot(self) -> dict[str, Any]:
        """汇出结构化指标（调参输入；可随评估记录落库/审计）。"""
        return {
            "turns": self.turns,
            "failures": self.failures,
            "failure_rate": self.failure_rate,
            "avg_review_score": self.avg_review_score,
            "review_count": len(self.review_scores),
            "review_scores": list(self.review_scores),
            "convergence_rounds": list(self.convergence_rounds),
            "llm_calls_by_tier": dict(self.llm_calls_by_tier),
            "last_error": self.last_error,
        }

    @classmethod
    def from_snapshot(cls, data: dict[str, Any]) -> TurnMetrics:
        """从快照还原（评估记录回放/审计用）。"""
        return cls(
            turns=int(data.get("turns", 0)),
            failures=int(data.get("failures", 0)),
            review_scores=tuple(float(s) for s in data.get("review_scores") or ()),
            convergence_rounds=tuple(
                int(r) for r in data.get("convergence_rounds") or ()
            ),
            llm_calls_by_tier={
                str(k): int(v) for k, v in (data.get("llm_calls_by_tier") or {}).items()
            },
            last_error=data.get("last_error", ""),
        )


@dataclass(frozen=True, slots=True)
class TunableParams:
    """可调参数集合（meta 节点的调参对象：机制参数 + 权重/阈值）。

    Attributes:
        divergence_width: 探索宽度（探索收敛的探索候选数）。
        retry_budget: 重试预算（节点/调用的重试次数上限）。
        web_verify_threshold: web 验证触发阈值（存疑声明的置信度门槛）。
        weights: 评审维度权重表（维度名 → 权重；与 WeightedScorer 同构）。
        thresholds: 校验/评审阈值表（阈值名 → 数值；与规则集/打分器同构）。
    """

    divergence_width: int = 3
    retry_budget: int = 1
    web_verify_threshold: float = 0.5
    weights: dict[str, float] = field(default_factory=dict)
    thresholds: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "divergence_width": self.divergence_width,
            "retry_budget": self.retry_budget,
            "web_verify_threshold": self.web_verify_threshold,
            "weights": dict(self.weights),
            "thresholds": dict(self.thresholds),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TunableParams:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"可调参数声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        return cls(
            divergence_width=int(data.get("divergence_width", 3)),
            retry_budget=int(data.get("retry_budget", 1)),
            web_verify_threshold=float(data.get("web_verify_threshold", 0.5)),
            weights={
                str(k): float(v) for k, v in (data.get("weights") or {}).items()
            },
            thresholds={
                str(k): float(v) for k, v in (data.get("thresholds") or {}).items()
            },
        )


@dataclass(frozen=True, slots=True)
class ParameterSnapshot:
    """参数快照（随评估记录落库：推演回放/审计按快照重算）。

    语义：评估时记录所用规则版本 + 权重/阈值快照——调参不改变历史推演
    的可回放性（「标尺在动」问题：快照冻结当时标尺）。
    """

    rule_version: str  # 规则集版本标识（补丁链长度/版本号）
    params: TunableParams = field(default_factory=TunableParams)
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_version": self.rule_version,
            "params": self.params.to_dict(),
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ParameterSnapshot:
        if not isinstance(data, dict) or not isinstance(data.get("params"), dict):
            raise GraphDefinitionError("参数快照声明非法（缺 params 结构）")
        return cls(
            rule_version=data.get("rule_version", ""),
            params=TunableParams.from_dict(data["params"]),
            created_at=float(data.get("created_at", time.time())),
        )


@dataclass(frozen=True, slots=True)
class TuneResult:
    """一次调参结果（新参数 + 变更说明 + 快照 + 可选说明）。

    Attributes:
        params: 生效参数（回归拒绝时 = 原参数，变更不落地）。
        changes: 变更说明（空 = 无参数变化）。
        snapshot: 参数快照（规则版本 + 新参数；回归拒绝时 = None）。
        note: 附加说明（回归未通过原因等；空 = 无附加说明）。
    """

    params: TunableParams
    changes: tuple[str, ...] = ()
    snapshot: ParameterSnapshot | None = None
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "params": self.params.to_dict(),
            "changes": list(self.changes),
            "snapshot": self.snapshot.to_dict() if self.snapshot else None,
            "note": self.note,
        }


class ParamRegressionExecutor:
    """参数回归执行器：新参数须落在 fixture 声明的取值边界内（L2 回归）。

    与 :class:`~ink_engine.core.knowledge_gate.GateL2FixtureExecutor` 的
    分工：规则条目回归由规则引擎跑样例；参数条目（权重/阈值）无规则
    执行语义，回归 = 取值边界校验——fixture 用例声明每类参数的合法
    边界（bounds），期望全合规/至少一条越界（expected_pass 语义），
    与样例库机制同构（纯数据、可断言、fixture 全绿才允许参数落库）。

    FixtureCase.data 契约：
    - ``weights``/``thresholds``：本次要校验的参数子集（缺省 = 校验
      条目携带的全部参数）；
    - ``bounds``：边界声明 ``{"weights": {"min": .., "max": ..},
      "thresholds": {"min": .., "max": ..}}``（缺省口径 = 权重下限
      调参保护、上限 1.0；阈值非负）。
    """

    async def run(
        self,
        entry: KnowledgeEntry,
        fixtures: FixtureSet,
        *,
        context_rules: dict[str, Any] | None = None,
    ) -> GateL2Result:
        weights = dict(entry.data.get("weights") or {})
        thresholds = dict(entry.data.get("thresholds") or {})
        results: list[FixtureResult] = []
        for case in fixtures.cases:
            bounds = case.data.get("bounds") or {}
            weight_bounds = bounds.get("weights") or {}
            threshold_bounds = bounds.get("thresholds") or {}
            violations = [
                f"权重 {name}={value} 越界"
                f"[{float(weight_bounds.get('min', _DEFAULT_WEIGHT_MIN))}, "
                f"{float(weight_bounds.get('max', _DEFAULT_WEIGHT_MAX))}]"
                for name, value in weights.items()
                if not (
                    float(weight_bounds.get("min", _DEFAULT_WEIGHT_MIN)) - 1e-9
                    <= value
                    <= float(weight_bounds.get("max", _DEFAULT_WEIGHT_MAX)) + 1e-9
                )
            ]
            violations.extend(
                f"阈值 {name}={value} 越界"
                f"[{float(threshold_bounds.get('min', _DEFAULT_THRESHOLD_MIN))}, "
                f"{float(threshold_bounds.get('max', _DEFAULT_THRESHOLD_MAX))}]"
                for name, value in thresholds.items()
                if not (
                    float(threshold_bounds.get("min", _DEFAULT_THRESHOLD_MIN)) - 1e-9
                    <= value
                    <= float(threshold_bounds.get("max", _DEFAULT_THRESHOLD_MAX)) + 1e-9
                )
            )
            passed = (not violations) if case.expected_pass else bool(violations)
            if passed:
                reason = ""
            elif not case.expected_pass:
                reason = "期望至少一条越界，实际全部合规"
            else:
                reason = "; ".join(violations[:3])
            results.append(
                FixtureResult(
                    case_id=case.id,
                    passed=passed,
                    violations=(),
                    expected_pass=case.expected_pass,
                    reason=reason,
                )
            )
        all_passed = all(r.passed for r in results)
        return GateL2Result(
            passed=all_passed,
            fixture_results=tuple(results),
            accuracy=sum(r.passed for r in results) / len(results) if results else 0.0,
            regression_samples=len(results),
            note="" if all_passed else "参数回归样例未全绿",
        )


def _params_entry(params: TunableParams) -> KnowledgeEntry:
    """调参产物 → 知识条目（kind=weight：参数回归的评估对象形态）。"""
    return KnowledgeEntry(
        id=f"tune-{int(time.time() * 1000)}",
        level="work",
        kind=KIND_WEIGHT,
        data=params.to_dict(),
        source="model",
        credibility=1.0,
        title="调参回归样本",
    )


class MetaTuner:
    """调参器：回合指标 + 卡回路反馈 → 参数调整（确定性基线）。

    调整语义（可解释、可断言）：
    - **卡回路反馈降权**：反馈中低分维度（< 反馈阈值）的权重乘衰减系数
      （下限保护 MIN_WEIGHT）——评审评分随权重调整变化，避免劣质维度
      主导总分；
    - **失败率 → 重试预算**：失败率高则上调重试预算（容错），低则回落
      （省成本）；
    - **失败率 → web 验证阈值**：失败率高下调验证阈值（更早触发验证），
      低则上调（减少无谓验证）；
    - **收敛轮数 → 探索宽度**：平均收敛轮数偏高则加宽探索（探索更多
      候选），偏低则收窄（收敛更快）。

    参数变更过 L2 效果评估回归（调参分工：参数不走 L1/L3——参数无
    「旧版」可比，回归由使用方在 meta 节点落地时执行）。
    """

    def __init__(
        self,
        *,
        feedback_threshold: float = 0.5,
        weight_decay: float = WEIGHT_DECAY,
        weight_gain: float = WEIGHT_GAIN,
        min_weight: float = MIN_WEIGHT,
        snapshot_sink: Callable[[ParameterSnapshot], Any] | None = None,
    ) -> None:
        self.feedback_threshold = feedback_threshold
        self.weight_decay = weight_decay
        self.weight_gain = weight_gain
        self.min_weight = min_weight
        # 参数快照落库集成点（随评估记录持久化——机制数据引擎存，落库
        # 实现由使用方注入；None = 不落库）。回归通过的参数快照经此
        # 回调交给存储侧，回放/审计按快照重算。
        self.snapshot_sink = snapshot_sink

    def tune(
        self,
        params: TunableParams,
        metrics: TurnMetrics,
        *,
        feedback: dict[str, float] | None = None,
        rule_version: str | None = None,
    ) -> TuneResult:
        """按指标与反馈调整参数（无变化时返回原参数，changes 为空）。

        Args:
            params: 当前参数（调参的输入基线）。
            metrics: 回合指标（失败率/评审分/收敛轮数）。
            feedback: 卡回路反馈（维度名 → 得分 0-1；None = 无反馈，
                仅按执行统计调机制参数）。
            rule_version: 规则集版本标识（随快照落库；None = 快照不落
                ——调用方在需要回放语义时提供）。

        Returns:
            TuneResult：新参数 + 变更说明 + 参数快照（供评估记录落库）。
        """
        changes: list[str] = []
        weights = dict(params.weights)
        for dimension, score in (feedback or {}).items():
            if dimension not in weights:
                continue  # 未知维度不调整（口径漂移由配置侧修复）
            if score < self.feedback_threshold:
                new_weight = max(weights[dimension] * self.weight_decay, self.min_weight)
                if new_weight != weights[dimension]:
                    changes.append(
                        f"维度 {dimension} 低分（{score:.2f}）降权: "
                        f"{weights[dimension]:.2f} → {new_weight:.2f}"
                    )
                    weights[dimension] = new_weight
            elif score > self.feedback_threshold:
                new_weight = weights[dimension] * self.weight_gain
                if new_weight != weights[dimension]:
                    changes.append(
                        f"维度 {dimension} 高分（{score:.2f}）升权: "
                        f"{weights[dimension]:.2f} → {new_weight:.2f}"
                    )
                    weights[dimension] = new_weight

        failure_rate = metrics.failure_rate
        retry_budget = params.retry_budget
        if failure_rate >= FAILURE_RATE_HIGH:
            new_retry = max(retry_budget, RETRY_BUDGET_FLOOR)
            if new_retry != retry_budget:
                retry_budget = new_retry
                changes.append(f"失败率 {failure_rate:.2f} 偏高，重试预算上调至 {retry_budget}")
        elif metrics.turns > 0 and failure_rate <= FAILURE_RATE_LOW and retry_budget > 1:
            retry_budget -= 1
            changes.append(f"失败率 {failure_rate:.2f} 偏低，重试预算回落至 {retry_budget}")

        web_verify_threshold = params.web_verify_threshold
        if failure_rate >= FAILURE_RATE_HIGH:
            new_threshold = max(web_verify_threshold - WEB_THRESHOLD_STEP, WEB_THRESHOLD_MIN)
            if new_threshold != web_verify_threshold:
                web_verify_threshold = new_threshold
                changes.append(
                    f"失败率 {failure_rate:.2f} 偏高，web 验证阈值下调至 {web_verify_threshold:.2f}"
                )
        elif metrics.turns > 0 and failure_rate <= FAILURE_RATE_LOW:
            new_threshold = min(web_verify_threshold + WEB_THRESHOLD_STEP, WEB_THRESHOLD_MAX)
            if new_threshold != web_verify_threshold:
                web_verify_threshold = new_threshold
                changes.append(
                    f"失败率 {failure_rate:.2f} 偏低，web 验证阈值上调至 {web_verify_threshold:.2f}"
                )

        divergence_width = params.divergence_width
        if metrics.convergence_rounds:
            avg_rounds = sum(metrics.convergence_rounds) / len(metrics.convergence_rounds)
            if avg_rounds >= CONVERGENCE_AVG_HIGH:
                new_width = min(divergence_width + 1, DIVERGENCE_WIDTH_MAX)
                if new_width != divergence_width:
                    divergence_width = new_width
                    changes.append(
                        f"平均收敛轮数 {avg_rounds:.1f} 偏高，探索宽度加宽至 {divergence_width}"
                    )
            elif avg_rounds <= CONVERGENCE_AVG_LOW and divergence_width > DIVERGENCE_WIDTH_MIN:
                divergence_width -= 1
                changes.append(
                    f"平均收敛轮数 {avg_rounds:.1f} 偏低，探索宽度收窄至 {divergence_width}"
                )

        new_params = TunableParams(
            divergence_width=divergence_width,
            retry_budget=retry_budget,
            web_verify_threshold=web_verify_threshold,
            weights=weights,
            thresholds=dict(params.thresholds),
        )
        snapshot = (
            ParameterSnapshot(rule_version=rule_version, params=new_params)
            if rule_version is not None
            else None
        )
        return TuneResult(params=new_params, changes=tuple(changes), snapshot=snapshot)

    async def tune_with_regression(
        self,
        params: TunableParams,
        metrics: TurnMetrics,
        fixtures: FixtureSet,
        *,
        feedback: dict[str, float] | None = None,
        rule_version: str | None = None,
        gate: KnowledgeGate | None = None,
        regression: FixtureSet | None = None,
    ) -> TuneResult:
        """调参 + L2 效果评估回归（参数变更须过回归才生效）。

        分工语义（参数变更过 L2 效果评估回归）：参数无「旧版」可比
        （L1/L3 不适用），回归 = L2 样例闸门——新参数须让回归样例全绿
        才允许生效；回归未通过 = 变更被拒绝，返回原参数（changes 空 +
        note 说明原因，调用方留痕审计）。

        Args:
            params: 当前参数（调参输入基线，也是回归失败时的回落值）。
            metrics: 回合指标（失败率/评审分/收敛轮数）。
            fixtures: 参数回归样例（bounds 契约，见
                :class:`ParamRegressionExecutor`）。
            feedback: 卡回路反馈（维度名 → 得分，透传调参）。
            rule_version: 规则集版本（随快照落库）。
            gate: 闸门实例（None = 默认：回归执行器 + 内置谓词注册表）。
            regression: L2 历史回归用例（追加评估；None = 不追加）。

        Returns:
            TuneResult：回归通过 = 新参数；未通过 = 原参数 + note。
        """
        tuned = self.tune(
            params, metrics, feedback=feedback, rule_version=rule_version
        )
        if not tuned.changes:
            return tuned  # 无参数变化无需回归（不空转评估）
        gate = gate or KnowledgeGate(l2_executor=ParamRegressionExecutor())
        l2 = await gate.check_l2(
            _params_entry(tuned.params), fixtures, regression=regression
        )
        if l2.passed:
            # 回归通过的参数快照经注入的落库回调持久化（回放/审计按
            # 快照重算）；回调失败只记日志不阻断调参
            if tuned.snapshot is not None and self.snapshot_sink is not None:
                try:
                    self.snapshot_sink(tuned.snapshot)
                except Exception as exc:
                    logger.warning(f"参数快照落库失败（忽略）: {exc}")
            return tuned
        return TuneResult(
            params=params,
            note=f"参数回归未通过，变更被拒绝: {l2.note or '样例未全绿'}",
        )


__all__ = [
    "CONVERGENCE_AVG_HIGH",
    "CONVERGENCE_AVG_LOW",
    "DIVERGENCE_WIDTH_MAX",
    "DIVERGENCE_WIDTH_MIN",
    "FAILURE_RATE_HIGH",
    "FAILURE_RATE_LOW",
    "MIN_WEIGHT",
    "RETRY_BUDGET_FLOOR",
    "WEB_THRESHOLD_MAX",
    "WEB_THRESHOLD_MIN",
    "WEB_THRESHOLD_STEP",
    "WEIGHT_DECAY",
    "WEIGHT_GAIN",
    "MetaTuner",
    "ParamRegressionExecutor",
    "ParameterSnapshot",
    "TunableParams",
    "TuneResult",
    "TurnMetrics",
]
