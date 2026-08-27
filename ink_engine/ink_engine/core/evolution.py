"""进化工厂（知识结构级进化：反思式变异 + 三层闸门防退化）。

华为云进化工厂形态的引擎实现：失败率高的知识优先入队（次之长期未调用
但仍有引用/价值标记，稳定者殿后）；**反思式变异**（变异输入 = 该知识
近期失败日志，非成功轨迹）；变异体数量按调用频率/失败次数动态决定；
进化产物同样过三层闸门——防进化退化（华为云明确：迭代多轮会停滞/
退化，评估管道是质量底线）。批处理的调度窗口由使用方驱动
（:meth:`EvolutionFactory.collect_candidates` 提供优先级排序），
引擎不内置调度器——调度时机属使用方策略。

变异体动态数量：调用频率与失败次数越高，变异探索越激进（更多变体），
低活跃知识一次一个变体（控制知识膨胀）。
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from .knowledge_gate import GateL3Result, KnowledgeGate
from .knowledge_set import KnowledgeEntry

# 进化队列优先级权重（失败率优先，长期未调用次之，稳定者殿后）
_FAILURE_WEIGHT = 10.0
_IDLE_WEIGHT = 1.0

# 变异体数量档位（按失败率/调用频率动态决定）
_BASE_VARIANTS = 1
_MAX_VARIANTS = 3

# 失败率档位阈值（低于 = 低失败率；高于 = 高失败率）
_HIGH_FAILURE_RATE = 0.3
# 长期未调用阈值（usage_count = 0 或远低于调用均值）
_IDLE_USAGE = 2


@dataclass(frozen=True, slots=True)
class EvolutionCandidate:
    """进化入队条目（失败率优先排序的依据）。"""

    entry: KnowledgeEntry
    failure_rate: float  # fail_count / usage_count（0-1；无调用 = 0）
    failure_logs: tuple[str, ...] = ()  # 近期失败日志（反思式变异输入）
    is_idle: bool = False  # 长期未调用但仍有引用/价值标记

    @property
    def priority(self) -> float:
        """入队优先级：失败率 × 权重 + 长期未调用 × 权重（数值大优先）。"""
        return self.failure_rate * _FAILURE_WEIGHT + (
            _IDLE_WEIGHT if self.is_idle else 0.0
        )


@dataclass(frozen=True, slots=True)
class EvolutionOutcome:
    """一次进化批次的产物（变异体 + 保留/退化判定留痕）。"""

    variants: tuple[KnowledgeEntry, ...] = ()
    rejected: tuple[str, ...] = ()  # 未过闸门的变异体说明（防退化留痕）
    gate_results: tuple[GateL3Result, ...] = ()

    @property
    def kept(self) -> int:
        return len(self.variants)


def entry_metrics(entry: KnowledgeEntry) -> dict[str, float]:
    """母体知识条目 → L3 维度指标（防退化基线：劣于母体不过 L3）。

    ENG1-1 修复的指标构造口径（调用留痕 = 该知识的执行观测）：
    - accuracy = 1 - 失败率（usage_count>0 时按 fail/usage 留痕推算，
      成功 = 该知识实际有效运行的证据；从未调用 = 1.0，无失败证据）；
    - safety = 1.0（闸门 L2 满分基线口径，与 check_l3 默认派生同向）。

    不含 latency：条目不携带时序数据（中性基线 1.0 会与变异体真实
    测量的 latency<1.0 比较产生虚假「劣化」）——母体无可比时序维度
    即不参与比较；变异策略注入 evaluate 时新指标的 latency 也不与
    母体比较（母体无该维度数据，口径一致不误判）。

    与 :class:`MutationStrategy.evaluate` 产出的变异体 new_metrics 在
    accuracy/safety 维度可比——变异策略注入 evaluate 时「劣于母体
    不过 L3」按真实评估比较；未注入时变异体走 L2 默认派生（accuracy
    为样例通过率），母体按本口径给出比较基线。
    """
    failure_rate = 0.0
    if entry.usage_count > 0:
        failure_rate = min(entry.fail_count / entry.usage_count, 1.0)
    return {
        "accuracy": round(1.0 - failure_rate, 6),
        "safety": 1.0,
    }


@runtime_checkable
class MutationStrategy(Protocol):
    """变异策略协议：失败日志 → 变异体知识数据（反思式变异的执行体）。

    引擎规定「输入失败日志、输出变异体数据」的契约；具体变异操作
    （结构调整/阈值修订/分支重写）由实现方决定——确定性基线见
    :class:`DeterministicMutation`，LLM 反思变异为可选扩展。

    ``evaluate`` 为可选钩子：变异体的维度指标评估（L3 目标筛选的
    new_metrics 来源；返回 None = 用 L2 样例派生默认）——不实现时
    进化工厂按默认指标口径走 L3。
    """

    def mutate(
        self, entry: KnowledgeEntry, failure_logs: tuple[str, ...]
    ) -> list[dict[str, Any]]: ...

    async def evaluate(
        self,
        variant_data: dict[str, Any],
        schema: Any,
        fixtures: Any,
    ) -> dict[str, float] | None:
        """变异体维度指标（accuracy/latency/safety…）；None = 默认口径。"""
        return None


class DeterministicMutation:
    """确定性变异基线：按失败日志局部修订（零 LLM，可测试可断言）。

    变异语义（防退化底线：变异体必须过三层闸门才保留）：
    - 每次变异 = 一条可解释的结构化修订（修订原因 = 失败日志摘要）；
    - 多日志分别变异（每条失败日志产出一个变体候选——失败驱动的
      定向探索），受调用频率/失败次数动态数量上限约束；
    - 变异体与母体共享 id 前缀（同一知识的不同版本，随补丁链分支）。
    """

    def __init__(self, max_variants: int = _MAX_VARIANTS) -> None:
        self.max_variants = max_variants

    def variant_count(self, candidate: EvolutionCandidate) -> int:
        """变异体数量：按失败率/调用频率动态决定（高活跃多探索）。

        上限取实例配置（子类可覆写构造不继承时回落模块缺省）。
        """
        limit = getattr(self, "max_variants", _MAX_VARIANTS)
        if candidate.failure_rate >= _HIGH_FAILURE_RATE:
            return min(limit, max(_BASE_VARIANTS, len(candidate.failure_logs)))
        return _BASE_VARIANTS

    def mutate(
        self, entry: KnowledgeEntry, failure_logs: tuple[str, ...]
    ) -> list[dict[str, Any]]:
        """失败日志 → 变异体数据清单（每条日志一个定向修订变体）。

        Returns:
            变异体 data 清单（与母体 data 同构，修订原因入 note 字段）；
            空 = 无失败日志（无从反思，不产出无依据变异）。
        """
        if not failure_logs:
            return []
        variants: list[dict[str, Any]] = []
        for log in failure_logs[: self.max_variants]:
            # 深拷贝：嵌套结构共享引用会污染母体条目（ENG1-10）——变异体
            # 只在其自身 data 上追加修订标记，母体 data 永不被改写
            variant = copy.deepcopy(entry.data)
            variant["_mutation"] = {
                "based_on": log,
                "variant_of": entry.id,
            }
            variants.append(variant)
        return variants


class EvolutionFactory:
    """进化工厂：失败率优先入队 → 反思式变异 → 三层闸门防退化。

    使用流程（使用方驱动调度窗口）：
    1. 收集候选（:meth:`collect_candidates` 或使用方自建候选清单）；
    2. 按优先级排序（:meth:`rank`）；
    3. 逐候选进化（:meth:`evolve`）——变异体过闸门（L1/L2/L3），
       L3 是防退化底线（不差于旧版才保留）。
    """

    def __init__(
        self,
        gate: KnowledgeGate,
        mutation: MutationStrategy | None = None,
    ) -> None:
        self.gate = gate
        self.mutation = mutation or DeterministicMutation()

    @classmethod
    def collect_candidates(
        cls,
        entries: list[KnowledgeEntry],
        *,
        failure_logs: dict[str, tuple[str, ...]] | None = None,
        idle_threshold: int = _IDLE_USAGE,
    ) -> list[EvolutionCandidate]:
        """候选收集：失败率优先入队（次之长期未调用，稳定者不入队）。

        Args:
            entries: 知识集条目（工作/项目/用户级全部）。
            failure_logs: 条目 id → 近期失败日志（反思式变异输入）。
            idle_threshold: 长期未调用判定阈值（usage_count ≤ 该值）。

        Returns:
            按优先级降序的候选清单（稳定且活跃的条目不参与进化）。
        """
        logs = failure_logs or {}
        candidates: list[EvolutionCandidate] = []
        for entry in entries:
            if entry.usage_count <= 0:
                continue  # 从未调用：无从评估失败率，也不进化（避免噪音）
            failure_rate = min(entry.fail_count / entry.usage_count, 1.0)
            idle = entry.usage_count <= idle_threshold and entry.credibility > 0
            if failure_rate <= 0.0 and not idle:
                # 稳定高频零失败：不参与进化（与「失败率优先、次之长期未
                # 调用、稳定者不入队」文档一致——ENG1-3：旧实现把稳定条目
                # 也入队，与 docstring「稳定且活跃的条目不参与进化」矛盾）
                continue
            candidates.append(
                EvolutionCandidate(
                    entry=entry,
                    failure_rate=failure_rate,
                    failure_logs=logs.get(entry.id, ()),
                    is_idle=idle,
                )
            )
        return candidates

    @staticmethod
    def rank(candidates: list[EvolutionCandidate]) -> list[EvolutionCandidate]:
        """入队排序：优先级降序（失败率优先，稳定者殿后）。"""
        return sorted(candidates, key=lambda c: c.priority, reverse=True)

    async def evolve(
        self,
        candidate: EvolutionCandidate,
        *,
        schema: Any,
        fixtures: Any,
        old_metrics: dict[str, float] | None = None,
        regression: Any = None,
    ) -> EvolutionOutcome:
        """进化单个候选：反思式变异 → 逐变体过闸门 → 保留不退化者。

        Args:
            candidate: 进化候选（含失败日志——反思式变异输入）。
            schema: L1 schema 声明（变异体形式合法关）。
            fixtures: L2 完整样例库（变异体效果关，非谈判项）。
            old_metrics: 母体维度指标（L3 目标筛选基准——不差于旧版）。
            regression: L2 历史回归用例（追加评估；None = 不追加）。

        Returns:
            EvolutionOutcome：保留的变异体（已过三层闸门）+ 拒绝留痕
            （防退化：L3 拒绝 = 劣于旧版，不落库）。
        """
        if not candidate.failure_logs:
            # 区分「稳定无日志」与「真无日志」（ENG1-22）：失败率 = 0 的
            # 候选是稳定条目（无失败可记），有失败率却无日志 = 留痕缺口
            # （失败发生了但日志没采到）——两种情形拒绝文案不同，观察侧
            # 可据此识别留痕链路问题
            if candidate.failure_rate <= 0.0:
                reason = "无失败日志（稳定条目无失败可反思）"
            else:
                reason = "无失败日志（有失败率但日志缺失，无从反思）"
            return EvolutionOutcome(
                rejected=(f"{candidate.entry.id}: {reason}",)
            )
        if old_metrics is None:
            # ENG1-1 防退化底线：调用方未提供旧版指标时按母体调用留痕
            # 构造（accuracy = 成功率，latency/safety = 中性基线）——
            # 「不差于母体」在生产链路真实生效，不再退化为「L1+L2 通过
            # 即替换」
            old_metrics = entry_metrics(candidate.entry)
        # 变异体数量按失败率/调用频率动态决定（高活跃多探索，低活跃单
        # 变体控膨胀）：策略实现 variant_count 时以其为准，否则全量日志
        variant_limit = (
            self.mutation.variant_count(candidate)
            if hasattr(self.mutation, "variant_count")
            else len(candidate.failure_logs)
        )
        failure_logs = candidate.failure_logs[:variant_limit]
        variants: list[KnowledgeEntry] = []
        rejected: list[str] = []
        gate_results: list[GateL3Result] = []
        evaluator = getattr(self.mutation, "evaluate", None)
        for raw in self.mutation.mutate(candidate.entry, failure_logs):
            variant = KnowledgeEntry(
                id=f"{candidate.entry.id}:v{len(variants) + 1}",
                level=candidate.entry.level,
                kind=candidate.entry.kind,
                data=raw,
                source=candidate.entry.source,
                credibility=candidate.entry.credibility,
                title=f"{candidate.entry.title}（变异）",
                tags=candidate.entry.tags,
            )
            new_metrics = None
            if evaluator is not None:
                try:
                    new_metrics = await evaluator(raw, schema, fixtures)
                except Exception:
                    new_metrics = None  # 评估钩子异常 = 回落默认口径
            l1, l2, l3 = await self.gate.check(
                variant,
                schema=schema,
                fixtures=fixtures,
                new_metrics=new_metrics,
                old_metrics=old_metrics,
                regression=regression,
            )
            gate_results.append(l3)
            if l1.passed and l2.passed and l3.passed:
                variants.append(variant)
            else:
                failed_at = "L1" if not l1.passed else ("L2" if not l2.passed else "L3")
                rejected.append(f"{variant.id}: {failed_at} 未通过（{l3.reason or l2.note or l1.errors}）")
        return EvolutionOutcome(
            variants=tuple(variants),
            rejected=tuple(rejected),
            gate_results=tuple(gate_results),
        )


__all__ = [
    "DeterministicMutation",
    "EvolutionCandidate",
    "EvolutionFactory",
    "EvolutionOutcome",
    "MutationStrategy",
    "entry_metrics",
]
