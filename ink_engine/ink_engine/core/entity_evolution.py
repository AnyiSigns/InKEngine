"""实体演化闭环（失败信号 → 变异 → 三层闸门 → 严格更优替换 → 晋升）。

协作者目录的自学习机制（镜像知识孵化管线，机制件复用；后台运行，
不弹人工卡——自我进化不是审批面）：

- **观察侧**：实现 :class:`EngineTransport`，从回合事件流中提取实体
  关联失败信号——``collab_request`` 召唤调用失败（tool_start 记忆
  调用参数 → tool_end 失败归因到具体实体），或负载 ``context`` 显式
  携带 ``entity_id`` 的失败事件；其余事件忽略（实体演化只关心实体
  相关失败）；
- **缓冲侧**：按实体聚合孵化缓冲（同因去重经教训指纹）；变异后实体
  进入干净回合计数（晋升判据：连续 N 回合零归因失败）；
- **触发侧**：实现 :class:`~ink_engine.core.settle.SettleHook`，回合
  收尾按需变异（实体缓冲失败信号 ≥ 阈值即尝试变异）与晋升判定；
- **变异侧**：确定性基线把失败信号蒸馏为「执行教训」块追加进 persona
  （教训指纹去重——同因重复不再追加，防 persona 无界膨胀；教训文本
  截断有界，教训条数上限可配）；LLM 精修为可选扩展回调；
- **闸门侧**：变异产物过三层闸门——L1 实体声明合法（可构造/身份保留
  /模型引用）+ 教训增量指令注入扫描（复用 :class:`KnowledgeGate`
  的注入检测与 L1 判定）/ L2 结构一致性（变异无规则执行语义，确定性
  放行 + 留痕）/ L3 教训覆盖严格更优才替换（复用 L3 判定：coverage
  严格增才落位，等价版本不替换——同因重复天然被拒）；
- **落位侧**：闸门全过经 :class:`EvolutionWriter`（kind="entity"）
  写注册表实时数据 + 演化补丁链 + 审计留痕，注册表换入新版本
  （:meth:`EntityRegistry.replace`——旧版留链历史可回退）；
- **晋升侧**：实体变异后连续 N 回合零归因失败 → 层级晋升（工作 →
  项目 → 用户，复用知识层级语义；身份 id 跨层级稳定）；
- **事件侧**：``signal_detected`` / ``distill_outcome`` / ``gate_verdict``
  / ``entity_mutated`` / ``entity_promoted`` 事件（注入 ``emit`` 回调
  转发引擎事件流——前端演化页签实时数据面；未注入 = 静默）；
- **诊断侧**：``snapshot()`` 只读暴露各实体演化状态（无任何可操作项）。
"""
from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any, Callable

from .entities import EntityRegistry, EntitySpec
from .events import EngineEvent
from .evolution_writer import EvolutionWriter
from .knowledge_gate import (
    GateL1Result,
    GateL2Result,
    GateL3Result,
    KnowledgeGate,
)
from .knowledge_set import (
    KIND_INSIGHT,
    LEVEL_PROJECT,
    LEVEL_USER,
    LEVEL_WORK,
    KnowledgeEntry,
)
from .knowledge_signals import (
    SIGNAL_PITFALL,
    SOURCE_RANK,
    ExecutionSignal,
    SignalClassifier,
)
from .logging import get_logger

logger = get_logger(__name__)

# 协作者召唤工具名（宿主声明式工具；tool_start/tool_end 归因锚）
COLLAB_TOOL_NAME = "collab_request"

# 孵化缓冲上限（按实体跨回合累积但有界：超限丢最旧——防长时间无
# 变异触发时内存膨胀；正常会话远低于此）
_MAX_INCUBATING = 64

# 教训文本截断上限（persona 追加面有界：单条教训只取摘要）
_LESSON_CHAR_LIMIT = 160

# 实体 persona 内常驻教训条数上限（无界追加会让 persona 无限膨胀；
# 达上限后新教训不再追加——变异被 L3 严格更优判定自然拒绝）
_MAX_PERSONA_LESSONS = 16

