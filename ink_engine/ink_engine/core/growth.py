"""自学习管线（孵化闭环）：回合事件 → 信号 → 蒸馏 → 三层闸门 → 知识集落位。

引擎自承载的「生长」机制（出厂默认开启，无用户可操作项）：把会话回合
执行轨迹中可学习的部分沉淀为知识，全部过程在引擎内部跑通，宿主无需
介入——知识落位过三层闸门（L1 形式合法+注入扫描 / L2 效果评估 /
L3 目标筛选），自动放行不弹人工卡（自我进化是后台机制，不是审批面）。

链路（复用既有机制件，本模块只做接线与缓冲）：
- **观察侧**：实现 :class:`EngineTransport`，按序观察回合事件流——
  ``error``/失败工具调用 → 踩坑信号，评审决议 accept/edit/reject →
  用户修正信号，``insight``/``review_pass``/``user_confirm`` → 洞见
  信号（分类路由见 :class:`~ink_engine.core.knowledge_signals.SignalClassifier`）；
- **缓冲侧**：信号进入孵化缓冲（跨回合累积，同因聚合升级重复根因）；
- **触发侧**：实现 :class:`~ink_engine.core.settle.SettleHook`，回合
  收尾按需蒸馏——复杂度（结点步数）或用户干预超阈值才蒸馏（华为云
  任务反思语义，双阈值保守防「蒸馏垃圾进垃圾出」）；确定性基线零
  LLM，链缺失回落确定性蒸馏；
- **落位侧**：蒸馏产物过 :class:`KnowledgeGate` 三层闸门后写入知识集
  （insight 教训条目无执行语义，L2 跳过规则执行——闸门注在写入边界）。
- **事件侧**：发射 ``signal_detected`` / ``distill_outcome`` /
  ``gate_verdict`` 事件（注入的 ``emit`` 回调转发引擎事件流——前端
  演化页签的实时数据面；未注入 = 静默，不影响沉淀链路）。
- **诊断侧**：``snapshot()`` 只读暴露孵化中信号数/知识集规模/闸门
  通过率（成长状态视图数据面，无任何可操作项）。
"""
from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .events import EngineEvent
from .knowledge_gate import KnowledgeGate
from .knowledge_set import KIND_INSIGHT, LEVEL_WORK, KnowledgeEntry, KnowledgeSet
from .knowledge_signals import (
    SIGNAL_INSIGHT,
    SIGNAL_PITFALL,
    SIGNAL_USER_CORRECTION,
    SOURCE_RANK,
    DistillConfig,
    ExecutionSignal,
    SignalClassifier,
    TieredDistiller,
)
from .logging import get_logger
from .rules import FixtureSet
from .schema_validator import SchemaField, SchemaSpec
from .settle import SettleContext
from .source_grading import default_credibility

logger = get_logger(__name__)

# 孵化缓冲上限（信号跨回合累积但有界：超限丢弃最旧——防长时间无阈值
# 触发时内存膨胀；上限远高于现实单会话信号量，正常场景不触发）
_MAX_INCUBATING = 200

# 孵化产物的 L1 schema（insight 教训条目声明形态：id/level/kind 字段关；
# 内容面注入扫描由闸门 L1 兜底——schema 只做结构口径）
_INSIGHT_SCHEMA = SchemaSpec(
    name="growth.insight",
    fields=(
        SchemaField(name="id", required=True, kind="string"),
        SchemaField(name="level", required=True, kind="string"),
        SchemaField(name="kind", required=True, kind="string"),
    ),
)

# L2 fixtures（insight 教训条目无规则执行语义——L2 跳过执行，空样例库即可）
_EMPTY_FIXTURES = FixtureSet(name="growth", cases=())


@dataclass(frozen=True, slots=True)
class GrowthConfig:
    """自学习管线配置（出厂默认开启；无用户可操作项）。

    可观察诊断：管线是否启用（成长状态视图的启用态展示）；关闭 =
    观察/蒸馏/落位全链路停用（引擎回到「无自学习」基线）。
    """

    enabled: bool = True