# 层级晋升方向（工作 → 项目 → 用户；顺序固定，与知识集同语义）
_LEVEL_ORDER = {LEVEL_WORK: 0, LEVEL_PROJECT: 1, LEVEL_USER: 2}


@dataclass(frozen=True, slots=True)
class EntityEvolutionConfig:
    """实体演化管线配置（出厂默认开启；无用户可操作项）。

    Attributes:
        enabled: 观察/变异/晋升全链路开关（False = 回到「无实体演化」
            基线，与自学习管线开关同语义）。
        mutate_threshold: 单实体变异触发阈值（缓冲失败信号 ≥ 该值才
            尝试变异；保守默认 1——同因去重与 L3 严格更优判定已防反复
            无效变异）。
        promotion_rounds: 晋升所需连续零失败回合数（变异后计数）。
    """

    enabled: bool = True
    mutate_threshold: int = 1
    promotion_rounds: int = 3


@dataclass(frozen=True, slots=True)
class EntityMutationResult:
    """一次实体变异的产物（新声明 + 新增教训数；供闸门与落位使用）。"""

    spec: EntitySpec
    new_lessons: int = 0


class EntityMutationGate:
    """实体变异三层闸门（L1 声明+注入 / L2 结构一致 / L3 严格更优）。

    复用 :class:`KnowledgeGate` 的判定件（注入扫描 / L1 组合 / L3
    目标筛选），按实体形态适配：
    - L1：教训增量（persona 的新增面）过指令注入扫描 + 实体声明可构造
      / 身份保留 / 模型引用三项安全扫描（persona 旧面在创建/先前变异
      时已过审，不重复扫描全量——防熵启发对长中文混英文 persona 误伤）；
    - L2：变异无规则执行语义——确定性放行 + 留痕（结构一致性已在 L1
      声明可构造关覆盖）；
    - L3：教训覆盖严格增（``coverage`` 维度）才替换，等价版本拒绝
      （同因重复天然不过）。
    """

    def __init__(self, gate: KnowledgeGate | None = None) -> None:
        self._gate = gate or KnowledgeGate(human_review_enabled=False)

    async def check(
        self,
        mutated: EntitySpec,
        current: EntitySpec,
        *,
        new_coverage: int,
        old_coverage: int,
        lesson_text: str,
    ) -> tuple[GateL1Result, GateL2Result, GateL3Result]:
        """变异三层闸门（短路语义与 KnowledgeGate.check 对齐）。

        Returns:
            (l1, l2, l3)：三层结果；l1 不过时 l2/l3 为未执行占位。
        """
        entry = KnowledgeEntry(
            id=f"entity:{mutated.id}",
            level=LEVEL_WORK,
            kind=KIND_INSIGHT,
            data={"persona_delta": lesson_text},
            source="model",
            title=f"实体演化:{mutated.id}",
            tags=("entity", "evolution"),
        )
        l1 = self._gate.check_l1(
            entry=entry,
            schema=_delta_schema(),
            security_scan={
                "实体声明可构造": self._constructible(mutated),
                "身份保留": mutated.id == current.id,
                "模型引用合法": self._model_ok(mutated),
            },
        )
        if not l1.passed:
            return (
                l1,
                GateL2Result(passed=False, note="L1 未通过（短路）"),
                GateL3Result(passed=False, reason="L1 未通过（短路）"),
            )
        l2 = GateL2Result(
            passed=True,
            note="实体变异无规则执行语义（L2 结构一致性校验通过）",
        )
        l3 = self._gate.check_l3(
            {"coverage": float(new_coverage), "safety": 1.0},
            {"coverage": float(old_coverage), "safety": 1.0},
            diversity=False,
        )
        return l1, l2, l3

    @staticmethod
    def _constructible(spec: EntitySpec) -> bool:
        """实体声明可构造（变异产物能重新加载 = 声明层面合法）。"""
        try:
            EntitySpec.from_dict(spec.to_dict())
            return True
        except Exception:
            return False

    @staticmethod
    def _model_ok(spec: EntitySpec) -> bool:
        """模型引用合法（None = 会话默认模型；声明形态须成对）。"""
        if spec.model is None:
            return True
        return bool(spec.model.get("provider") and spec.model.get("model_id"))


class EntityEvolutionPipeline:
    """实体演化闭环：回合事件 → 实体失败信号缓冲 → 按需变异 → 三层
    闸门 → 严格更优替换 → 晋升。

    同一实例同时实现 :class:`EngineTransport`（观察事件流）与
    :class:`~ink_engine.core.settle.SettleHook`（回合收尾触发），由
    Runtime 装配注入（镜像自学习管线装配：观察侧注册进 RunOptions
    transports，触发侧注册进 settle 钩子链）。

    故障隔离：观察/触发全程吞异常（观测不影响执行、演化失败不阻断
    run 结果交付——与 settle 钩子语义一致）。
    """

    def __init__(
        self,
        registry: EntityRegistry,
        writer: EvolutionWriter | None = None,
        *,
        config: EntityEvolutionConfig | None = None,
        mutate: Callable[..., Any] | None = None,
        emit: Callable[[str, dict], Any] | None = None,
    ) -> None:
        self.config = config or EntityEvolutionConfig()
        self.registry = registry
        self.writer = writer
        # LLM 变异回调（可选扩展：(entity, signals) -> dict | None；
        # None = 确定性基线——失败信号蒸馏为教训块追加 persona）
        self._mutate = mutate
        self._emit = emit
        self._classifier = SignalClassifier()
        self._gate = EntityMutationGate()
        # 实体 → 孵化缓冲（跨回合累积；变异后清空）
        self._entity_signals: dict[str, list[ExecutionSignal]] = {}
        # 待发射的信号检测队列（观察侧只入队，回合收尾 settle 锁外批量
        # 发射——避免在引擎传输锁内重入 publish 死锁）
        self._pending_signal_events: list[ExecutionSignal] = []
        # collab_request 调用归因记忆（tool_call_id → entity_id；tool_end
        # 消费即弹出，防止映射无界增长）
        self._collab_calls: dict[str, str] = {}
        # 干净回合计数（变异后实体进入计数；零失败递增，归因失败清零）
        self._clean_rounds: dict[str, int] = {}
        # 诊断计数（只读快照的数据面）
        self.collected_total = 0  # 累计收集实体关联信号数
        self.mutation_attempts = 0  # 变异尝试次数
        self.mutation_passed = 0  # 变异过闸落位数
        self.mutation_rejected = 0  # 变异未过闸/无新教训数
        self.promotions = 0  # 晋升次数
        self.last_flush_note = "实体演化管线就绪（默认开启，回合收尾按需变异）"
        self._last_mutated_at: float | None = None

    # ── 事件发射（演化动态 → 前端演化页签）──

    def set_emit(self, emit: Callable[[str, dict], Any] | None) -> None:
        """注入事件发射回调（引擎装配后接引擎事件流；None = 静默）。"""
        self._emit = emit

    async def _publish(self, etype: str, payload: dict) -> None:
        """发射演化事件（注入回调转发；异常忽略——观测不阻断演化）。"""
        if self._emit is None:
            return
        try:
            await self._emit(etype, payload)
        except Exception as exc:
            logger.warning("实体演化事件发射失败（忽略）: %s: %s", etype, exc)

    async def _emit_signal_detected(self, signal: ExecutionSignal) -> None:
        await self._publish(
            "signal_detected",
            {
                "signal_id": self._signal_id(signal),
                "signal_type": signal.kind,
                "signal": signal.message,
                "source": signal.source,
                "entity_id": signal.context.get("entity_id"),
            },
        )

    async def _emit_distill_outcome(
        self, signal: ExecutionSignal, lesson_text: str
    ) -> None:
        await self._publish(
            "distill_outcome",
            {
                "signal_id": self._signal_id(signal),
                "distilled": lesson_text or "变异产物（确定性基线）",
            },
        )

    async def _emit_gate_verdict(
        self, signal: ExecutionSignal, *, passed: bool, reason: str
    ) -> None:
        await self._publish(
            "gate_verdict",
            {
                "signal_id": self._signal_id(signal),
                "passed": passed,
                "level": "L1/L2/L3",
                "reason": reason or ("已放行" if passed else "未通过闸门"),
            },
        )

    async def _emit_entity_mutated(self, spec: EntitySpec) -> None:
        evolved = spec.meta.get("evolution") or {}
        await self._publish(
            "entity_mutated",
            {
                "entity_id": spec.id,
                "version": int(evolved.get("version") or 0),
                "level": evolved.get("level") or LEVEL_WORK,
                "coverage": int(evolved.get("addressed_count") or 0),
            },
        )

    async def _emit_entity_promoted(self, spec: EntitySpec, from_level: str) -> None:
        evolved = spec.meta.get("evolution") or {}
        await self._publish(
            "entity_promoted",
            {
                "entity_id": spec.id,
                "from_level": from_level,
                "to_level": evolved.get("level") or LEVEL_WORK,
            },
        )

    @staticmethod
    def _signal_id(signal: ExecutionSignal) -> str:
        """信号稳定 id（同因聚合后仍可关联：kind+实体+消息摘要指纹）。"""
        entity_id = signal.context.get("entity_id") or "-"
        return (
            f"sig:{signal.kind}:{entity_id}:"
            f"{abs(hash((signal.kind, entity_id, signal.message))) % 10**8}"
        )

    # ── 观察侧：回合事件 → 实体关联失败信号 ──

    async def send(self, event: EngineEvent) -> None:
        """EngineTransport：观察回合事件流（观测不阻断执行）。"""
        if not self.config.enabled:
            return
        try:
            await self._observe(event)
        except Exception as exc:
            logger.warning("实体演化管线事件观察失败（忽略）: %s", exc)

    async def _observe(self, event: EngineEvent) -> None:
        payload = event.payload or {}
        if event.type == "tool_start":
            self._remember_collab_call(payload)
            return
        entity_id = self._entity_for(event.type, payload)
        if entity_id is None:
            return
        if event.type == "tool_end" and payload.get("success") is False:
            signal = ExecutionSignal(
                kind=SIGNAL_PITFALL,
                message=str(payload.get("message") or "工具执行失败")
                or f"工具执行失败: {payload.get('tool') or ''}",
                source=_source_from_event(event),
                context={"entity_id": entity_id, **dict(payload)},
            )
        else:
            signal = self._classifier.classify(
                {
                    "type": event.type,
                    "message": payload.get("message"),
                    "source": _source_from_event(event),
                    "context": {"entity_id": entity_id, **dict(payload)},
                }
            )
            if signal is None:
                return
        self._buffer_for(entity_id, signal)

    def _remember_collab_call(self, payload: dict) -> None:
        """记忆 collab_request 调用的实体归因（tool_start → tool_end）。"""
        if payload.get("tool") != COLLAB_TOOL_NAME:
            return
        args = payload.get("args")
        if not isinstance(args, dict):
            return
        entity_id = args.get("entity_id")
        if not isinstance(entity_id, str) or not entity_id:
            return
        call_id = str(payload.get("tool_call_id") or "")
        if not call_id:
            return
        if len(self._collab_calls) >= _MAX_INCUBATING:
            self._collab_calls.pop(next(iter(self._collab_calls)))
        self._collab_calls[call_id] = entity_id

    def _entity_for(self, etype: str, payload: dict) -> str | None:
        """事件 → 实体归因（None = 无实体关联，实体演化不关心）。"""
        if etype == "tool_end":
            call_id = payload.get("tool_call_id")
            if isinstance(call_id, str) and call_id:
                return self._collab_calls.pop(call_id, None)
        context = payload.get("context")
        if isinstance(context, dict):
            entity_id = context.get("entity_id")
            if isinstance(entity_id, str) and entity_id:
                return entity_id
        return None

    def _buffer_for(self, entity_id: str, signal: ExecutionSignal) -> None:
        """按实体入缓冲（有界：超限丢最旧）。"""
        buffer = self._entity_signals.setdefault(entity_id, [])
        buffer.append(signal)
        if len(buffer) > _MAX_INCUBATING:
            buffer.pop(0)
        self.collected_total += 1
        self._pending_signal_events.append(signal)

    # ── 触发侧：回合收尾按需变异 + 晋升判定 ──

    async def settle(self, ctx: Any) -> None:
        """SettleHook：回合收尾（实体变异 + 晋升判定）。"""
        if not self.config.enabled:
            return
        try:
            await self.flush_round()
        except Exception as exc:
            logger.warning("实体演化管线回合收尾失败（忽略）: %s", exc)

    async def flush_round(self) -> None:
        """回合收尾刷新：缓冲信号按实体变异 → 三层闸门 → 落位 + 晋升。"""
        pending = self._pending_signal_events
        self._pending_signal_events = []
        for signal in pending:
            await self._emit_signal_detected(signal)
        failed_this_round = {
            signal.context.get("entity_id")
            for signal in pending
            if isinstance(signal.context.get("entity_id"), str)
        }
        for entity_id in list(self._clean_rounds):
            if entity_id not in failed_this_round and entity_id in self.registry.names():
                self._clean_rounds[entity_id] += 1
            else:
                self._clean_rounds.pop(entity_id, None)
        for entity_id in sorted(failed_this_round):
            await self._try_mutate(entity_id)
        for entity_id in list(self._clean_rounds):
            if self._clean_rounds[entity_id] >= self.config.promotion_rounds:
                await self._try_promote(entity_id)

    # ── 变异侧：失败信号 → 变异声明（确定性基线）──

    def _derive_mutation(
        self, spec: EntitySpec, signals: list[ExecutionSignal]
    ) -> EntityMutationResult | None:
        """失败信号 → 变异声明（教训指纹去重；无可沉淀 = None）。

        确定性基线（零 LLM）：失败信号消息摘要追加进 persona 的
        「已知教训」块——同因重复（指纹命中既有教训）不再追加，防
        persona 无界膨胀；达教训条数上限同样不变异。
        """
        evolved = dict(spec.meta or {}).get("evolution") or {}
        existing = {
            str(item.get("fingerprint") or "")
            for item in evolved.get("lessons") or []
            if isinstance(item, dict)
        }
        if len(existing) >= _MAX_PERSONA_LESSONS:
            return None
        new_lessons: list[tuple[str, str]] = []
        for signal in signals:
            text = str(signal.message or "").strip()
            if not text:
                continue
            fingerprint = _lesson_fingerprint(text)
            if fingerprint in existing:
                continue
            if any(fp == fingerprint for fp, _ in new_lessons):
                continue
            new_lessons.append((fingerprint, text[:_LESSON_CHAR_LIMIT]))
        if not new_lessons:
            return None
        lesson_items = [
            dict(item) for item in evolved.get("lessons") or []
        ]
        lesson_items.extend(
            {"fingerprint": fp, "text": text} for fp, text in new_lessons
        )
        lesson_block = "\n".join(f"- {item['text']}" for item in lesson_items)
        persona = spec.persona
        if persona:
            persona = f"{persona}\n\n已知教训：\n{lesson_block}"
        else:
            persona = f"已知教训：\n{lesson_block}"
        new_meta = dict(spec.meta or {})
        evolution = {
            "version": int(evolved.get("version") or 0) + 1,
            "level": evolved.get("level") or LEVEL_WORK,
            "lessons": lesson_items,
            "addressed_count": int(evolved.get("addressed_count") or 0)
            + len(new_lessons),
            "mutations": int(evolved.get("mutations") or 0) + 1,
            "last_mutation_at": time.time(),
        }
        new_meta["evolution"] = evolution
        mutated = EntitySpec(
            id=spec.id,
            label=spec.label,
            persona=persona,
            model=spec.model,
            meta=new_meta,
        )
        return EntityMutationResult(spec=mutated, new_lessons=len(new_lessons))

    async def _try_mutate(self, entity_id: str) -> bool:
        """尝试变异单实体（缓冲不足/无新教训/未过闸 = 不变异）。"""
        signals = self._entity_signals.get(entity_id) or []
        if len(signals) < self.config.mutate_threshold:
            return False
        spec = self.registry.get(entity_id)
        if spec is None:
            # 实体已废弃：清缓冲（归因到已删除实体不演化）
            self._entity_signals.pop(entity_id, None)
            return False
        if self._mutate is not None:
            mutation = self._mutate(spec, signals)
            result = (
                EntityMutationResult(
                    spec=EntitySpec.from_dict(mutation), new_lessons=0
                )
                if isinstance(mutation, dict)
                else None
            )
        else:
            result = self._derive_mutation(spec, signals)
        self.mutation_attempts += 1
        if result is None:
            self.mutation_rejected += 1
            self._entity_signals.pop(entity_id, None)
            self.last_flush_note = (
                f"实体 {entity_id}: 无新教训（同因去重，不变异）"
            )
            return False
        evolved = spec.meta.get("evolution") or {}
        old_coverage = int(evolved.get("addressed_count") or 0)
        new_coverage = old_coverage + result.new_lessons
        lesson_text = "\n".join(
            str(item.get("text") or "")
            for item in result.spec.meta["evolution"]["lessons"]
        )
        anchor = signals[0]
        await self._emit_distill_outcome(anchor, lesson_text)
        l1, l2, l3 = await self._gate.check(
            result.spec,
            spec,
            new_coverage=new_coverage,
            old_coverage=old_coverage,
            lesson_text=lesson_text,
        )
        self._entity_signals.pop(entity_id, None)
        if l1.passed and l2.passed and l3.passed:
            if await self._apply_mutation(entity_id, result.spec):
                self.mutation_passed += 1
                self._clean_rounds[entity_id] = 0
                self._last_mutated_at = time.time()
                version = result.spec.meta["evolution"]["version"]
                self.last_flush_note = (
                    f"实体 {entity_id} 变异过闸落位（version {version}）"
                )
                await self._emit_gate_verdict(
                    anchor, passed=True, reason=l3.reason
                )
                await self._emit_entity_mutated(result.spec)
                return True
            self.mutation_rejected += 1
            self.last_flush_note = (
                f"实体 {entity_id} 变异落位失败（写入未生效，不变更）"
            )
            return False
        self.mutation_rejected += 1
        self.last_flush_note = f"实体 {entity_id} 变异未过闸（{l3.reason}）"
        await self._emit_gate_verdict(anchor, passed=False, reason=l3.reason)
        return False

    async def _apply_mutation(self, entity_id: str, spec: EntitySpec) -> bool:
        """变异落位：演化写入管线（补丁链+实时写+审计）+ 注册表换入。

        无写入器（writer=None，测试/无存储态）= 仅注册表内存态换入。
        """
        try:
            if self.writer is not None:
                await self.writer.write(
                    self.registry.collection,
                    entity_id,
                    spec.to_dict(),
                    kind="entity",
                    asset_id=entity_id,
                    note=(
                        f"实体演化：失败信号驱动变异"
                        f"（version {spec.meta['evolution']['version']}）"
                    ),
                )
            self.registry.replace(spec)
            return True
        except Exception as exc:
            logger.warning("实体变异落位失败（跳过）: %s: %s", entity_id, exc)
            return False

    # ── 晋升侧：变异后连续 N 回合零失败 → 层级晋升 ──

    async def _try_promote(self, entity_id: str) -> None:
        """晋升尝试：变异后稳定（连续零失败）→ 工作 → 项目 → 用户。"""
        if self.writer is None:
            return
        spec = self.registry.get(entity_id)
        if spec is None:
            self._clean_rounds.pop(entity_id, None)
            return
        evolved = dict(spec.meta or {}).get("evolution") or {}
        level = evolved.get("level") or LEVEL_WORK
        if level == LEVEL_USER:
            self._clean_rounds.pop(entity_id, None)
            return
        if _LEVEL_ORDER.get(level, 0) >= _LEVEL_ORDER[LEVEL_USER]:
            return
        next_level = LEVEL_PROJECT if level == LEVEL_WORK else LEVEL_USER
        new_meta = dict(spec.meta or {})
        new_evolution = dict(evolved)
        new_evolution["level"] = next_level
        new_meta["evolution"] = new_evolution
        upgraded = EntitySpec(
            id=spec.id,
            label=spec.label,
            persona=spec.persona,
            model=spec.model,
            meta=new_meta,
        )
        try:
            await self.writer.write(
                self.registry.collection,
                entity_id,
                upgraded.to_dict(),
                kind="entity",
                asset_id=entity_id,
                note=f"实体晋升：{level} → {next_level}",
            )
        except Exception as exc:
            logger.warning("实体晋升写入失败（跳过）: %s: %s", entity_id, exc)
            return
        self.registry.replace(upgraded)
        self.promotions += 1
        self._clean_rounds.pop(entity_id, None)
        self.last_flush_note = (
            f"实体 {entity_id} 晋升 {next_level}"
            f"（连续 {self.config.promotion_rounds} 回合零失败）"
        )
        await self._emit_entity_promoted(upgraded, level)

    # ── 诊断侧：只读快照 ──

    def snapshot(self) -> dict[str, Any]:
        """演化状态只读快照（各实体演化态 + 全局计数，无可操作项）。"""
        entities: dict[str, dict[str, Any]] = {}
        for entity_id in sorted(self.registry.names()):
            spec = self.registry.get(entity_id)
            evolved = (
                (spec.meta or {}).get("evolution") or {}
                if spec is not None
                else {}
            )
            entities[entity_id] = {
                "level": evolved.get("level") or LEVEL_WORK,
                "version": int(evolved.get("version") or 0),
                "lessons": len(evolved.get("lessons") or []),
                "clean_rounds": self._clean_rounds.get(entity_id, 0),
                "incubating_signals": len(
                    self._entity_signals.get(entity_id) or []
                ),
            }
        return {
            "enabled": self.config.enabled,
            "collected_total": self.collected_total,
            "mutation_attempts": self.mutation_attempts,
            "mutation_passed": self.mutation_passed,
            "mutation_rejected": self.mutation_rejected,
            "promotions": self.promotions,
            "entities": entities,
            "last_flush_note": self.last_flush_note,
        }


def _delta_schema():
    """教训增量的 L1 schema（persona_delta 字段关；注入扫描兜底）。"""
    from .schema_validator import SchemaField, SchemaSpec

    return SchemaSpec(
        name="entity.evolution",
        fields=(
            SchemaField(name="id", required=True, kind="string"),
            SchemaField(name="level", required=True, kind="string"),
            SchemaField(name="kind", required=True, kind="string"),
            SchemaField(name="data", required=True, kind="dict"),
        ),
    )


def _lesson_fingerprint(message: str) -> str:
    """教训指纹（同因去重锚：归一化消息摘要，跨呈现形态稳定）。"""
    normalized = " ".join(str(message).lower().split())
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:12]


def _source_from_event(event: EngineEvent) -> str:
    """事件来源派生（评审决议类事件 = 用户来源；其余取负载声明）。"""
    payload = event.payload or {}
    source = payload.get("source")
    if isinstance(source, str) and source in SOURCE_RANK:
        return source
    if event.type in ("accept", "edit", "reject", "user_correction"):
        return "user"
    return "model"


__all__ = [
    "COLLAB_TOOL_NAME",
    "EntityEvolutionConfig",
    "EntityEvolutionPipeline",
    "EntityMutationGate",
    "EntityMutationResult",
]