class GrowthPipeline:
    """自学习闭环：回合事件 → 信号缓冲 → 按需蒸馏 → 三层闸门 → 知识集。

    同一实例同时实现 :class:`EngineTransport`（观察事件流）与
    :class:`~ink_engine.core.settle.SettleHook`（回合收尾触发），由
    Runtime 装配注入：观察侧注册进 RunOptions.transports，触发侧注册
    进 RunOptions.settle 钩子链。

    故障隔离：观察/触发全程吞异常（观测不影响执行、沉淀失败不阻断
    run 结果交付——与 settle 钩子语义一致）。
    """

    def __init__(
        self,
        knowledge_set: KnowledgeSet,
        *,
        config: GrowthConfig | None = None,
        distiller: TieredDistiller | None = None,
        gate: KnowledgeGate | None = None,
        emit: Callable[[str, dict], Awaitable[None]] | None = None,
    ) -> None:
        self.config = config or GrowthConfig()
        self.knowledge_set = knowledge_set
        self.distiller = distiller or TieredDistiller(
            config=DistillConfig(), chain=None
        )
        # 自动放行人工层：自我进化是后台机制，落位只过三层闸门
        self.gate = gate or KnowledgeGate(human_review_enabled=False)
        self._classifier = SignalClassifier()
        # 孵化事件发射回调（(etype, payload) -> Awaitable；注入 = 转发
        # 引擎事件流，前端演化页签实时消费；None = 静默，不阻断沉淀）
        self._emit = emit
        # 孵化缓冲（跨回合累积；蒸馏触发后清空）
        self._buffer: list[ExecutionSignal] = []
        # 待发射的信号检测队列（观察侧只入队，回合收尾 settle 锁外批量
        # 发射——避免在引擎传输锁内重入 publish 死锁）
        self._pending_signal_events: list[ExecutionSignal] = []
        # 本缓冲期的用户干预数（回合收尾蒸馏触发判据之一）
        self._interventions = 0
        # 诊断计数（只读快照的数据面）
        self.collected_total = 0  # 累计收集信号数
        self.gate_checked = 0  # 闸门评估次数
        self.gate_passed = 0  # 闸门通过次数
        self.landed = 0  # 落位知识集条数
        self.last_flush_note = "自学习管线就绪（默认开启，回合收尾按需蒸馏）"
        self._last_landed_at: float | None = None

    # ── 事件发射（孵化动态 → 前端演化页签）──

    def set_emit(self, emit: Callable[[str, dict], Awaitable[None]] | None) -> None:
        """注入事件发射回调（引擎装配后接引擎事件流；None = 静默）。"""
        self._emit = emit

    async def _publish(self, etype: str, payload: dict) -> None:
        """发射孵化事件（注入回调转发；异常忽略——观测不阻断沉淀）。"""
        if self._emit is None:
            return
        try:
            await self._emit(etype, payload)
        except Exception as exc:
            logger.warning("孵化事件发射失败（忽略）: %s: %s", etype, exc)

    async def _emit_signal_detected(self, signal: ExecutionSignal) -> None:
        """信号检测事件（signal_id = 蒸馏/闸门事件关联锚）。"""
        await self._publish(
            "signal_detected",
            {
                "signal_id": self._signal_id(signal),
                "signal_type": signal.kind,
                "signal": signal.message,
                "source": signal.source,
            },
        )

    async def _emit_distill_outcome(
        self, signal: ExecutionSignal, data: dict[str, Any] | None
    ) -> None:
        """蒸馏产物事件（关联到触发蒸馏的信号）。"""
        distilled = ""
        if data:
            insight = (data.get("insight") or {}).get("message")
            if isinstance(insight, str):
                distilled = insight
        await self._publish(
            "distill_outcome",
            {
                "signal_id": self._signal_id(signal),
                "distilled": distilled or "蒸馏产物（确定性基线）",
            },
        )

    async def _emit_gate_verdict(
        self,
        signal: ExecutionSignal,
        *,
        passed: bool,
        level: str,
        reason: str,
    ) -> None:
        """闸门判定事件（放行/拦截都发——前端时间线两态可见）。"""
        await self._publish(
            "gate_verdict",
            {
                "signal_id": self._signal_id(signal),
                "passed": passed,
                "level": level,
                "reason": reason or ("已放行" if passed else "未通过闸门"),
            },
        )

    @staticmethod
    def _signal_id(signal: ExecutionSignal) -> str:
        """信号稳定 id（同因聚合后仍可关联：kind+message 摘要指纹）。

        uuid 只出现在落位条目；事件侧用指纹保持「信号检测 → 蒸馏 → 闸门」
        三事件对同一信号 id 关联，前端时间线合并为一条。
        """
        return f"sig:{signal.kind}:{abs(hash((signal.kind, signal.message))) % 10**8}"

    # ── 观察侧：回合事件 → 信号 ──

    async def send(self, event: EngineEvent) -> None:
        """EngineTransport：观察回合事件流（观测不阻断执行）。"""
        if not self.config.enabled:
            return
        try:
            await self._observe(event)
        except Exception as exc:
            logger.warning("自学习管线事件观察失败（忽略）: %s", exc)

    async def _observe(self, event: EngineEvent) -> None:
        payload = event.payload or {}
        # 工具调用失败（host 回合事件 tool_end 携带 success=false）→ 踩坑；
        # 其余事件按分类器规则路由
        if event.type == "tool_end" and payload.get("success") is False:
            signal = ExecutionSignal(
                kind=SIGNAL_PITFALL,
                message=str(payload.get("message") or "工具执行失败")
                or f"工具执行失败: {payload.get('tool') or ''}",
                source=_source_from_event(event),
                context=dict(payload),
            )
        else:
            signal = self._classifier.classify(
                {
                    "type": event.type,
                    "message": payload.get("message"),
                    "source": _source_from_event(event),
                    "context": payload,
                }
            )
        if signal is None:
            return
        self._buffer.append(signal)
        if len(self._buffer) > _MAX_INCUBATING:
            self._buffer.pop(0)
        self.collected_total += 1
        if signal.kind == SIGNAL_USER_CORRECTION:
            self._interventions += 1
        # 事件侧：信号检测入队（观察侧在引擎传输锁内，不能同步发射——
        # 回合收尾 settle 锁外批量发出，前端演化页签「信号」节点）
        self._pending_signal_events.append(signal)

    # ── 触发侧：回合收尾按需蒸馏 ──

    async def settle(self, ctx: SettleContext) -> None:
        """SettleHook：回合收尾（复杂度 = 结点步数）按需蒸馏。"""
        if not self.config.enabled:
            return
        try:
            await self.flush_round(complexity=len(ctx.steps))
        except Exception as exc:
            logger.warning("自学习管线回合收尾失败（忽略）: %s", exc)

    async def flush_round(self, *, complexity: int = 0) -> None:
        """回合收尾刷新：缓冲信号按需蒸馏 → 三层闸门 → 知识集落位。

        Args:
            complexity: 本回合复杂度（结点步数；触发判据之一）。
        """
        # 先发射观察期累计的信号检测事件（settle 在引擎传输锁外，此处
        # publish 无重入死锁风险；发射失败已由 _publish 吞异常）
        pending = self._pending_signal_events
        self._pending_signal_events = []
        for signal in pending:
            await self._emit_signal_detected(signal)
        if not self.config.enabled or not self._buffer:
            return
        interventions = self._interventions
        if not self.distiller.should_distill(
            complexity=complexity, interventions=interventions
        ):
            # 未达阈值：信号继续孵化（跨回合累积）
            self.last_flush_note = (
                f"信号孵化中（{len(self._buffer)} 条；复杂度 {complexity} "
                f"/ 干预 {interventions} 未达蒸馏阈值）"
            )
            return
        self._interventions = 0
        # 同因聚合升级（重复根因 → 升级信号；普通信号原样保留）
        signals = self._classifier.aggregate(self._buffer)
        self._buffer = []
        anchor = signals[0] if signals else None
        data = self.distiller.distill(signals)
        if data is None:
            self.last_flush_note = "蒸馏无产物（无可沉淀素材，轨迹噪音已过滤）"
            if anchor is not None:
                await self._emit_distill_outcome(anchor, None)
            return
        if anchor is not None:
            await self._emit_distill_outcome(anchor, data)
        entry = self._build_entry(data, signals)
        l1, l2, l3 = await self.gate.check(
            entry, schema=_INSIGHT_SCHEMA, fixtures=_EMPTY_FIXTURES
        )
        self.gate_checked += 1
        if l1.passed and l2.passed and l3.passed:
            self.gate_passed += 1
            self.knowledge_set.add(entry)
            self.landed += 1
            self._last_landed_at = time.time()
            self.last_flush_note = (
                f"蒸馏产物过三层闸门落位知识集（{entry.id}，可信度 "
                f"{entry.credibility}）"
            )
            if anchor is not None:
                await self._emit_gate_verdict(
                    anchor,
                    passed=True,
                    level="L1/L2/L3",
                    reason="三层闸门通过",
                )
        else:
            self.last_flush_note = "蒸馏产物未过闸门（L1/L2/L3），本次不落库"
            if anchor is not None:
                await self._emit_gate_verdict(
                    anchor,
                    passed=False,
                    level="L1/L2/L3",
                    reason="未通过三层闸门",
                )

    def _build_entry(
        self, data: dict[str, Any], signals: list[ExecutionSignal]
    ) -> KnowledgeEntry:
        """蒸馏产物 → 知识条目（来源取最可信者，可信度按来源分级）。"""
        ranked = [
            (s, SOURCE_RANK.get(s.source, 0))
            for s in signals
            if s.kind in (SIGNAL_INSIGHT, SIGNAL_USER_CORRECTION)
        ]
        if not ranked:
            ranked = [(s, SOURCE_RANK.get(s.source, 0)) for s in signals]
        source = max(ranked, key=lambda item: item[1])[0].source if ranked else "model"
        message = str((data.get("insight") or {}).get("message") or "").strip()
        return KnowledgeEntry(
            id=f"insight:g:{uuid.uuid4().hex[:12]}",
            level=LEVEL_WORK,
            kind=KIND_INSIGHT,
            data=data,
            source=source,
            credibility=default_credibility(source),
            title=message[:60] or "孵化知识",
            tags=("孵化", source),
        )

    # ── 诊断侧：只读快照 ──

    def snapshot(self) -> dict[str, Any]:
        """成长状态只读快照（孵化中信号/知识集规模/闸门通过率）。"""
        denom = max(self.gate_checked, 1)
        knowledge_count = 0
        try:
            knowledge_count = len(self.knowledge_set.entries())
        except Exception:
            knowledge_count = 0
        return {
            "enabled": self.config.enabled,
            "incubating_signals": len(self._buffer),
            "collected_total": self.collected_total,
            "knowledge_count": knowledge_count,
            "gate_checked": self.gate_checked,
            "gate_passed": self.gate_passed,
            "gate_pass_rate": round(self.gate_passed / denom, 4),
            "landed": self.landed,
            "last_flush_note": self.last_flush_note,
            "last_landed_at": self._last_landed_at,
        }


def _source_from_event(event: EngineEvent) -> str:
    """事件来源派生：评审决议类事件 = 用户来源；其余取负载声明。"""
    payload = event.payload or {}
    source = payload.get("source")
    if isinstance(source, str) and source in SOURCE_RANK:
        return source
    if event.type in ("accept", "edit", "reject", "user_correction"):
        return "user"
    return "model"


__all__ = [
    "_EMPTY_FIXTURES",
    "_INSIGHT_SCHEMA",
    "GrowthConfig",
    "GrowthPipeline",
]
