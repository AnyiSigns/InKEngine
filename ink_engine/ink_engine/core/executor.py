"""执行引擎：run 执行循环（图执行/checkpoint 版本链/interrupt 原语）。

单循环状态机：取当前节点 → 执行（节点内 ctx.emit 发射事件）→ 增量按
reducer 合并 → checkpoint 快照 → 条件边选下一节点 → 终止/出口。无
Pregel 中间状态；每节点完成写一次快照（版本链），回路任意点可恢复。

恢复/续流：checkpoint 版本链 + 执行事件日志（append-only）——恢复 =
读取 checkpoint 快照 + 增量日志重放（断线续流）；编辑重放 = 日志截断 +
新分支（truncate_log_after + parent_checkpoint 参数）。

终止信号：节点可返回终止标记（reply/止损/超限/异常），引擎结束本轮
run 并记录终止原因（入 checkpoint 轨迹与 RunResult）。"终止 vs 续跑"
的判定由条件边表达（业务策略），引擎只提供机制。

嵌套图：子图 = 图实例节点（graph.py add_subgraph），子图事件经共享
publish 通道自然汇入父事件流（graph_path 记录路径），子图最终状态
整体回流父图 reducer 合并（输出回流内建，绝不静默丢值）。

白名单审计：``RunOptions.system_events``（系统信号集合）= **装配数据化**
——由装配合成注入（EventTypeRegistry.system_events），模块级常量默认空，
注册表是动态化的正式载体。
"""
from __future__ import annotations

import asyncio
import inspect
import time
import uuid
from collections.abc import AsyncGenerator, Mapping
from dataclasses import dataclass, field, replace
from typing import Any

from .assembly import (
    AssemblyResult,
    InputAssembler,
)
from .chain_rebase import maybe_compact_chain
from .events import EngineEvent, EngineTransport
from .exceptions import (
    BudgetExceededError,
    GraphDefinitionError,
    NodeExecutionError,
    SimulationError,
)
from .fanout import fan_out
from .graph import Graph, NodeContext, TerminateReason
from .interrupt import InterruptCoordinator, InterruptSignal, InterruptState
from .llm.guard import current_node_context
from .logging import get_logger, trace_id_var
from .multipath import MULTIPATH_KEY
from .plan import (
    KIND_NODES,
    KIND_PARALLEL,
    KIND_SPAWNS,
    PLAN_KEY,
    Plan,
    PlanStep,
)
from .recovery import resolve_resume, tail_checkpoint
from .run_result import RunOptions, RunResult  # 结果契约/执行选项（独立模块）
from .security import strip_sensitive
from .settle import (
    TRACE_FAILED,
    TRACE_SKIPPED,
    TRACE_SUCCESS,
    SettleContext,
    TraceStep,
)
from .simulation import (
    SIMULATE_KEY,
    BestBranchMixer,
    BranchSelection,
    EvaluatedBranch,
    ProvenanceNote,
    SimulateSpec,
    SimulationResult,
    parse_simulate,
    simulate_thread_id,
)
from .spawn import (
    SPAWN_KEY,
    SpawnFailure,
    SpawnResult,
    SpawnSpec,
    collect_spawn_specs,
    instance_entry_state,
    instance_thread_id,
)
from .state import StateSchema, is_merge_reducer, subgraph_overlay_delta
from .storage import ChainLink, CheckpointRecord, Storage

logger = get_logger(__name__)

# ── input_assembly 事件体裁剪（事件降频）─────────────────────────
# 激活留痕事件不携带全量源元数据：保留条数上限 + 标题长度上限——事件流
# 体积有界（每源条目只是元数据行，但高源数下累积可观），可回放审计性
# 不受影响（被裁条目语义 = 更多源，重建口径与全量一致）。
_INPUT_ASSEMBLY_EVENT_MAX_SOURCES = 16
_INPUT_ASSEMBLY_EVENT_MAX_TITLE_CHARS = 120


def _input_assembly_event_record(record: Any) -> dict:
    """激活记录 → 事件负载（体裁剪：源条数上限 + 标题截断）。

    Args:
        record: ActivationRecord（assembly 模块激活模式记录）。
    """
    data = record.to_dict()
    sources = [s for s in data.get("sources") or () if isinstance(s, dict)]
    if len(sources) > _INPUT_ASSEMBLY_EVENT_MAX_SOURCES:
        data["sources"] = sources[:_INPUT_ASSEMBLY_EVENT_MAX_SOURCES]
        data["sources_more"] = len(sources) - _INPUT_ASSEMBLY_EVENT_MAX_SOURCES
    for source in data.get("sources") or ():
        title = source.get("title")
        if isinstance(title, str) and len(title) > _INPUT_ASSEMBLY_EVENT_MAX_TITLE_CHARS:
            source["title"] = title[:_INPUT_ASSEMBLY_EVENT_MAX_TITLE_CHARS] + "…"
    return data


class _QueueTransport:
    """内部传输：事件 → asyncio.Queue（顶层 run 的流式产出通道）。"""

    def __init__(self, queue: asyncio.Queue[EngineEvent]) -> None:
        self._queue = queue

    async def send(self, event: EngineEvent) -> None:
        await self._queue.put(event)


@dataclass(slots=True)
class _PlanAdvance:
    """计划游标推进结果（计划步执行/取节点的控制流传递）。

    Attributes:
        node: 待执行的下一节点（None = 无节点产出——计划耗尽或已终止）。
        plan: 推进后的计划（None = 计划耗尽/终止——转边定位或收尾）。
        state: 合并后的状态（并行/spawn 步回流已并入）。
        reason: 终止原因（计划步内 terminate/预算超限/错误，None = 正常推进）。
        error: 错误消息（reason=error 时）。
        interrupt: 计划步内中断（并行成员/spawn 实例挂起，None = 无）。
        parent_id: 链写状态（计划步 checkpoint 后的新父锚点）。
        fork_write: 链写状态（分叉首写标志，写入后复位 False）。
    """

    node: str | None = None
    plan: Plan | None = None
    state: dict = field(default_factory=dict)
    reason: str | None = None
    error: str | None = None
    interrupt: InterruptState | None = None
    parent_id: int | None = None
    fork_write: bool = False


@dataclass(slots=True)
class _PlanWorkOutcome:
    """计划工作步（并行组/spawn）的执行结果与控制流信号。

    overlay 与三种控制流信号互斥：有信号 = 本步未完成（主循环终止），
    无信号 = 本步完成（overlay 可并入状态）。
    """

    overlay: dict = field(default_factory=dict)
    terminate: str | None = None
    interrupt: InterruptState | None = None
    error: str | None = None


class _NodeContextImpl(NodeContext):
    """执行器注入的节点上下文（emit/interrupt/terminate 挂载引擎 publish）。"""

    def __init__(
        self,
        engine: Engine,
        state: dict,
        graph_path: tuple[str, ...],
        round_id: str | None,
        trace_id: str,
        thread_id: str = "-",
        node: str | None = None,
        transports: list[EngineTransport] | None = None,
        resume_map: dict[tuple[str, ...], int] | None = None,
        parent_step_id: str | None = None,
    ) -> None:
        self._engine = engine
        self._state = state
        self._graph_path = graph_path
        self._round_id = round_id
        self._trace_id = trace_id
        self._thread_id = thread_id
        self._transports = transports or engine.options.transports
        self.node = node
        self._terminated: str | None = None
        # 嵌套子图恢复锚点表（graph_path → checkpoint_id）：子图 runner 据此
        # 把锚点传给子图引擎（断线续流落在子图 checkpoint 时的下沉恢复）
        self.resume_map = resume_map or {}
        # 命令式 spawn 收集清单（节点内 ctx.spawn 追加，返回后统一展开）
        self._spawns: list = []
        # 轨迹树父引用：推演分支/子任务事件指向决策点/父任务步骤
        # （落选分支可据此回溯对比/换选）
        self.parent_step_id = parent_step_id
        # 输入调配预装配结果缓存（preassemble 后节点内 assemble 复用）
        self._assembled: AssemblyResult | None = None
        # 节点边界计数（主执行循环每进入一个节点边界累加一次；预算策略
        # 可按 ctx.step_count 按步数终止，无需策略自计数——协议示例
        # 即真实语义。并行组/实例/子图上下文各自独立从零起算）
        self.step_count = 0

    @property
    def state(self) -> dict:
        return self._state

    @property
    def graph_path(self) -> tuple[str, ...]:
        return self._graph_path

    @property
    def thread_id(self) -> str:
        return self._thread_id

    @property
    def round_id(self) -> str | None:
        return self._round_id

    @property
    def trace_id(self) -> str:
        return self._trace_id

    @property
    def terminated(self) -> bool:
        return self._terminated is not None

    @property
    def terminate_reason(self) -> str | None:
        return self._terminated

    async def emit(self, etype: str, payload: dict, *, step_id: str | None = None) -> None:
        """发射事件（事件即协议：负载直接对齐协议 v2，无框架中间层）。

        系统信号（宿主注入的 RunOptions.system_events 命中类型）不入
        回合步骤序列——强制 step_id=None，与事件协议语义对齐。
        """
        if etype in self._engine.options.system_events:
            step_id = None
        await self._engine._publish(
            EngineEvent(
                type=etype,
                payload=payload,
                step_id=step_id,
                parent_step_id=self.parent_step_id,
                round_id=self._round_id,
                node=self.node,
                graph_path=self._graph_path,
                trace_id=self._trace_id,
                thread_id=self._thread_id,
            ),
            transports=self._transports,
        )

    async def interrupt(self, review_key: str, payload: dict) -> Any:
        """声明中断点：无注入值时挂起（InterruptSignal 被引擎捕获持久化）；
        外部注入后重入，本调用返回注入值，节点继续执行剩余逻辑。
        """
        if self._engine._coordinator.has_inject(review_key):
            return self._engine._coordinator.consume(review_key)
        raise InterruptSignal(review_key, payload)

    async def get_interrupt_payload(self, review_key: str) -> dict | None:
        """读取链尾挂起卡负载（重入场景）：链尾中断 checkpoint 的 key 匹配
        时返回卡负载（审批超时窗口等挂起时状态），否则 None。
        """
        if self._engine.options.storage is None:
            return None
        latest = await self._engine.options.storage.get_latest_checkpoint(
            self._thread_id
        )
        if (
            latest is not None
            and latest.interrupt is not None
            and latest.interrupt.key == review_key
        ):
            return latest.interrupt.payload
        return None

    def spawn(self, subgraph, state: dict, *, index: int | None = None) -> None:
        """命令式子任务收集（便捷封装）：登记一个子图实例清单项。

        与数据驱动形态（节点返回值携带 ``__spawn__`` 键）等价——引擎在
        节点返回后统一展开收集的清单。index 缺省按收集顺序自动分配。
        """
        self._spawns.append(
            SpawnSpec(subgraph=subgraph, state=dict(state), index=index if index is not None else len(self._spawns))
        )

    async def assemble(
        self,
        sources: list,
        *,
        total_budget: int | None = None,
        version_snapshot: dict | None = None,
    ) -> AssemblyResult:
        """输入调配统一入口（执行语义接线）：多源统一预算分配 → 组装。

        每次 LLM 调用/节点执行前经此统一调配（上下文+知识+工具+记忆+
        证据），预算合计不超调用点总预算；激活记录（源/权重/预算/版本
        快照）随 input_assembly 事件落执行日志——模型可见皆留痕，可回放
        可审计。预装配（preassemble）已装配时直接复用缓存结果——不
        重复装配也不重复留痕。未启用（RunOptions.assembly=None）或关闭
        （enabled=False）时抛 GraphDefinitionError——调用点 catch 后
        回退旧装配路径（一键开关语义）。
        """
        if self._assembled is not None:
            return self._assembled
        assembler = self._engine._assembler
        if assembler is None:
            raise GraphDefinitionError(
                "输入调配未启用（RunOptions.assembly=None），调用点应走旧装配路径"
            )
        result = assembler.assemble(
            sources,
            total_budget=total_budget,
            version_snapshot=version_snapshot,
        )
        self._assembled = result
        await self.emit(
            "input_assembly",
            {
                "node": self.node,
                # 事件体裁剪（事件降频）：激活留痕保留条数上限 + 标题
                # 截断——事件流不为每条源元数据付全量文本（可回放审计性
                # 不受影响：被裁条目是"更多源"，重建口径与全量一致）
                "record": _input_assembly_event_record(result.record),
            },
        )
        return result

    async def preassemble(self) -> None:
        """节点执行前的统一预装配（执行器节点循环内自动调用）。

        源由 RunOptions.assembly_sources 提供（返回源清单或
        (源清单, 版本快照) 二元组）；装配未启用/无源提供者时静默跳过
        （调用点回退旧路径）。装配结果缓存，节点内 assemble 复用。
        """
        if self._assembled is not None:
            return
        config = self._engine.options.assembly
        provider = self._engine.options.assembly_sources
        if config is None or not config.enabled or provider is None:
            return
        supplied = provider(self)
        if inspect.isawaitable(supplied):
            supplied = await supplied
        if isinstance(supplied, tuple):
            sources, version_snapshot = supplied[0], supplied[1]
        else:
            sources, version_snapshot = supplied, None
        if not sources:
            # 无源可激活 = 无事可调：跳过装配与留痕（空激活记录是噪音）
            return
        await self.assemble(sources, version_snapshot=version_snapshot)

    def terminate(self, reason: str, **meta: Any) -> None:
        """声明终止（校验延迟到执行器检查点：编程错误不被节点异常捕获吞掉）。"""
        self._terminated = reason

    def account_usage(self, usage: dict | None) -> None:
        """结点执行边界 token 计账（LLM usage 帧 → 当前结点，纯算法）。

        usage 帧形态与 LLMChunk.usage 对齐（total_tokens 或
        prompt_tokens + completion_tokens）；记入本 run 的成本账，
        随沉淀钩子按边归集 avg_cost。未调用 = 无成本记录，零影响。
        """
        if not usage or not isinstance(usage, dict):
            return
        tokens = usage.get("total_tokens")
        if tokens is None:
            prompt = usage.get("prompt_tokens")
            completion = usage.get("completion_tokens")
            tokens = (prompt or 0) + (completion or 0)
        try:
            tokens = int(tokens)
        except (TypeError, ValueError):
            return
        if tokens <= 0:
            return
        self._engine._trace_add_tokens(self.graph_path, self.node, tokens)

async def _select_next_node(graph: Graph, ctx: NodeContext, current: str) -> str | None:
    """选择下一节点：静态边直接取；条件边逐条判定（首个为真生效）。

    条件边兼容同步/异步判定（``inspect.isawaitable`` 检测），业务可写
    同步 lambda 或 async 函数，无需关心执行器形态。
    """
    edges = graph.edges.get(current)
    if not edges:
        return None
    for edge in edges:
        if edge.condition is None:
            return edge.target
        try:
            result = edge.condition(ctx)
            if inspect.isawaitable(result):
                result = await result
            if result:
                return edge.target
        except Exception as exc:
            # 条件边判定失败按不满足处理（fail-open 不阻断执行，留痕日志）
            logger.warning(f"条件边判定失败，按不满足处理 [{current}->{edge.target}]: {exc}")
    return None


async def _locate_next(
    graph: Graph, ctx: NodeContext, current: str
) -> tuple[str | None, str | None]:
    """边/出口定位：出口节点 → REPLY 终止；条件边/静态边 → 下一节点。

    Returns:
        (reason, next_node)：reason 非 None = 终止（next_node 恒 None）；
        next_node 非 None = 继续执行该节点；两者皆 None = 图定义不完备
        （无出边且非 exit），按 stop 终止（入轨迹可诊断）。
    """
    if current in graph.exits:
        return TerminateReason.REPLY, None
    nxt = await _select_next_node(graph, ctx, current)
    if nxt is None:
        if current not in graph.exits:
            return TerminateReason.STOP, None
        return TerminateReason.REPLY, None
    return None, nxt


def _node_in_plan_steps(node: str, plan: Plan) -> bool:
    """节点是否属于计划步骤的节点集合（NODES/PARALLEL 步成员）。

    恢复定位的兜底判据（旧存档无显式工作步标记时使用）：中断/异常
    checkpoint 的 node 属于计划步骤节点 = 顺序节点步中断（重入该节点）；
    不属于 = 计划工作步（并行/spawn）中断（重入计划步）。新写 checkpoint
    携带显式 ``work_step`` 标记，不再依赖节点名猜测。
    """
    return any(node in step.nodes for step in plan.steps)


def _plan_snapshot_is_work_step(plan: dict | None) -> bool:
    """计划快照是否带工作步标记（并行组/spawn 步内中断/失败的显式信号）。"""
    return bool(plan) and bool(plan.get("work_step"))


class Engine:
    """引擎实例：Graph + 配置的组装点（业务侧一次构建，多次 run）。

    并发模型：checkpoint 并发写保护在存储层（链尾乐观锁，冲突拒绝/重读），
    同实例并发 run 由存储层与业务层串行化保障。
    """

    def __init__(self, graph: Graph, *, options: RunOptions | None = None) -> None:
        self.graph = graph
        self.options = options or RunOptions()
        # 声明式节点/条件边先经注册表解析（Engine 持有注册表即可解析——
        # 未解析的条件边与声明式节点在编译期被拒绝，绝不静默当静态边
        # 误走/报误导性的入口缺失错误）
        if self.options.registries is not None:
            graph.resolve_conditions(self.options.registries.edges)
            graph.resolve_types(self.options.registries.nodes)
        self.compiled = graph.compile()
        self._coordinator = InterruptCoordinator()
        self._event_counter = 0
        # 事件登记锁：并行节点组（计划步骤）成员并发发射时串行化计数与
        # seq 锚点登记（防丢更新/乱序覆盖导致恢复重放重复事件）
        self._event_lock = asyncio.Lock()
        # 图内容指纹（checkpoint 图版本）：本图执行产生的 checkpoint 均携带，
        # 恢复时与锚点比对（图定义变了 = 恢复语义不保证，拒绝续跑）
        self._graph_digest = graph.digest()
        # 子图引擎缓存（嵌套图/循环/并行场景避免每次执行重复 compile）——
        # 缓存键 = 图内容 digest（ENG2-6）：数据驱动子图每次新建实例时
        # id() 键永不命中，同内容图重复 compile；digest 键让同定义子图
        # 跨实例复用（digest 含图名，同拓扑不同名不混用）
        self._subgraph_engines: dict[str, Engine] = {}
        # 执行回路护栏（ENG2-5）：单节点访问次数（每轮 _execute 复位；
        # 超 max_cycle 终止本轮，防纯静态回路靠预算超时兜底）
        self._node_visits: dict[str, int] = {}
        # 事件日志写失败降频时间戳（存储故障时避免每事件一条 ERROR 洪水）
        self._event_log_error_ts = 0.0
        # 内存态执行日志 seq（checkpoint 锚点权威来源；append_event 已返回 seq，
        # 避免每节点一次 latest_event_seq 查询；None = 尚未产生事件/无存储）
        self._latest_event_seq: int | None = None
        # 链尾推进标志：嵌套子图执行后置位（子图 checkpoint 推进版本链），
        # 下次写 checkpoint 前据此查询链尾作为 parent（避免顺序执行时每节点查询）
        self._chain_advanced = False
        # 已执行节点步数（本引擎累计；子链步数截止护栏的判据——结点边界
        # 计数与 ctx.step_count 同位置，计划推进等非节点迭代不计入）
        self.executed_node_steps = 0
        # 输入调配管线执行体（RunOptions.assembly 非 None 时启用；调用点
        # 经 ctx.assemble 统一调配，激活留痕随事件落库）
        self._assembler = (
            InputAssembler(self.options.assembly) if self.options.assembly is not None else None
        )
        # 结点级成败留痕（沉淀钩子输入）：本 run 的执行轨迹与成本账，
        # 不发射事件（观测侧零影响）。_execute 入口复位；嵌套引擎
        # （子图/实例/分支）执行完经合并点并入父引擎。
        self._run_trace: list[TraceStep] = []
        self._node_tokens: dict[tuple[tuple[str, ...], str], int] = {}
        self._trace_graphs: dict[tuple[str, ...], Graph] = {}
        self._pending_step: TraceStep | None = None
        self._trace_lock = asyncio.Lock()

    async def _publish(
        self, event: EngineEvent, *, transports: list[EngineTransport] | None = None
    ) -> None:
        """事件发布：落执行日志（append-only，拿 seq）→ 推送全部传输。

        存储/传输消费失败都不影响主流程（观测不阻断执行）；存储故障按
        时间窗降频记录，避免 token 级事件流触发日志洪水。

        并发安全：并行节点组（计划步骤）成员并发发射事件——计数与 seq
        锚点的登记经引擎级事件锁串行化（计数器防丢更新、seq 锚点防乱序
        覆盖导致恢复重放重复事件）；传输推送在锁外（消费方自身线程安全
        由传输实现保证，不互相等待）。
        """
        async with self._event_lock:
            self._event_counter += 1
            if self.options.storage is not None:
                try:
                    seq = await self.options.storage.append_event(event.thread_id, event)
                    event = replace(event, seq=seq)
                    # 内存态 seq 锚点（checkpoint 写入复用，免每节点查询）
                    self._latest_event_seq = seq
                except Exception as exc:
                    now = time.monotonic()
                    if now - self._event_log_error_ts >= 5.0:
                        self._event_log_error_ts = now
                        logger.error(f"事件日志写入失败（忽略，继续执行）: {exc}")
        for transport in transports or self.options.transports:
            try:
                await transport.send(event)
            except Exception as exc:
                logger.warning(f"事件传输失败（忽略）: {event.type}: {exc}")

    async def update_state(self, thread_id: str, values: dict) -> None:
        """外部状态补丁：读最新 checkpoint，按 schema reducer 合并 values 后
        写回新 checkpoint——不执行任何节点。

        弹卡注入（review_action 写 review_decision 等）/ 手动压缩裁剪 /
        cancel 清挂起共用：挂起卡保留在 checkpoint，注入值以新快照形式
        持久化，下一次 resume 恢复状态时即生效（版本链续接，线性不断）。
        """
        if self.options.storage is None or not values:
            return
        latest = await self.options.storage.get_latest_checkpoint(thread_id)
        if latest is None:
            return
        schema = self.options.schema
        merged = schema.apply(latest.state, values) if schema else {
            **latest.state, **values
        }
        # event_seq 沿用链尾：update_state 不产生任何执行事件，链尾与新快照
        # 的增量日志区间恒为空——resume 以任一锚点重放 events_after 均无重复。
        # 隐式前提：本方法不得改写成附带写事件，否则同 seq 双快照会重复重放。
        # interrupt 不沿袭链尾：外部补丁不是挂起轮，新快照不带挂起卡标记
        # （挂起卡状态只存在于真正中断的 checkpoint 上）。
        await self.options.storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=0,
                thread_id=thread_id,
                node=None,
                state=merged,
                parent_id=latest.checkpoint_id,
                event_seq=latest.event_seq,
                graph_version=self._graph_digest,
                # 计划快照沿袭链尾：注入/裁剪产生的新链尾不得丢计划游标
                # （计划随 checkpoint 版本链落盘的回滚语义在注入路径也成立）
                plan=latest.plan,
            )
        )

    async def get_latest_interrupt(self, thread_id: str) -> InterruptState | None:
        """读取链尾挂起卡（中断键 + 卡负载 + 定位），续流恢复定位锚点。

        挂起轮结束后，宿主从链尾取挂起卡状态（键与负载），用户在卡上
        做出决策后按同一键注入值重入（``run(inject={key: decision})``）。
        链尾无挂起卡（未中断/补丁快照/无存储）返回 None。
        """
        if self.options.storage is None:
            return None
        latest = await self.options.storage.get_latest_checkpoint(thread_id)
        if latest is None or latest.interrupt is None:
            return None
        return latest.interrupt

    async def run(
        self,
        state: dict,
        *,
        thread_id: str | None = None,
        round_id: str | None = None,
        resume_from: int | None = None,
        continue_chain: bool = False,
        inject: dict[str, Any] | None = None,
        trace_id: str | None = None,
        truncate_log_after: int | None = None,
        parent_checkpoint: int | None = None,
        transports: list[EngineTransport] | None = None,
    ) -> AsyncGenerator[EngineEvent, None]:
        """流式执行入口：产出事件流（含子图事件，顺序 = 发射顺序）。

        Args:
            state: 初始状态（无 checkpoint 时）。
            thread_id: 会话/线程 id（版本链归属，None = 自动生成）。
            round_id: 回合 id（事件契约）。
            resume_from: checkpoint_id 锚点（恢复/续流；None = 从头执行）。
                恢复时输入 state 作为覆盖层（checkpoint 优先，输入补缺/
                追加）。
            continue_chain: 新回合续链（True = 读链尾 checkpoint 为基底，
                输入 state 覆盖后从入口执行，版本链续接链尾；不重放事件）。
            inject: interrupt 注入值（{review_key: value}，重入语义）。
            trace_id: 链路追踪 ID（None = 自动生成）。
            truncate_log_after: 编辑重放：先截断执行日志 seq 之后（删除
                目标之后步骤，失效区保留），再续跑。
            parent_checkpoint: 编辑重放：新 checkpoint 链的父锚点（分叉）。
            transports: 追加事件传输（与 options.transports 叠加，按发射顺序送达）。
        """
        thread_id = thread_id or f"thread-{uuid.uuid4().hex[:12]}"
        trace_id = trace_id or uuid.uuid4().hex
        token = trace_id_var.set(trace_id)
        queue: asyncio.Queue[EngineEvent | None] = asyncio.Queue()
        # 事件流产出通道挂到传输列表（顺序 = 发射顺序；挂载后事件既落日志又进队列）
        transports = [*self.options.transports, *(transports or []), _QueueTransport(queue)]
        task: asyncio.Task | None = None
        # per-run 状态复位：run 是顶层入口（嵌套子图/spawn 走 _execute 不经过
        # 此处）——同实例串行多 run 的计数/seq 锚点/链尾标志不跨 run 残留
        # （否则不同 thread 的 checkpoint 锚点串台，恢复重放丢事件）
        self._event_counter = 0
        self._latest_event_seq = None
        self._chain_advanced = False
        self._validate_entry_mode(resume_from=resume_from, continue_chain=continue_chain)
        try:
            if inject:
                self._coordinator.inject(inject)
            if truncate_log_after is not None and self.options.storage is not None:
                await self.options.storage.truncate_events(thread_id, truncate_log_after)
            # 链级 rebase：顶层入口压缩历史前缀（版本链行数维度有界化）。
            # 编辑重放（parent_checkpoint 分叉锚点指向历史链）跳过——锚点
            # 可能落在窗口外，压缩会删掉分叉目标。
            if parent_checkpoint is None:
                await self._maybe_compact_chain(thread_id)
            task = asyncio.create_task(
                self._execute(
                    state=state,
                    thread_id=thread_id,
                    round_id=round_id,
                    resume_from=resume_from,
                    continue_chain=continue_chain,
                    trace_id=trace_id,
                    parent_checkpoint=parent_checkpoint,
                    queue=queue,
                    transports=transports,
                )
            )
            # 哨兵：任务结束（含异常）时入队，事件流据此收敛，无超时轮询
            task.add_done_callback(lambda _t: queue.put_nowait(None))
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
            _, run_result = await task
            self._record_run_metrics(run_result)
            await self._settle_run(
                run_result, thread_id=thread_id, round_id=round_id, trace_id=trace_id
            )
        finally:
            # 消费方提前退出（断连/break）：取消后台执行任务并等待其真正停止
            # （否则任务继续调 LLM/写 checkpoint，成本与数据泄漏）
            if task is not None and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            # 清理本轮注入但未被消费的值：注入值一次性（已注入决策的审批视为
            # 放弃，防门控绕过），残留会泄漏到下一次 run 被静默消费
            if inject:
                for key in inject:
                    self._coordinator.pending_inject.pop(key, None)
            trace_id_var.reset(token)

    async def ainvoke(
        self,
        state: dict,
        *,
        thread_id: str | None = None,
        round_id: str | None = None,
        resume_from: int | None = None,
        continue_chain: bool = False,
        inject: dict[str, Any] | None = None,
        trace_id: str | None = None,
        truncate_log_after: int | None = None,
        parent_checkpoint: int | None = None,
        transports: list[EngineTransport] | None = None,
    ) -> RunResult:
        """非流式执行（独立子图/一次性任务语义）：执行到终止，返回终态 RunResult。

        与 run 的差异：不产出事件队列（事件仍经 options.transports + 本参数
        transports 推送，适合 CollectorTransport 收集/审计日志场景），直接
        返回最终结果。注入值同样一次性清理（防残留泄漏，与 run 同语义）。
        """
        thread_id = thread_id or f"thread-{uuid.uuid4().hex[:12]}"
        trace_id = trace_id or uuid.uuid4().hex
        token = trace_id_var.set(trace_id)
        # per-run 状态复位（与 run() 同语义：顶层入口不跨 run 残留）
        self._event_counter = 0
        self._latest_event_seq = None
        self._chain_advanced = False
        self._validate_entry_mode(resume_from=resume_from, continue_chain=continue_chain)
        try:
            if inject:
                self._coordinator.inject(inject)
            if truncate_log_after is not None and self.options.storage is not None:
                await self.options.storage.truncate_events(thread_id, truncate_log_after)
            if parent_checkpoint is None:
                await self._maybe_compact_chain(thread_id)
            _state, result = await self._execute(
                state=state,
                thread_id=thread_id,
                round_id=round_id,
                resume_from=resume_from,
                continue_chain=continue_chain,
                trace_id=trace_id,
                queue=None,
                parent_checkpoint=parent_checkpoint,
                # 叠加而非替换：事件经 options.transports + 本参数 transports 推送
                # （与 run() 同口径，防静态审计/落库传输被静默停掉）
                transports=[*self.options.transports, *(transports or [])],
            )
            self._record_run_metrics(result)
            await self._settle_run(
                result, thread_id=thread_id, round_id=round_id, trace_id=trace_id
            )
            return result
        finally:
            if inject:
                for key in inject:
                    self._coordinator.pending_inject.pop(key, None)
            trace_id_var.reset(token)

    def _validate_entry_mode(
        self, *, resume_from: int | None, continue_chain: bool
    ) -> None:
        """入口模式契约：续链与锚点恢复语义互斥，同置显式拒绝。

        续链（continue_chain）= 新回合从链尾续接，不重放事件；锚点恢复
        （resume_from）= 从指定快照 + 事件重放续流——两者同置时锚点
        校验仍会生效（图版本不一致即拒），语义矛盾在入口暴露而非
        执行期意外终止。
        """
        if continue_chain and resume_from is not None:
            raise GraphDefinitionError(
                "continue_chain 与 resume_from 语义互斥"
                "（续链 = 从链尾续接不重放；恢复 = 按锚点快照 + 事件重放）"
            )

    def _record_run_metrics(self, result: RunResult) -> None:
        """回合指标采集（引擎自承载：记录自身可见的执行事实）。

        顶层 run 收尾调用一次：回合成败（错误终止 = 失败）与错误摘要
        入回合指标；评审分/收敛轮数/挡位调用由使用方按事件语义填报
        （引擎只采集执行本身可见的统计，语义化指标不替使用方猜）。
        """
        metrics = self.options.metrics
        if metrics is None:
            return
        failed = result.reason == TerminateReason.ERROR
        metrics.record_turn(failed=failed, error=result.error or "")

    # ── 结点级成败留痕（沉淀钩子输入；只记录不裁决，观测侧零影响）──

    def _trace_reset(self, graph: Graph, graph_path: tuple[str, ...]) -> None:
        """复位本引擎的轨迹（_execute 入口调用；嵌套引擎各自独立）。"""
        self._run_trace.clear()
        self._node_tokens.clear()
        self._trace_graphs.clear()
        self._pending_step = None
        self._trace_graphs[graph_path] = graph

    def _trace_open(self, graph_path: tuple[str, ...], node: str) -> None:
        """打开当前结点的步骤（成败在收尾前经标记定型）。"""
        self._pending_step = TraceStep(
            graph_path=graph_path, node=node, status=TRACE_SUCCESS
        )

    def _trace_mark_failed(self) -> None:
        if self._pending_step is not None:
            self._pending_step.status = TRACE_FAILED

    def _trace_mark_skipped(self) -> None:
        if self._pending_step is not None:
            self._pending_step.status = TRACE_SKIPPED

    async def _trace_close_pending(self) -> None:
        """收尾当前结点的步骤（成本归集 + 入轨迹；无待收尾 = 空操作）。"""
        step = self._pending_step
        if step is None:
            return
        self._pending_step = None
        step.tokens = self._node_tokens.get((step.graph_path, step.node), 0)
        async with self._trace_lock:
            self._run_trace.append(step)

    def _trace_add_tokens(
        self, graph_path: tuple[str, ...], node: str, tokens: int
    ) -> None:
        """结点执行边界 token 计账（usage 帧纯算法归集；不发射事件）。"""
        key = (graph_path, node)
        self._node_tokens[key] = self._node_tokens.get(key, 0) + tokens

    async def _trace_append_member(
        self, graph_path: tuple[str, ...], node: str, status: str
    ) -> None:
        """并行组成员步骤直入轨迹（member 标记：不参与边遍历推导）。"""
        step = TraceStep(
            graph_path=graph_path,
            node=node,
            status=status,
            tokens=self._node_tokens.get((graph_path, node), 0),
            member=True,
        )
        async with self._trace_lock:
            self._run_trace.append(step)

    def _trace_merge_from(self, sub_engine: Engine) -> None:
        """并入嵌套引擎（子图/实例/分支）的轨迹、图映射与成本账。"""
        self._run_trace.extend(sub_engine._run_trace)
        self._trace_graphs.update(sub_engine._trace_graphs)
        for key, tokens in sub_engine._node_tokens.items():
            self._node_tokens[key] = self._node_tokens.get(key, 0) + tokens

    async def _settle_run(
        self,
        result: RunResult,
        *,
        thread_id: str,
        round_id: str | None,
        trace_id: str,
    ) -> None:
        """沉淀钩子触发（run 收尾、指标采集之后；注册式扩展）。

        只记录不裁决：钩子异常在注册体内捕获记日志，不阻断 run 结果
        交付；未注入沉淀钩子（RunOptions.settle=None）= 关闭，零影响。
        """
        hooks = self.options.settle
        if hooks is None:
            return
        from .settle import DEFAULT_DOMAIN

        ctx = SettleContext(
            thread_id=thread_id,
            round_id=round_id,
            trace_id=trace_id,
            domain=self.options.domain or DEFAULT_DOMAIN,
            steps=tuple(self._run_trace),
            node_tokens=dict(self._node_tokens),
            graphs=dict(self._trace_graphs),
            result=result,
        )
        await hooks.run(ctx)

    @staticmethod
    async def decision_anchor(
        storage: Storage, thread_id: str
    ) -> int | None:
        """定位最近一次决策点执行前的恢复锚点（换选辅助）。

        决策事件（simulate_decision）在事件流中记录决策点位置；锚点 =
        该事件 seq 之前的最后一个 checkpoint（事件流与版本链同序对齐，
        恢复 = 快照 + 增量重放，锚点取决策前的快照才可重演决策点）。
        None = 该线程尚无决策点留痕（换选不可用）。
        """
        events = await storage.events_after(thread_id, 0)
        anchor_seq: int | None = None
        for event in events:
            if event.type == "simulate_decision":
                anchor_seq = event.seq
        if anchor_seq is None:
            return None
        best: ChainLink | None = None
        for link in await storage.chain_index(thread_id):
            if link.event_seq < anchor_seq and (
                best is None or link.event_seq > best.event_seq
            ):
                best = link
        return best.checkpoint_id if best is not None else None

    async def swap_branch(
        self,
        *,
        thread_id: str,
        before_checkpoint_id: int,
        branch_index: int,
        inject: dict[str, Any] | None = None,
        round_id: str | None = None,
        trace_id: str | None = None,
        transports: list[EngineTransport] | None = None,
    ) -> RunResult:
        """回溯换选：从决策点前锚点恢复，强制改选指定分支重放后续。

        推演-回溯-换选的执行语义：决策点完成后主线提交的是择优结果；
        对落选分支做回溯对比/换选 = 回到决策点节点执行前的 checkpoint
        锚点（决策点自身的 checkpoint 已是选择后状态），强制指定分支
        序号重放——重放只执行目标分支（其余分支的结果保留在各自独立
        子链，可回溯对比），主线状态最终 = 目标分支的结果。目标分支在
        重放时不存在或未通过评估 = 显式报错。锚点可用
        :meth:`decision_anchor` 从决策事件反查。

        Args:
            thread_id: 会话/线程 id（版本链归属）。
            before_checkpoint_id: 决策点节点执行前的 checkpoint 锚点
                （须为该线程链上非终态锚点，见校验）。
            branch_index: 目标分支序号（决策事件 branches 引用可见）。
            inject: 中断注入值（重入语义，与 run 同口径）。
            round_id/trace_id/transports: 透传（与 ainvoke 同语义）。
        """
        if self.options.storage is not None:
            anchor = await self.options.storage.get_checkpoint(
                before_checkpoint_id
            )
            if anchor is None:
                raise SimulationError(
                    f"换选锚点不存在: {before_checkpoint_id}"
                )
            if anchor.reason not in (None, "interrupted"):
                raise SimulationError(
                    "换选锚点须为决策点执行前的 checkpoint"
                    f"（当前锚点已是终态: {anchor.reason}）"
                )
        original = self.options.branch_pick
        self.options.branch_pick = branch_index
        try:
            return await self.ainvoke(
                {},
                thread_id=thread_id,
                round_id=round_id,
                resume_from=before_checkpoint_id,
                inject=inject,
                trace_id=trace_id,
                transports=transports,
            )
        finally:
            self.options.branch_pick = original

    async def _maybe_compact_chain(self, thread_id: str) -> None:
        """链级 rebase 入口（fail-open：压缩失败不阻断执行）。

        宿主自定义存储未实现压缩原语时跳过——版本链照常增长，功能
        不受损；引擎内置三后端（memory/sqlite/postgres）均已实现。
        """
        storage = self.options.storage
        if storage is None or self.options.checkpoint_keep <= 0:
            return
        try:
            outcome = await maybe_compact_chain(
                storage, thread_id, keep=self.options.checkpoint_keep
            )
        except Exception as exc:
            logger.warning(f"链级 rebase 不可用（跳过）: {exc}")
            return
        if outcome.compacted:
            logger.info(
                f"链级 rebase: thread={thread_id} 删除 {outcome.removed} 行、"
                f"改写链头 {outcome.rewired} 个、裁剪事件 {outcome.trimmed} 条"
            )

    async def _execute(
        self,
        *,
        state: dict,
        thread_id: str,
        round_id: str | None,
        resume_from: int | None,
        trace_id: str,
        queue: asyncio.Queue[EngineEvent | None] | None,
        parent_checkpoint: int | None = None,
        continue_chain: bool = False,
        graph_path: tuple[str, ...] = (),
        transports: list[EngineTransport] | None = None,
        resume_map: dict[tuple[str, ...], int] | None = None,
        checkpoint_thread_id: str | None = None,
        parent_step_id: str | None = None,
    ) -> tuple[dict, RunResult]:
        """主执行循环（顶层与嵌套子图/实例共用）。

        Args:
            graph_path: 本图执行的事件路径（顶层 ()；子图 = 父路径 + 子图名；
                spawn 实例 = 父路径 + 子图名 + 实例序号）。
            transports: 事件传输列表（None = 引擎 options 默认；顶层 run
                传入含队列的传输链，子图 None 走共享传输）。
            resume_map: 嵌套子图恢复锚点表（graph_path → checkpoint_id，
                断线续流落在子图 checkpoint 时由父级下沉传递）。
            checkpoint_thread_id: checkpoint 版本链归属（None = 与 thread_id
                相同）。spawn 实例借此把 checkpoint 写入独立子链、事件日志
                仍统一落 thread_id 父链（半共享 + 独立子链）。
            parent_step_id: 轨迹树父引用（推演分支/子任务事件指向决策点
                步骤；None = 顶层/普通子图）。
        """
        graph = self.graph
        schema = self.options.schema
        storage = self.options.storage
        transports = transports if transports is not None else self.options.transports
        chain_thread = checkpoint_thread_id or thread_id

        # 每轮执行独立计数/seq 锚点：`_execute` 是顶层与嵌套子图/实例共用
        # 入口——缓存子图引擎跨 run 复用（run_subgraph 按图实例缓存）时，
        # 上一轮的累计值若残留，父引擎合并计数会虚高（events_emitted 翻倍）
        # 且陈旧 seq 会命中存储层 event_seq 回退校验崩溃。此处复位保证
        # 每次执行从零起算（顶层 run/ainvoke 的入口复位与此幂等）。
        # 注意：`_chain_advanced` 由调用方预置（spawn 实例续接链尾/子图
        # 首写跟随父链尾），不复位。
        self._event_counter = 0
        self._latest_event_seq = None
        # 执行回路护栏计数复位（本引擎每轮独立：缓存子图引擎跨 run 复用
        # 时上一轮的访问计数不得残留——同节点在不同轮的正常访问不受累计）
        self._node_visits = {}
        # 结点级成败留痕复位（本引擎每轮独立；嵌套引擎执行完经合并点
        # 并入父引擎，不在此跨轮残留）
        self._trace_reset(graph, graph_path)

        # ── 恢复：checkpoint 快照 + 增量日志重放（断线续流，解析在 recovery 模块）──
        current: str = graph.entry
        # 续链/续跑的首写 parent 须跟随当前链尾（历史链尾可能已推进——
        # 上次中断/子图锚点/spawn 实例）：置位后由 checkpoint 写入处统一查询
        if (continue_chain or resume_from is not None) and storage is not None:
            self._chain_advanced = True
        resume = await resolve_resume(
            storage=storage,
            state=state,
            schema=schema,
            thread_id=thread_id,
            chain_thread=chain_thread,
            resume_from=resume_from,
            continue_chain=continue_chain,
            graph_path=graph_path,
            replay=queue is not None,
            resume_map=resume_map,
            graph_version=self._graph_digest,
        )
        current_state = resume.state
        last_checkpoint = resume.last_checkpoint
        resume_map = resume.resume_map
        # 增量日志重放：把最终锚点之后的事件补发给传输（断线续流；
        # replay 非空时 queue 必挂载，收集条件与入队条件一致）
        for event in resume.replay:
            await queue.put(event)

        ctx = _NodeContextImpl(
            engine=self,
            state=current_state,
            graph_path=graph_path,
            round_id=round_id,
            trace_id=trace_id,
            thread_id=thread_id,
            transports=transports,
            resume_map=resume_map,
            parent_step_id=parent_step_id,
        )
        # 恢复起点定位：
        # - 中断 checkpoint（reason=interrupted）：重入中断节点（节点内按注入值分支）；
        # - 异常 checkpoint（reason=error）：重入失败节点（该节点未完成，
        #   恢复即重试；error_on_exception=False 的跳过语义不落 error 终态）；
        # - 正常 checkpoint（节点已完成）：从已完成节点的下一节点继续，不重跑已完成节点；
        # - 计划 checkpoint（plan 快照非空）：节点已完成，从计划的剩余步骤
        #   续跑（计划随 checkpoint 版本化——回溯决策点时计划与状态同版本）。
        #   中断/失败 checkpoint 的 plan 快照区分两种形态：
        #   - 计划工作步（并行组/spawn 步）内中断：checkpoint.node 是计划
        #     产出节点（重跑它 = 重新规划，中断步与注入值丢失）——应重入
        #     计划步本身（plan_pending 直达计划推进，工作步重跑，中断成员
        #     经注入值分支）；判据 = 该节点不属于计划任何步骤的节点集合；
        #   - 顺序节点步中断：checkpoint.node 是未完成的计划步节点——重入
        #     该节点（计划游标已推进到下一步，完成后从剩余步骤续跑）。
        skip_first_node = False
        plan_pending = False
        work_step_signal = False
        active_plan: Plan | None = None
        if continue_chain:
            # 新回合续链：链尾为基底（状态通道继承）、事件全新产生、不恢复
            # 旧计划快照（新回合重新规划）。定位分流：
            # - 链尾节点在新图存在（同图续链）：从链尾节点出边继续——宿主
            #   回合语义「终止节点带出边，续链从出边继续」，不重跑终止节点；
            # - 链尾节点在新图不存在（换图/同 thread 切 harness）：从
            #   新图入口执行（current 保持 graph.entry）——按链尾定位会因
            #   节点名缺失静默终态。
            if last_checkpoint is not None and last_checkpoint.node:
                if last_checkpoint.node not in graph.nodes:
                    # 换图：链尾节点在新图不存在，从新图入口执行
                    pass
                else:
                    nxt = await _select_next_node(graph, ctx, last_checkpoint.node)
                    if nxt is not None:
                        current = nxt
                    else:
                        # 链尾为出口/无出边：图已走完，终态收尾不重复执行
                        skip_first_node = True
        elif last_checkpoint is not None and last_checkpoint.node:
            if last_checkpoint.reason in ("interrupted", TerminateReason.ERROR):
                current = last_checkpoint.node
                # 中断/失败发生在计划执行中：计划快照随中断 checkpoint 落盘
                # （工作步中断 index 停留在当前步；顺序节点中断 index 已推进
                # 到下一步）——重入节点/计划步拿到注入值/重试完成后从计划
                # 剩余步骤续跑（不丢计划，回溯决策点计划同版本）
                if last_checkpoint.plan is not None and self.options.max_plan_steps > 0:
                    active_plan = Plan.from_dict(last_checkpoint.plan)
                    # 工作步（并行组/spawn）内中断/失败 → 重入计划步本身：
                    # checkpoint.node 是计划产出节点（重跑它 = 重新规划，
                    # 中断步与注入值丢失）；顺序节点步 → 重入该节点。显式
                    # 标记优先，旧存档回落节点名判据（兼容）。
                    if _plan_snapshot_is_work_step(last_checkpoint.plan) or not (
                        _node_in_plan_steps(current, active_plan)
                    ):
                        plan_pending = True
            elif last_checkpoint.plan is not None and self.options.max_plan_steps > 0:
                active_plan = Plan.from_dict(last_checkpoint.plan)
                # 普通计划 checkpoint：产出节点已完成，跳过其执行，直接从
                # 计划剩余步骤续跑（重跑产出节点会重新规划，覆盖计划游标）
                plan_pending = True
            else:
                nxt = await _select_next_node(graph, ctx, last_checkpoint.node)
                if nxt is not None:
                    current = nxt
                else:
                    # 已完成节点无出边：图已走完（或节点为出口），终止不再执行
                    skip_first_node = True
        parent_id = parent_checkpoint or (
            last_checkpoint.checkpoint_id if last_checkpoint else None
        )
        # 编辑重放分叉：首写 checkpoint 跳过存储层链尾校验（锚点指向历史链节点）
        fork_write = parent_checkpoint is not None
        interrupt_state: InterruptState | None = None
        reason = TerminateReason.REPLY
        error_msg: str | None = None
        events_before = self._event_counter

        while True:
            if current not in graph.nodes:
                raise NodeExecutionError(current, ValueError(f"节点未注册: {current}"))
            ctx.node = current
            # 输入调配缓存按节点复位：预装配结果只对当前节点有效——跨节点
            # 复用会让后续节点拿到上一节点的陈旧上下文且无留痕（每次节点
            # 执行前统一调配 + 留痕可回放的前提）
            ctx._assembled = None
            # 上一结点步骤收尾（成败已在结点块内标记定型；成本此刻归集）
            await self._trace_close_pending()

            # ── 恢复终点：已完成节点无出边，直接进入终态收尾 ──
            if skip_first_node:
                skip_first_node = False
                if active_plan is None:
                    # 终态快照沿用恢复锚点的已完成节点：回写入口节点会让链尾
                    # 变成"entry 已完成"，后续 resume 从 entry 的下一节点整图
                    # 重跑（重复执行 + 重复写 checkpoint）
                    if last_checkpoint is not None and last_checkpoint.node:
                        current = last_checkpoint.node
                    break
                # 计划恢复：已完成节点不重跑，直接进入下一步定位（计划推进）

            # ── 计划恢复首轮：跳过节点执行，直接推进计划游标 ──
            # 普通计划 checkpoint（产出节点已完成）与工作步中断恢复（重入
            # 计划步）共用：从 checkpoint 计划快照的 index 续跑，不重跑
            # 产出节点（重跑 = 重新规划，计划游标与推演回溯锚点丢失）。
            if plan_pending:
                plan_pending = False
                assert active_plan is not None
                advance = await self._plan_advance(
                    plan=active_plan,
                    ctx=ctx,
                    graph=graph,
                    schema=schema,
                    state=current_state,
                    storage=storage,
                    thread_id=thread_id,
                    chain_thread=chain_thread,
                    parent_id=parent_id,
                    fork_write=fork_write,
                )
                current_state = advance.state
                work_step_signal = (
                    advance.interrupt is not None or advance.reason is not None
                )
                if advance.interrupt is not None:
                    interrupt_state = advance.interrupt
                    reason = "interrupted"
                    break
                if advance.reason is not None:
                    reason = advance.reason
                    error_msg = advance.error
                    break
                parent_id = advance.parent_id
                fork_write = advance.fork_write
                active_plan = advance.plan
                if active_plan is not None:
                    current = advance.node
                    continue
                # 计划耗尽：从已完成节点走边/出口定位（不重走 graph.entry）
                current = (
                    last_checkpoint.node
                    if last_checkpoint is not None and last_checkpoint.node
                    else current
                )
                reason, nxt = await _locate_next(graph, ctx, current)
                if nxt is not None:
                    current = nxt
                    continue
                break

            # ── 节点步数计数：与预算检查同位置的节点边界（计划推进等
            # 非节点迭代不计入）——策略经 ctx.step_count 按步数终止
            ctx.step_count += 1
            # 引擎级步数累计（子链步数截止：分支/支流引擎执行后按此判超限）
            self.executed_node_steps += 1

            # ── 执行回路护栏（ENG2-5）：单节点访问次数超限 = 疑似纯静态
            # 回路（A→B→A 无可达 exit），compile 期不拒绝（条件边合法循环
            # 允许回指），执行期按节点访问次数兜底截止——不依赖预算钩子
            # 注入，任何图定义都有成本上界。0 = 按数据声明不校验。
            if self.options.max_cycle > 0:
                visits = self._node_visits.get(current, 0) + 1
                self._node_visits[current] = visits
                if visits > self.options.max_cycle:
                    node_error = (
                        f"执行回路超限（节点 {current} 访问 {visits} 次 > "
                        f"max_cycle={self.options.max_cycle}，疑似纯静态回路）"
                    )
                    logger.error(f"执行回路超限 [{current}]: {node_error}")
                    await ctx.emit("error", {"node": current, "message": node_error})
                    error_msg = node_error
                    reason = TerminateReason.ERROR
                    break

            # ── 预算检查（节点边界，策略由业务注册）──
            if self.options.budget is not None:
                try:
                    await self.options.budget.check(ctx)
                except Exception as exc:
                    reason = TerminateReason.BUDGET_EXCEEDED
                    error_msg = str(exc)
                    break

            # ── 输入调配预装配（执行语义接线）：节点执行前统一走调配
            # 管线——源由 RunOptions.assembly_sources 提供（未注入时
            # 节点自行经 ctx.assemble 装配），装配结果节点内复用，
            # 激活记录只留痕一次
            await ctx.preassemble()

            # 结点级成败留痕：打开当前结点步骤（成败在结点块内标记，
            # 收尾在下一循环头或循环出口；不发射事件）
            self._trace_open(graph_path=ctx.graph_path, node=current)

            # ── 执行节点（重试 N 次 / 终止；兼容同步/异步节点函数）──
            overlay: dict | None = None
            node_error: str | None = None
            for attempt in range(self.options.max_node_retries + 1):
                # 每次尝试复位收集器与终止标记：失败尝试的残留清单不得在
                # 重试成功后一并展开（序号冲突/重复执行），终止信号同理
                ctx._spawns.clear()
                ctx._terminated = None
                # 当前节点上下文注入（用量闭环接线）：节点执行期间
                # current_node_context 指向本节点——LLM 链守卫包装据此
                # 把 usage 帧记入本节点成本账并发射 llm_usage 指标事件
                node_token = current_node_context.set(ctx)
                try:
                    fn = graph.nodes[current]
                    result = fn(ctx)
                    if inspect.isawaitable(result):
                        result = await result
                    overlay = result
                    break
                except InterruptSignal as sig:
                    # 安全：中断负载（审批卡内容）经 RunResult 直返宿主，与
                    # 落库通道同口径剥离敏感键（凭据只存运行期内存态）
                    interrupt_state = InterruptState(
                        key=sig.key,
                        payload=strip_sensitive(sig.payload),
                        node=current,
                        graph_path=ctx.graph_path,
                    )
                    reason = "interrupted"
                    break
                except Exception as exc:
                    if attempt < self.options.max_node_retries:
                        logger.warning(f"节点重试 [{current}] 第 {attempt + 1}/{self.options.max_node_retries} 次: {exc}")
                        continue
                    # 包装保留原异常链（可诊断）；事件/checkpoint 只落脱敏消息，
                    # 细节进日志（trace_id 关联），不向消费方暴露内部堆栈/连接串
                    wrapped = NodeExecutionError(current, exc)
                    node_error = f"节点执行失败: {current}"
                    logger.error(f"节点执行失败 [{current}]: {wrapped}", exc_info=exc)
                    await ctx.emit("error", {"node": current, "message": node_error})
                    if self.options.error_on_exception:
                        error_msg = node_error
                        reason = TerminateReason.ERROR
                    else:
                        # 跳过语义：节点异常忽略（无增量），图继续按边走
                        logger.warning(f"节点异常跳过（error_on_exception=False）[{current}]: {exc}")
                    break
                finally:
                    current_node_context.reset(node_token)
            if node_error is not None:
                self._trace_mark_failed()
            if interrupt_state is not None:
                self._trace_mark_skipped()
                break
            if reason in (TerminateReason.ERROR, TerminateReason.STOP):
                break

            # ── 增量类型防线：节点必须返回 dict（或 None）──
            if overlay is not None and not isinstance(overlay, dict):
                node_error = f"节点返回非法增量类型: {type(overlay).__name__}（须为 dict 或 None）"
                logger.error(f"节点返回非法增量类型 [{current}]: {type(overlay).__name__}")
                await ctx.emit("error", {"node": current, "message": node_error})
                self._trace_mark_failed()
                error_msg = node_error
                reason = TerminateReason.ERROR
                break

            # ── spawn 清单提取（保留键不落状态；与命令式收集项合并）──
            if self.options.max_spawns > 0:
                try:
                    spawn_specs = collect_spawn_specs(
                        overlay,
                        ctx._spawns,
                        resolve_graph=self._resolve_graph_data,
                    )
                    # 命令式清单一次性消费：清空收集器，防清单泄漏到后续
                    # 节点被重复展开（数据驱动项已随 overlay 弹出，不重复）
                    ctx._spawns.clear()
                except (ValueError, TypeError, GraphDefinitionError) as exc:
                    # TypeError 双保险：不可信清单的类型错误必须走同一
                    # 错误路径（终态 checkpoint + error 事件），不得穿出；
                    # GraphDefinitionError：数据形态子图的图定义非法
                    # （缺字段/节点未注册/条件未注册）——同样按节点失败收口
                    node_error = f"spawn 清单非法: {exc}"
                    logger.error(f"spawn 清单非法 [{current}]: {exc}")
                    await ctx.emit("error", {"node": current, "message": node_error})
                    self._trace_mark_failed()
                    error_msg = node_error
                    reason = TerminateReason.ERROR
                    break
            else:
                spawn_specs = []
                # spawn 禁用：保留键仍须从增量弹出（不落状态/checkpoint——
                # 清单含 Graph 对象，泄漏会破坏状态可序列化性）
                if overlay is not None and SPAWN_KEY in overlay:
                    overlay.pop(SPAWN_KEY)

            # ── 计划清单提取（保留键不落状态；与 __spawn__ 键同语义）──
            # 节点返回 __plan__ = 下一跳编排清单（图拓扑的可改写数据形态）：
            # 引擎按清单续跑、执行一段后再规划；清单经解析校验（节点存在性/
            # 条件注册/步数上限）后才生效，非法清单按节点失败终止（fail-fast，
            # 不静默忽略也不穿出）。
            plan_data = overlay.pop(PLAN_KEY, None) if overlay is not None else None
            if plan_data is not None:
                try:
                    if self.options.max_plan_steps <= 0:
                        raise ValueError("计划已禁用（max_plan_steps=0）")
                    _registries = self.options.registries
                    active_plan = Plan.parse(
                        plan_data,
                        graph=graph,
                        edge_registry=_registries.edges if _registries is not None else None,
                        policy=self.options.plan_policy,
                        max_steps=self.options.max_plan_steps,
                        workflow=self.options.plan_workflow,
                    )
                except (GraphDefinitionError, ValueError, TypeError) as exc:
                    node_error = f"计划清单非法: {exc}"
                    logger.error(f"计划清单非法 [{current}]: {exc}")
                    await ctx.emit("error", {"node": current, "message": node_error})
                    self._trace_mark_failed()
                    error_msg = node_error
                    reason = TerminateReason.ERROR
                    break

            # ── 推演清单提取（保留键不落状态；__simulate__ = 决策点标记）──
            # 节点返回 __simulate__ = 关键决策点：引擎派生多个分支推演走向，
            # 分支经独立子链执行（落选分支保留轨迹树引用），评估协议择优
            # 提交主线。非法清单按节点失败终止（fail-fast 同口径）。
            simulate_data = (
                overlay.pop(SIMULATE_KEY, None) if overlay is not None else None
            )
            if simulate_data is not None:
                try:
                    if self.options.evaluator is None:
                        raise ValueError("推演已启用但未注入评估器（RunOptions.evaluator）")
                    if self.options.max_simulations <= 0:
                        raise ValueError("推演已禁用（max_simulations=0）")
                    step_id, budget, sim_specs = parse_simulate(
                        simulate_data,
                        resolve_graph=self._resolve_graph_data,
                        max_branches=self.options.max_simulations,
                    )
                except (GraphDefinitionError, ValueError, TypeError) as exc:
                    node_error = f"推演清单非法: {exc}"
                    logger.error(f"推演清单非法 [{current}]: {exc}")
                    await ctx.emit("error", {"node": current, "message": node_error})
                    self._trace_mark_failed()
                    error_msg = node_error
                    reason = TerminateReason.ERROR
                    break
                # 决策点步骤 id：分支事件 parent_step_id 指向它（轨迹树根；
                # 清单未携带时为 None——分支仍经独立子链保留，可回溯换选）

            # ── 多径展开清单提取（保留键不落状态；__multipath__ 与
            # __spawn__/__simulate__ 同语义）──
            # 组装编排节点在「多径开启 + 触发信号」时产出：候选集 + 组装
            # 请求 + 入口状态。执行入口读 multipath_enabled（装配运行期
            # 开关）与本清单（含 multipath_signal），经 MultipathRunner
            # 并行执行 → 汇流裁决 → 胜者增量回流主线（ENG2-1/2/3 接线）。
            multipath_data = (
                overlay.pop(MULTIPATH_KEY, None) if overlay is not None else None
            )

            # ── 增量合并（reducer）──
            if overlay:
                current_state = schema.apply(current_state, overlay) if schema else {
                    **current_state, **overlay
                }
            ctx._state = current_state

            # ── 节点终止信号（reply/止损/超限，业务策略表达）──
            if ctx.terminated:
                reason = ctx.terminate_reason or TerminateReason.REPLY
                if not TerminateReason.is_valid(reason):
                    raise ValueError(f"非法终止原因: {reason}")
                break

            # ── spawn 展开（子任务清单并发展开为子图实例，结果回流）──
            if spawn_specs:
                # 嵌套深度护栏（fail-closed，与清单超限同口径节点失败）：
                # 子单元深度 = 当前子链深度 + 1；0 = 按数据声明不校验；
                # 递归嵌套是成本爆炸的高发点，宁可显式失败不可静默放行
                if (
                    self.options.spawn_max_depth > 0
                    and self.options.spawn_depth + 1 > self.options.spawn_max_depth
                ):
                    node_error = (
                        f"spawn 嵌套深度超限: {self.options.spawn_depth + 1} "
                        f"> {self.options.spawn_max_depth}"
                    )
                    logger.error(f"spawn 嵌套深度超限 [{current}]: {node_error}")
                    await ctx.emit("error", {"node": current, "message": node_error})
                    self._trace_mark_failed()
                    error_msg = node_error
                    reason = TerminateReason.ERROR
                    break
                if len(spawn_specs) > self.options.max_spawns:
                    node_error = (
                        f"spawn 清单超限: {len(spawn_specs)} > {self.options.max_spawns}"
                    )
                    logger.error(f"spawn 清单超限 [{current}]: {node_error}")
                    await ctx.emit("error", {"node": current, "message": node_error})
                    self._trace_mark_failed()
                    error_msg = node_error
                    reason = TerminateReason.ERROR
                    break
                try:
                    spawn_result = await self.run_spawned(
                        spawn_specs,
                        ctx,
                        concurrency=self.options.spawn_concurrency,
                    )
                except InterruptSignal as sig:
                    # 实例内中断 → 提升为父图挂起卡（与静态子图同语义：中断
                    # 负载经 RunResult 直返宿主，同口径剥离敏感键）
                    interrupt_state = InterruptState(
                        key=sig.key,
                        payload=strip_sensitive(sig.payload),
                        node=current,
                        graph_path=ctx.graph_path,
                    )
                    self._trace_mark_skipped()
                    reason = "interrupted"
                    break
                if spawn_result.overlay:
                    current_state = (
                        schema.apply(current_state, spawn_result.overlay)
                        if schema
                        else {**current_state, **spawn_result.overlay}
                    )
                ctx._state = current_state
                # 失败实例留痕：剔除不阻断父链（部分失败语义），但必须可见
                # 可诊断——error 事件入流 + 日志带实例序号与原因
                if spawn_result.failures:
                    for failure in spawn_result.failures:
                        logger.warning(
                            f"spawn 实例失败（剔除，父链继续）[{current}] index={failure.index}: {failure.error}"
                        )
                    await ctx.emit(
                        "error",
                        {
                            "node": current,
                            "message": (
                                f"spawn 实例失败 {len(spawn_result.failures)} 个"
                                f"（已剔除，父链继续）: "
                                + ", ".join(
                                    f"#{f.index}" for f in spawn_result.failures
                                )
                            ),
                        },
                    )

            # ── 推演展开（决策点：分支独立子链推演 → 评估择优 → 提交主线）──
            # 每个分支 = 独立子链执行（与 spawn 同构：隔离状态 + 独立
            # checkpoint 链 + 事件统一父链），执行结果经评估器打分，调配
            # 策略（默认单选最高分，可注入跨分支组装）择优提交主线；落选
            # 分支不销毁——checkpoint 子链与事件留痕（parent_step_id 轨迹
            # 树引用）保留，可回溯对比/换选。分支失败按部分失败语义剔除
            # （不阻断主线）；评估/调配异常按节点失败收口（fail-fast）。
            if simulate_data is not None:
                try:
                    sim_result = await self.run_simulated(
                        sim_specs,
                        ctx,
                        step_id=step_id,
                        budget=budget,
                        concurrency=self.options.simulate_concurrency,
                    )
                except InterruptSignal as sig:
                    interrupt_state = InterruptState(
                        key=sig.key,
                        payload=strip_sensitive(sig.payload),
                        node=current,
                        graph_path=ctx.graph_path,
                    )
                    self._trace_mark_skipped()
                    reason = "interrupted"
                    break
                except SimulationError as exc:
                    node_error = f"推演失败: {exc}"
                    logger.error(f"推演失败 [{current}]: {exc}")
                    await ctx.emit("error", {"node": current, "message": node_error})
                    self._trace_mark_failed()
                    error_msg = node_error
                    reason = TerminateReason.ERROR
                    break
                if sim_result.selection.overlay:
                    current_state = (
                        schema.apply(current_state, sim_result.selection.overlay)
                        if schema
                        else {**current_state, **sim_result.selection.overlay}
                    )
                ctx._state = current_state
                # 决策留痕事件：分支评估表 + 选中分支 + 来源留痕 + 分支子链
                # 引用（落选分支的轨迹树锚点 = 决策事件 + 子链 thread）
                await ctx.emit(
                    "simulate_decision",
                    {
                        "node": current,
                        "step_id": step_id,
                        "selected": list(sim_result.selection.selected),
                        "branches": [
                            {
                                "index": b.spec.index,
                                "description": b.spec.description,
                                "score": b.evaluation.score,
                                "passed": b.evaluation.passed,
                                "note": b.evaluation.note,
                                "rule_version": b.evaluation.rule_version,
                                "params_snapshot": b.evaluation.params_snapshot,
                            }
                            for b in sim_result.branches
                        ],
                        "provenance": [
                            {
                                "branch": p.branch_index,
                                "key": p.key,
                                "note": p.note,
                            }
                            for p in sim_result.selection.provenance
                        ],
                        "threads": {
                            str(index): thread
                            for index, thread in sim_result.thread_ids.items()
                        },
                    },
                    step_id=step_id,
                )

            # ── 多径展开（候选集并行执行 → 汇流裁决 → 胜者增量回流主线）──
            # 与推演同构：支流独立子链执行 + 事件统一父链 + 中断提升为父图
            # 挂起卡；与推演的差异在裁决——多径按边证据/质量闸门择优（胜者
            # 回流），推演按评估器打分择优。机制开关关闭（装配运行期
            # multipath_enabled=False）或信号为假 = 清单本不应产出（编排
            # 节点侧已按开关分流）；此处再验一次（运行时开关回退 = 防御性
            # 降级：按单径执行首候选，不静默丢弃候选）。
            if multipath_data is not None:
                try:
                    mp_result = await self._run_multipath(multipath_data, ctx)
                except InterruptSignal as sig:
                    # 支流内中断 → 提升为父图挂起卡（与静态子图同语义）
                    interrupt_state = InterruptState(
                        key=sig.key,
                        payload=strip_sensitive(sig.payload),
                        node=current,
                        graph_path=ctx.graph_path,
                    )
                    self._trace_mark_skipped()
                    reason = "interrupted"
                    break
                except Exception as exc:
                    node_error = f"多径执行失败: {exc}"
                    logger.error(f"多径执行失败 [{current}]: {exc}")
                    await ctx.emit("error", {"node": current, "message": node_error})
                    self._trace_mark_failed()
                    error_msg = node_error
                    reason = TerminateReason.ERROR
                    break
                overlay_merge: dict[str, Any] = {}
                if mp_result.verdict is not None and mp_result.verdict.selection:
                    overlay_merge = dict(mp_result.verdict.selection)
                elif mp_result.k == 1 and mp_result.branches:
                    # 降级单径：首个候选的回收增量直接回流（与 spawn 单实例
                    # 回流同语义——候选仍执行，机制降级不丢产物）
                    overlay_merge = dict(mp_result.branches[0].overlay)
                if overlay_merge:
                    current_state = (
                        schema.apply(current_state, overlay_merge)
                        if schema
                        else {**current_state, **overlay_merge}
                    )
                ctx._state = current_state
                # 多径执行留痕事件（触发/支流/裁决/子链引用全量可审计）
                await ctx.emit(
                    "multipath_result",
                    {
                        "node": current,
                        "triggered": bool(mp_result.triggered),
                        "k": int(mp_result.k),
                        "candidates": int(mp_result.candidates),
                        "winner": mp_result.winner,
                        "degraded_reason": mp_result.degraded_reason,
                        "branches": [b.to_dict() for b in mp_result.branches],
                        "verdict": (
                            mp_result.verdict.to_dict()
                            if mp_result.verdict is not None
                            else None
                        ),
                        "threads": dict(mp_result.thread_ids),
                    },
                )

            # ── checkpoint 快照（每节点完成，版本链；计划激活时随附计划快照）──
            if storage is not None:
                last_checkpoint, fork_write = await self._write_checkpoint(
                    storage=storage,
                    thread_id=thread_id,
                    chain_thread=chain_thread,
                    ctx=ctx,
                    node=current,
                    state=current_state,
                    parent_id=parent_id,
                    fork_write=fork_write,
                    plan=active_plan.to_dict() if active_plan is not None else None,
                )
                parent_id = last_checkpoint.checkpoint_id

            # ── 下一步定位：计划推进（优先）or 条件边/出口 ──
            if active_plan is not None:
                advance = await self._plan_advance(
                    plan=active_plan,
                    ctx=ctx,
                    graph=graph,
                    schema=schema,
                    state=current_state,
                    storage=storage,
                    thread_id=thread_id,
                    chain_thread=chain_thread,
                    parent_id=parent_id,
                    fork_write=fork_write,
                )
                current_state = advance.state
                work_step_signal = (
                    advance.interrupt is not None or advance.reason is not None
                )
                if advance.interrupt is not None:
                    # 计划工作步内中断（并行组成员/spawn 实例）→ 提升为父图
                    # 挂起卡（与节点中断同口径：负载剥离敏感键后直返宿主）
                    interrupt_state = advance.interrupt
                    reason = "interrupted"
                    break
                if advance.reason is not None:
                    reason = advance.reason
                    error_msg = advance.error
                    break
                parent_id = advance.parent_id
                fork_write = advance.fork_write
                active_plan = advance.plan
                if active_plan is not None:
                    current = advance.node
                    continue
                # 计划耗尽：回到条件边/出口定位（current = 计划末节点）
            reason, nxt = await _locate_next(graph, ctx, current)
            if nxt is not None:
                current = nxt
            else:
                break

        # 收尾：最后一个结点的步骤留痕（成败已在退出路径标记定型）
        await self._trace_close_pending()

        # ── 审批挂起卡进事件流：中断负载（审批卡内容）随回合事件直出，
        # 前端据此渲染审批卡。挂起语义住引擎——传输层/渲染器可换，换栈
        # 不丢审批通道（事件信封不变，只加类型）。payload 与落库口径一致
        # （敏感键已在中断状态构造处剥离）。resume 重放仅发生在队列模式，
        # 锚点之后的增量不含本卡（checkpoint 已记录该 seq），不会重复发射
        if interrupt_state is not None:
            await ctx.emit("review_card", interrupt_state.payload)

        # ── 终态 checkpoint（携带终止原因/异常快照/计划快照，入轨迹与审计）──
        if storage is not None:
            plan_snapshot = None
            if active_plan is not None:
                plan_snapshot = active_plan.to_dict()
                if work_step_signal:
                    # 工作步内中断/失败标记：恢复时据此重入计划步本身
                    # （显式信号，不依赖 checkpoint.node 的节点名猜测）
                    plan_snapshot = {**plan_snapshot, "work_step": True}
            last_checkpoint, fork_write = await self._write_checkpoint(
                storage=storage,
                thread_id=thread_id,
                chain_thread=chain_thread,
                ctx=ctx,
                node=current,
                state=current_state,
                parent_id=parent_id,
                fork_write=fork_write,
                reason=reason,
                error=error_msg,
                # 挂起卡状态随终态快照持久化：reason=interrupted 时携带
                # 中断键与卡负载（续流恢复定位锚点，宿主据此注入决策值）
                interrupt=interrupt_state,
                plan=plan_snapshot,
            )
        result = RunResult(
            state=current_state,
            reason=reason,
            checkpoint_id=last_checkpoint.checkpoint_id if last_checkpoint else None,
            interrupt=interrupt_state,
            events_emitted=self._event_counter - events_before,
            error=error_msg,
        )
        return current_state, result

    async def _write_checkpoint(
        self,
        *,
        storage: Storage,
        thread_id: str,
        chain_thread: str,
        ctx: NodeContext,
        node: str,
        state: dict,
        parent_id: int | None,
        fork_write: bool,
        reason: str | None = None,
        error: str | None = None,
        interrupt: InterruptState | None = None,
        plan: dict | None = None,
    ) -> tuple[CheckpointRecord, bool]:
        """统一 checkpoint 写入（主循环/计划步共用，链写入不变量单点维护）。

        - 恢复锚点权威来源 = 事件日志本身（跨实例/跨 run/子图事件全部
          自然包含，无内存态依赖；恢复 = 快照 + 该 seq 之后的增量重放），
          seq 取内存态（_publish 已维护），避免每节点一次 latest_event_seq 查询；
        - 链尾跟随：嵌套子图/spawn 实例推进过链尾（或恢复续跑）时 parent
          跟随当前链尾（版本链严格线性，跨引擎连续），查一次后复位；
        - 编辑重放分叉（fork_write=True）首写跳过链尾校验（锚点指向历史链）。

        Returns:
            (落库记录, 新的 fork_write 值)——fork 仅在首次写生效，返回 False。
        """
        event_seq = (
            self._latest_event_seq
            if self._latest_event_seq is not None
            else await storage.latest_event_seq(thread_id)
        )
        if self._chain_advanced:
            _tail = await tail_checkpoint(storage, chain_thread)
            if _tail is not None:
                parent_id = _tail.checkpoint_id
            self._chain_advanced = False
        record = await storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=0,
                thread_id=chain_thread,
                node=node,
                graph_path=ctx.graph_path,
                state=state,
                parent_id=parent_id,
                reason=reason,
                event_seq=event_seq,
                error=error,
                interrupt=interrupt,
                graph_version=self._graph_digest,
                plan=plan,
            ),
            fork=fork_write,
        )
        return record, False

    async def _plan_advance(
        self,
        *,
        plan: Plan,
        ctx: NodeContext,
        graph: Graph,
        schema: StateSchema | None,
        state: dict,
        storage: Storage | None,
        thread_id: str,
        chain_thread: str,
        parent_id: int | None,
        fork_write: bool,
    ) -> _PlanAdvance:
        """计划游标推进：取下一执行节点 / 执行无节点形态的计划步。

        循环语义（skip 型步骤内联消耗，直至产出可执行节点或计划耗尽）：
        - 条件门：按条件名求值（注册表解析），不满足 = 跳过该步；
        - 顺序节点步：产出节点名（主循环执行，每节点 checkpoint 粒度）；
        - 并行组/spawn 步：本方法内执行（隔离状态并发/实例展开），结果
          合并后写入 checkpoint（计划快照 index 推进）——恢复不重跑有
          副作用的步骤；
        - 计划耗尽：返回 plan=None（主循环转条件边/出口定位）。

        计划步内的终止/中断（并行组成员 terminate、spawn 实例 interrupt）
        以控制流信号返回（不落 checkpoint——终态快照由主循环统一写入）。
        """
        while True:
            if plan.index >= len(plan.steps):
                return _PlanAdvance(
                    state=state,
                    parent_id=parent_id,
                    fork_write=fork_write,
                )
            step = plan.steps[plan.index]
            nxt_plan = replace(plan, index=plan.index + 1)
            if step.condition is not None and not await self._eval_condition(step.condition, ctx):
                plan = nxt_plan
                continue
            if step.kind == KIND_NODES:
                return _PlanAdvance(
                    node=step.nodes[0],
                    plan=nxt_plan,
                    state=state,
                    parent_id=parent_id,
                    fork_write=fork_write,
                )
            outcome = await self._execute_plan_work_step(step, ctx, state, graph, schema)
            if outcome.interrupt is not None:
                return _PlanAdvance(
                    interrupt=outcome.interrupt,
                    state=state,
                    parent_id=parent_id,
                    fork_write=fork_write,
                )
            if outcome.terminate is not None:
                # 终止成员/已完成成员的 overlay 先并入状态（与单节点
                # terminate 同语义：增量随终态快照保留，不因组级终止丢弃）
                if outcome.overlay:
                    state = (
                        schema.apply(state, outcome.overlay)
                        if schema
                        else {**state, **outcome.overlay}
                    )
                return _PlanAdvance(
                    reason=outcome.terminate,
                    error=outcome.error,
                    state=state,
                    parent_id=parent_id,
                    fork_write=fork_write,
                )
            if outcome.error is not None:
                # 计划步失败（并行组成员失败/清单非法）→ 整轮按错误终止
                return _PlanAdvance(
                    reason=TerminateReason.ERROR,
                    error=outcome.error,
                    state=state,
                    parent_id=parent_id,
                    fork_write=fork_write,
                )
            if outcome.overlay:
                state = (
                    schema.apply(state, outcome.overlay)
                    if schema
                    else {**state, **outcome.overlay}
                )
            ctx._state = state
            plan = nxt_plan
            if storage is not None:
                # 计划步完成标记（ENG2-13）：工作步（并行/spawn）完成的
                # checkpoint 其 node 字段是计划产出节点，实际执行的是计划
                # 步本身——plan 快照附加 ``plan_step`` 标记，审计/消费方
                # 可区分「节点步 checkpoint」与「计划工作步 checkpoint」
                # （恢复重入只认 ``work_step`` 中断标记，不受影响）。
                plan_snapshot = plan.to_dict()
                plan_snapshot = {**plan_snapshot, "plan_step": True}
                record, fork_write = await self._write_checkpoint(
                    storage=storage,
                    thread_id=thread_id,
                    chain_thread=chain_thread,
                    ctx=ctx,
                    node=ctx.node or "",
                    state=state,
                    parent_id=parent_id,
                    fork_write=fork_write,
                    plan=plan_snapshot,
                )
                parent_id = record.checkpoint_id

    async def _eval_condition(self, name: str, ctx: NodeContext) -> bool:
        """计划条件门按名求值（经注册表解析；异常按不满足处理，不阻断执行）。

        条件函数是业务判定（与条件边同语义）：失败视为不满足（跳过该
        计划步）并留痕——条件异常阻断整轮执行得不偿失，跳步是安全的
        降级（步骤本身会在后续规划中重估）。
        """
        registries = self.options.registries
        if registries is None:
            raise GraphDefinitionError(f"条件未注册（无注册表可解析）: {name}")
        try:
            condition = registries.edges.create(name)
            result = condition(ctx)
            if inspect.isawaitable(result):
                result = await result
            return bool(result)
        except Exception as exc:
            logger.warning(f"计划条件求值失败（按不满足处理）[{name}]: {exc}")
            return False

    async def _execute_plan_work_step(
        self,
        step: PlanStep,
        ctx: NodeContext,
        state: dict,
        graph: Graph,
        schema: StateSchema | None,
    ) -> _PlanWorkOutcome:
        """执行无节点形态的计划步（并行组/spawn 子任务），返回合并增量与控制流信号。

        顺序节点步不经过本方法（主循环逐节点执行，保留每节点 checkpoint
        粒度）；此处两种形态都内联消耗：
        - 并行组：同图节点隔离状态并发执行，结果按声明序合并；
        - spawn 步：子任务清单实例展开（展开执行器与 __spawn__ 共用）。
        """
        if step.kind == KIND_PARALLEL:
            return await self._run_parallel_group(step.nodes, ctx, state, graph)
        if step.kind == KIND_SPAWNS:
            return await self._run_plan_spawns(step.spawns, ctx)
        raise ValueError(f"未知计划步骤类型: {step.kind}")

    async def _run_parallel_group(
        self,
        names: tuple[str, ...],
        ctx: NodeContext,
        state: dict,
        graph: Graph,
    ) -> _PlanWorkOutcome:
        """并行节点组：隔离状态并发执行同图节点，结果按声明序合并。

        并发安全要点：
        - 每个成员持有状态快照（dict 拷贝——节点只返回增量不就地改状态，
          快照即隔离；事件/checkpoint 共享父引擎与父线程，seq 由引擎锁
          串行化）；
        - 成员内 spawn 收集经同一展开路径执行（实例并发上限按 spawn 配置）；
        - 失败语义与节点一致：error_on_exception=True = 整组失败（不合并
          任何成员结果，防部分成功污染计划流）；False = 失败成员剔除，
          成功成员按声明序合并；
        - 中断/终止（成员内 interrupt/terminate）以控制流信号返回：兄弟
          成员经 gather 自然取消，不残留后台写链。
        """
        outcome = _PlanWorkOutcome()
        semaphore = asyncio.Semaphore(self.options.parallel_concurrency)
        results: dict[str, dict | None] = {}
        errors: dict[str, str] = {}

        async def run_member(name: str) -> None:
            async with semaphore:
                member_ctx = _NodeContextImpl(
                    engine=self,
                    state=dict(state),
                    graph_path=ctx.graph_path,
                    round_id=ctx.round_id,
                    trace_id=ctx.trace_id,
                    thread_id=ctx._thread_id,
                    transports=ctx._transports,
                    resume_map=ctx.resume_map,
                )
                member_ctx.node = name
                if self.options.budget is not None:
                    try:
                        await self.options.budget.check(member_ctx)
                    except BudgetExceededError as exc:
                        # 预算超限 = 整组终止信号（与主循环同语义），不复用错误通道
                        outcome.terminate = TerminateReason.BUDGET_EXCEEDED
                        outcome.error = str(exc)
                        return
                    except Exception as exc:
                        outcome.terminate = TerminateReason.BUDGET_EXCEEDED
                        outcome.error = f"并行组预算检查失败: {exc}"
                        return
                # 输入调配预装配（与主循环同口径：节点执行前统一走调配管线，
                # 并行执行面同样留痕可审计）
                await member_ctx.preassemble()
                for attempt in range(self.options.max_node_retries + 1):
                    member_ctx._spawns.clear()
                    member_ctx._terminated = None
                    # 当前节点上下文注入（与主循环同口径）：并行成员执行期
                    # 间 LLM 用量记入成员节点账 + llm_usage 指标事件
                    member_token = current_node_context.set(member_ctx)
                    try:
                        fn = graph.nodes[name]
                        result = fn(member_ctx)
                        if inspect.isawaitable(result):
                            result = await result
                        if result is not None and not isinstance(result, dict):
                            raise TypeError(
                                f"节点返回非法增量类型: {type(result).__name__}"
                            )
                        # 成员内命令式/数据驱动 spawn：同路径展开（结果并入成员增量）
                        if member_ctx._spawns or (
                            result is not None and SPAWN_KEY in result
                        ):
                            specs = collect_spawn_specs(
                                result,
                                member_ctx._spawns,
                                resolve_graph=self._resolve_graph_data,
                            )
                            spawn_result = await self.run_spawned(
                                specs,
                                member_ctx,
                                concurrency=self.options.spawn_concurrency,
                            )
                            if spawn_result.failures:
                                for failure in spawn_result.failures:
                                    logger.warning(
                                        f"并行组成员 spawn 实例失败（剔除）[{name}] "
                                        f"index={failure.index}: {failure.error}"
                                    )
                            if spawn_result.overlay:
                                result = {**(result or {}), **spawn_result.overlay}
                        if result is not None and SIMULATE_KEY in result:
                            # 推演仅主循环支持：并行组成员返回 __simulate__
                            # 是图设计错误（决策点不应藏在并行组内），显式
                            # 拒绝——保留键泄漏进状态会造成静默丢失
                            raise RuntimeError(
                                "并行组成员不支持 __simulate__（决策点推演仅主循环执行）"
                            )
                        if result is not None and PLAN_KEY in result:
                            # 重规划仅主循环支持：并行组成员返回 __plan__
                            # 与并行组声明序合并语义冲突，保留键弹出不落
                            # 状态（与 __simulate__ 同属引擎保留键，泄漏
                            # 会破坏状态可序列化性）
                            result.pop(PLAN_KEY)
                            logger.warning(
                                f"并行组成员 {name} 返回的 __plan__ 已忽略"
                                "（重规划仅主循环执行）"
                            )
                        results[name] = result
                        if member_ctx.terminated:
                            outcome.terminate = (
                                member_ctx.terminate_reason or TerminateReason.REPLY
                            )
                        # 成员步骤留痕（与主循环同口径；成败定型后直入轨迹）
                        await self._trace_append_member(
                            member_ctx.graph_path, name, TRACE_SUCCESS
                        )
                        return
                    except InterruptSignal as sig:
                        outcome.interrupt = InterruptState(
                            key=sig.key,
                            payload=strip_sensitive(sig.payload),
                            node=name,
                            graph_path=ctx.graph_path,
                        )
                        await self._trace_append_member(
                            member_ctx.graph_path, name, TRACE_SKIPPED
                        )
                        return
                    except Exception as exc:
                        if attempt < self.options.max_node_retries:
                            continue
                        errors[name] = f"节点执行失败: {name}"
                        logger.error(
                            f"并行组成员执行失败 [{name}]: {exc}", exc_info=exc
                        )
                        await self._trace_append_member(
                            member_ctx.graph_path, name, TRACE_FAILED
                        )
                        return
                    finally:
                        current_node_context.reset(member_token)

        # 并发执行 + 首信号取消：任一成员中断/终止（或预算超限）时立即
        # 取消未完成兄弟成员（asyncio.gather 会等待全部成员——挂起成员的
        # 后台执行会残留写链/事件，污染恢复区间）
        tasks = [asyncio.create_task(run_member(name)) for name in names]
        try:
            while tasks:
                _, pending = await asyncio.wait(
                    tasks, return_when=asyncio.FIRST_COMPLETED
                )
                if outcome.interrupt is not None or outcome.terminate is not None:
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    break
                tasks = list(pending)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            # 检索全部任务结果（ENG2-9）：FIRST_COMPLETED 循环退出后已完成
            # 任务未 await，异常/取消永不检索——gather(return_exceptions=True)
            # 统一收取，杜绝 "Task exception was never retrieved" 告警
            await asyncio.gather(*tasks, return_exceptions=True)
        if outcome.interrupt is not None or outcome.terminate is not None:
            if outcome.terminate is not None:
                # 终止成员的 overlay 随终态保留（与单节点 terminate 同语义：
                # 节点返回增量先并入状态再终止——已完成的兄弟成员同样并入，
                # 不因组级终止丢弃成员产出）
                for name in names:
                    overlay = results.get(name)
                    if overlay:
                        outcome.overlay = {**outcome.overlay, **overlay}
            return outcome
        if errors:
            if self.options.error_on_exception:
                outcome.error = f"并行组失败 {len(errors)} 个成员: " + ", ".join(errors)
                await ctx.emit("error", {"node": ctx.node, "message": outcome.error})
                return outcome
            logger.warning(
                f"并行组成员失败（error_on_exception=False，剔除）: {errors}"
            )
        merged: dict = {}
        for name in names:
            overlay = results.get(name)
            if overlay:
                merged = {**merged, **overlay}
        outcome.overlay = merged
        return outcome

    async def _run_plan_spawns(
        self, items: tuple[dict, ...], ctx: NodeContext
    ) -> _PlanWorkOutcome:
        """计划 spawn 步：子任务清单实例展开（与 __spawn__ 共用展开执行器）。

        清单项经 :meth:`_resolve_graph_data` 解析（Graph 直通/图定义数据
        重建）；失败实例剔除不阻断计划流（与节点 spawn 同语义，留痕可见）。
        """
        outcome = _PlanWorkOutcome()
        overlay_payload = {SPAWN_KEY: [dict(item) for item in items]}
        try:
            specs = collect_spawn_specs(
                overlay_payload, [], resolve_graph=self._resolve_graph_data
            )
        except (ValueError, TypeError, GraphDefinitionError) as exc:
            logger.error(f"计划 spawn 清单非法: {exc}")
            await ctx.emit("error", {"node": ctx.node, "message": f"spawn 清单非法: {exc}"})
            outcome.error = f"spawn 清单非法: {exc}"
            return outcome
        if len(specs) > self.options.max_spawns:
            # 成本护栏：与主路径 __spawn__ 同语义（max_spawns 上限防清单爆炸）
            message = f"计划 spawn 清单超限: {len(specs)} > {self.options.max_spawns}"
            logger.error(f"计划 spawn 清单超限 [{ctx.node}]: {message}")
            await ctx.emit("error", {"node": ctx.node, "message": message})
            outcome.error = message
            return outcome
        try:
            spawn_result = await self.run_spawned(
                specs,
                ctx,
                concurrency=self.options.spawn_concurrency,
            )
        except InterruptSignal as sig:
            outcome.interrupt = InterruptState(
                key=sig.key,
                payload=strip_sensitive(sig.payload),
                node=ctx.node,
                graph_path=ctx.graph_path,
            )
            return outcome
        if spawn_result.failures:
            for failure in spawn_result.failures:
                logger.warning(
                    f"计划 spawn 实例失败（剔除，计划继续）index={failure.index}: {failure.error}"
                )
            if self.options.error_on_exception:
                # 与并行组同语义：error_on_exception=True = 计划步失败即中止
                # 计划（不合并部分成功污染计划流）；False = 剔除失败项继续
                outcome.error = (
                    f"计划 spawn 实例失败 {len(spawn_result.failures)} 个: "
                    + ", ".join(f"#{f.index}" for f in spawn_result.failures)
                )
                await ctx.emit("error", {"node": ctx.node, "message": outcome.error})
                return outcome
            await ctx.emit(
                "error",
                {
                    "node": ctx.node,
                    "message": (
                        f"spawn 实例失败 {len(spawn_result.failures)} 个（已剔除，计划继续）: "
                        + ", ".join(f"#{f.index}" for f in spawn_result.failures)
                    ),
                },
            )
        outcome.overlay = spawn_result.overlay
        return outcome

    def _resolve_graph_data(self, data: Any) -> Graph:
        """子图数据形态解析：Graph 直通；图定义数据经注册表重建。

        数据形态（spawn 清单/计划/推演分支携带的 dict 子图）要求引擎
        注入注册表（RunOptions.registries）——缺失时显式报错，不静默
        降级为执行错误。重建走完整校验（validate=True：悬挂入口/出口/
        边目标等结构错误在解析期暴露，与 harness 注册侧同口径——非法
        图定义不延后到执行期）。
        """
        if isinstance(data, Graph):
            return data
        if not isinstance(data, dict):
            raise ValueError(f"子图须为 Graph 或图定义数据: {type(data).__name__}")
        registries = self.options.registries
        if registries is None:
            raise ValueError("图定义数据需注册表解析（RunOptions.registries 未注入）")
        return Graph.from_dict(
            data,
            registry=registries.nodes,
            edge_registry=registries.edges,
            validate=True,
        )

    def _make_instance_engine(self, subgraph: Graph, spawn_depth: int) -> Engine:
        """实例引擎：独立实例（并发安全，不复用图级缓存——实例间互不干扰）。

        共享父引擎存储/schema/预算/传输配置；coordinator 共享（实例内
        interrupt 重入与父图同一通道）。实例链 checkpoint 的图版本 =
        子图自身指纹：跨引擎同源漂移由实例链自身的恢复校验覆盖（父链
        不重放实例事件，无需并入父指纹——图版本校验作用域 = 各自引擎
        的恢复锚点）。

        spawn_depth：子单元所在子链深度（子图/实例/分支执行引擎携带；
        嵌套校验基准 = 该深度，超限拒绝由展开入口执行）。
        """
        sub_engine = Engine(
            subgraph,
            options=RunOptions(
                storage=self.options.storage,
                schema=subgraph.schema or self.options.schema,
                budget=self.options.budget,
                transports=self.options.transports,
                max_node_retries=self.options.max_node_retries,
                error_on_exception=self.options.error_on_exception,
                # 成本护栏整体继承：父层显式禁用/收紧的 spawn 限制在实例层不旁落
                max_spawns=self.options.max_spawns,
                spawn_concurrency=self.options.spawn_concurrency,
                # 子链护栏随实例传播：嵌套深度上限与分支步数上限同口径，
                # 且子链深度 = 父深度 + 1（嵌套校验基准递进）
                spawn_max_depth=self.options.spawn_max_depth,
                simulate_max_branch_steps=self.options.simulate_max_branch_steps,
                # 执行回路护栏随实例传播（实例内同样有成本上界）
                max_cycle=self.options.max_cycle,
                spawn_depth=spawn_depth,
                # 建图注册表与计划配置随实例传播（数据形态子图/计划条件在
                # 实例层同样可解析；计划策略/护栏口径与父层一致）
                registries=self.options.registries,
                plan_policy=self.options.plan_policy,
                max_plan_steps=self.options.max_plan_steps,
                plan_workflow=self.options.plan_workflow,
                parallel_concurrency=self.options.parallel_concurrency,
                # 推演配置随实例传播（嵌套决策点/分支内再推演同口径：
                # 评估器/调配策略/分支护栏与父层一致）
                evaluator=self.options.evaluator,
                branch_mixer=self.options.branch_mixer,
                max_simulations=self.options.max_simulations,
                simulate_concurrency=self.options.simulate_concurrency,
                # 输入调配随实例传播（子任务/分支的执行面同样统一走
                # 调配管线——与父层同一装配配置与源提供者）
                assembly=self.options.assembly,
                assembly_sources=self.options.assembly_sources,
                # 系统信号/链级 rebase 窗口随实例传播：嵌套层不静默漂移
                system_events=self.options.system_events,
                checkpoint_keep=self.options.checkpoint_keep,
            ),
        )
        sub_engine._coordinator = self._coordinator
        return sub_engine

    async def run_spawned(
        self,
        specs: list[SpawnSpec],
        parent_ctx: NodeContext,
        *,
        concurrency: int,
    ) -> SpawnResult:
        """把子任务清单并发展开为子图实例，回收结果回流父图（公开接口）。

        Args:
            specs: 子任务清单（路由节点产出，按 index 顺序回流合并）。
            parent_ctx: 父图节点上下文（事件透传/中断共享/版本链归属）。
            concurrency: 并发上限（fan_out 限流，成本护栏）。

        Returns:
            SpawnResult：成功实例回流增量（按 index 升序合并，确定性）+ 失败清单。

        Raises:
            InterruptSignal: 任一实例内中断（提升为父图挂起卡，重入语义一致）。
        """
        parent: _NodeContextImpl = parent_ctx  # type: ignore[assignment]
        results: dict[int, dict] = {}
        failures: list[SpawnFailure] = []

        # 嵌套深度护栏（fail-closed）：子单元深度 = 当前子链深度 + 1；
        # 0 = 任意深度（按数据声明关闭校验）；超限直接拒绝展开——递归
        # 嵌套是成本爆炸的高发点，宁可显式失败不可静默放行
        child_depth = self.options.spawn_depth + 1
        if (
            self.options.spawn_max_depth > 0
            and child_depth > self.options.spawn_max_depth
        ):
            raise ValueError(
                f"spawn 嵌套深度超限: {child_depth} > {self.options.spawn_max_depth}"
            )

        async def run_one(index: int) -> None:
            spec = specs[index]
            sub_engine = self._make_instance_engine(spec.subgraph, child_depth)
            sub_path = (*parent_ctx.graph_path, spec.subgraph.name, str(spec.index))
            instance_thread = instance_thread_id(parent._thread_id, spec.index)
            # 恢复：实例从自身链尾续跑（中断/未终态 checkpoint 续跑，同回合
            # 挂卡重入不重跑已完成节点）；终态链尾（reply/stop/error 等 = 上
            # 一回合或已完成的陈旧结果）不作续跑锚点——从头执行，防多轮会话
            # 静默沿用旧结果。从头执行也续接实例链尾（版本链严格线性）。
            resume_from: int | None = None
            if self.options.storage is not None:
                tail = await tail_checkpoint(self.options.storage, instance_thread)
                if tail is not None and tail.reason in (None, "interrupted"):
                    resume_from = tail.checkpoint_id
                sub_engine._chain_advanced = True
            final_state, sub_result = await sub_engine._execute(
                state=instance_entry_state(spec, sub_engine.options.schema),
                thread_id=parent._thread_id,
                round_id=parent_ctx.round_id,
                resume_from=resume_from,
                trace_id=parent_ctx.trace_id,
                queue=None,
                graph_path=sub_path,
                # 继承父传输链（含顶层 run 队列）：实例事件汇入父事件流——
                # "事件统一父链、前端协议不变"（与静态子图 run_subgraph 同口径）
                transports=parent._transports,
                # checkpoint 独立子链：实例写入实例 thread，事件日志统一父链
                checkpoint_thread_id=instance_thread,
            )
            # 实例事件并入父引擎计数与 seq 锚点（事件统一落父链日志，父引擎
            # 后续 checkpoint 须以含实例事件的最新 seq 为锚，防恢复重放重复）
            self._event_counter += sub_engine._event_counter
            # 实例轨迹并入父引擎（结点级成败留痕跨层连续）
            self._trace_merge_from(sub_engine)
            if sub_engine._latest_event_seq is not None:
                self._latest_event_seq = (
                    sub_engine._latest_event_seq
                    if self._latest_event_seq is None
                    else max(self._latest_event_seq, sub_engine._latest_event_seq)
                )
            # 实例独立子链同样执行链级 rebase（回合内多轮累计，实例链
            # 行数与父链同轴增长；压缩只动实例链自身，事件日志归父链不裁剪）
            await self._maybe_compact_chain(instance_thread)
            # 实例内中断 → 提升为父图 interrupt（挂起卡跨层保留，重入语义一致）
            if sub_result.interrupt is not None:
                raise InterruptSignal(sub_result.interrupt.key, sub_result.interrupt.payload)
            # 实例步数截止护栏（ENG2-8，与推演分支/多径支流同口径——护栏
            # 口径统一为 simulate_max_branch_steps）：实例子链执行步数超限
            # = 该实例失败（剔除留痕，父链继续）——探测实例失控的成本
            # 截止点；0 = 按数据声明不校验
            step_limit = self.options.simulate_max_branch_steps
            if step_limit > 0 and sub_engine.executed_node_steps > step_limit:
                raise RuntimeError(
                    f"spawn 实例步数超限: {sub_engine.executed_node_steps} > {step_limit}"
                )
            # 实例终态为 ERROR：不入回流（剔除留痕，父链继续）——部分失败
            # 语义不允许失败实例的部分状态污染父图
            if sub_result.reason == TerminateReason.ERROR:
                raise RuntimeError(
                    sub_result.error or f"spawn 实例执行失败（index={index}）"
                )
            results[spec.index] = subgraph_overlay_delta(
                instance_entry_state(spec, sub_engine.options.schema),
                final_state,
                sub_engine.options.schema,
            )

        # 并发展开：部分失败剔除（成功结果回流，父链继续）；实例内中断为
        # 控制流异常（propagate 传播），中断时 fan_out 取消未完成兄弟实例
        outcome = await fan_out(
            [lambda i: run_one(i) for i in range(len(specs))],
            concurrency,
            propagate=InterruptSignal,
        )
        for failure in outcome.failures:
            real_index = specs[failure.index].index if failure.index < len(specs) else failure.index
            failures.append(SpawnFailure(real_index, failure.error))

        overlay: dict = {}
        for spec in sorted(specs, key=lambda s: s.index):
            if spec.index in results:
                overlay.update(results[spec.index])
        return SpawnResult(overlay=overlay, failures=failures)

    async def run_simulated(
        self,
        specs: list[SimulateSpec],
        parent_ctx: NodeContext,
        *,
        step_id: str | None = None,
        budget: int | None = None,
        concurrency: int,
    ) -> SimulationResult:
        """决策点推演：分支独立子链执行 → 评估 → 择优/调配 → 返回结果。

        分支执行与 spawn 实例同构（半共享上下文 + 独立 checkpoint 子链 +
        事件统一父链）；与 spawn 的差异在结果回收：spawn 全部结果回流，
        推演只提交择优后的分支（或跨分支组装产物），落选分支保留为轨迹
        树引用（checkpoint 子链 + 事件 parent_step_id）——可回溯对比/换选。

        Args:
            specs: 推演分支清单（决策点节点产出，index 全局唯一）。
            parent_ctx: 父图节点上下文（事件透传/中断共享/版本链归属）。
            step_id: 决策点步骤 id（分支事件 parent_step_id，轨迹树根；
                None = 分支不挂父引用，仍可经子链回溯）。
            budget: 主线上下文组装预算（透传给调配策略；None = 无限制）。
            concurrency: 分支并发上限（fan_out 限流，成本护栏）。

        Returns:
            SimulationResult：择优结果（选中分支/组装增量/来源留痕）+ 全部
            已完成评估的分支 + 分支子链 thread 引用表。

        Raises:
            InterruptSignal: 分支内中断（提升为父图挂起卡，重入语义一致）。
            SimulationError: 评估/调配失败或全部分支失败（决策点无产出，
                按节点失败收口，不静默提交空结果）。
        """
        parent: _NodeContextImpl = parent_ctx  # type: ignore[assignment]
        results: dict[int, dict] = {}
        branch_threads: dict[int, str] = {}
        failures: list[str] = []
        # 子单元深度 = 当前子链深度 + 1（分支引擎链内再展开子单元时按此基准校验）
        child_depth = self.options.spawn_depth + 1

        async def run_one(index: int) -> None:
            spec = specs[index]
            sub_engine = self._make_instance_engine(spec.subgraph, child_depth)
            sub_path = (*parent_ctx.graph_path, spec.subgraph.name, str(spec.index))
            branch_thread = simulate_thread_id(parent._thread_id, spec.index)
            branch_threads[spec.index] = branch_thread
            # 分支入口状态自包含（与 spawn 实例同语义：清单 state 完整入口，
            # 合并累加族通道归零——回流增量 = 分支内新增，防二次加和翻倍）
            entry_state = dict(spec.state)
            sub_schema = sub_engine.options.schema
            if sub_schema is not None:
                for key, channel in sub_schema.channels.items():
                    if is_merge_reducer(channel.reducer) and key in entry_state:
                        entry_state[key] = {}
            # 恢复：分支从自身链尾续跑（中断/未终态 checkpoint 续跑，同
            # spawn 实例语义）；终态链尾 = 陈旧结果，从头执行。
            resume_from: int | None = None
            if self.options.storage is not None:
                tail = await tail_checkpoint(self.options.storage, branch_thread)
                if tail is not None and tail.reason in (None, "interrupted"):
                    resume_from = tail.checkpoint_id
                sub_engine._chain_advanced = True
            final_state, sub_result = await sub_engine._execute(
                state=entry_state,
                thread_id=parent._thread_id,
                round_id=parent_ctx.round_id,
                resume_from=resume_from,
                trace_id=parent_ctx.trace_id,
                queue=None,
                graph_path=sub_path,
                # 继承父传输链（含顶层 run 队列）：分支事件汇入父事件流，
                # parent_step_id 指向决策点步骤（轨迹树引用）
                transports=parent._transports,
                checkpoint_thread_id=branch_thread,
                parent_step_id=step_id,
            )
            # 分支事件并入父引擎计数与 seq 锚点（与 spawn 实例同口径）
            self._event_counter += sub_engine._event_counter
            # 分支轨迹并入父引擎（结点级成败留痕跨层连续）
            self._trace_merge_from(sub_engine)
            if sub_engine._latest_event_seq is not None:
                self._latest_event_seq = (
                    sub_engine._latest_event_seq
                    if self._latest_event_seq is None
                    else max(self._latest_event_seq, sub_engine._latest_event_seq)
                )
            # 分支链不做链级压缩：落选分支的轨迹树引用（回溯对比/换选
            # 锚点）依赖完整子链，压缩会削掉中间 checkpoint
            if sub_result.interrupt is not None:
                raise InterruptSignal(
                    sub_result.interrupt.key, sub_result.interrupt.payload
                )
            # 分支步数截止护栏（fail-closed）：分支子链执行步数超限 = 该
            # 分支失败（剔除出评估，不静默提交）——探测分支失控的成本
            # 截止点；0 = 按数据声明不校验
            step_limit = self.options.simulate_max_branch_steps
            if step_limit > 0 and sub_engine.executed_node_steps > step_limit:
                raise RuntimeError(
                    f"推演分支步数超限: {sub_engine.executed_node_steps} > {step_limit}"
                )
            if sub_result.reason == TerminateReason.ERROR:
                raise RuntimeError(
                    sub_result.error or f"推演分支执行失败（index={index}）"
                )
            results[spec.index] = subgraph_overlay_delta(
                entry_state, final_state, sub_schema
            )

        # 换选路径（branch_pick 非 None）：只执行目标分支——其余分支的
        # 结果保留在各自独立子链（轨迹树引用可回溯对比/换选，无需重算）；
        # 正常择优路径全部分支并行推演。目标序号越界 = 换选目标不存在，
        # 显式报错（不静默回落择优）。
        pick = self.options.branch_pick
        run_indexes = list(range(len(specs)))
        if pick is not None:
            if pick < 0 or pick >= len(specs):
                raise SimulationError(
                    f"换选分支序号越界: {pick}（当前决策点共 {len(specs)} 个分支）"
                )
            run_indexes = [pick]
        outcome = await fan_out(
            # fan_out 的任务序号 = 任务列表位置，经默认参数捕获真实分支
            # 序号（换选路径只跑目标分支时列表位置与分支序号不再对齐）
            [lambda _pos, _idx=idx: run_one(_idx) for idx in run_indexes],
            concurrency,
            propagate=InterruptSignal,
        )
        for failure in outcome.failures:
            # 失败索引用真实分支/实例序号（fan_out 的 index 是任务列表
            # 位置；换选路径只跑目标分支时二者不对齐）
            real_index = specs[failure.index].index if failure.index < len(specs) else failure.index
            failures.append(f"#{real_index}: {failure.error}")

        # 分支执行失败剔除（部分失败语义，同 spawn）；全部失败 = 决策点
        # 无产出，显式报错（不静默提交空结果）
        successful = [spec for spec in specs if spec.index in results]
        if not successful:
            raise SimulationError(
                f"全部分支执行失败: {'; '.join(failures)}"
            )
        # 分支结果评估（Evaluator 协议：引擎规定产出，评审策略由用户集
        # 注入）；评估失败的分支剔除（该分支无可信评分，不得参与择优）
        evaluated: list[EvaluatedBranch] = []
        for spec in sorted(successful, key=lambda s: s.index):
            overlay = results[spec.index]
            try:
                evaluation = await self.options.evaluator.evaluate(spec, overlay)
            except Exception as exc:
                logger.warning(
                    f"推演分支评估失败（剔除）index={spec.index}: {exc}"
                )
                continue
            evaluated.append(
                EvaluatedBranch(spec=spec, overlay=overlay, evaluation=evaluation)
            )
        if not evaluated:
            raise SimulationError("全部成功分支评估失败（无可择优候选）")
        # 分支结果调配：单选或跨分支组装（调配器思想：多个分支结果 = 源、
        # 评估分 = weight、主线预算 = 预算）；调配失败 = 策略/配置问题，
        # 按节点失败收口（fail-fast，不静默单选）。换选路径（branch_pick
        # 非 None）：强制改选指定分支——目标分支不存在或未通过评估 =
        # 无可用的换选目标，显式报错（不静默回落择优）。
        pick = self.options.branch_pick
        if pick is not None:
            target = next((b for b in evaluated if b.spec.index == pick), None)
            if target is None or not target.evaluation.passed:
                raise SimulationError(
                    f"换选分支不可用（不存在或未通过评估）: {pick}"
                )
            selection = BranchSelection(
                selected=(pick,),
                overlay=dict(target.overlay),
                provenance=(
                    (ProvenanceNote(branch_index=pick, key="*", note="换选提交"),)
                    if target.overlay
                    else ()
                ),
            )
        else:
            mixer = self.options.branch_mixer or BestBranchMixer()
            try:
                selection = await mixer.mix(evaluated, budget=budget)
            except Exception as exc:
                raise SimulationError(f"分支调配失败: {exc}") from exc
        return SimulationResult(
            selection=selection,
            branches=tuple(evaluated),
            thread_ids=dict(branch_threads),
        )

    async def _run_multipath(
        self, data: Mapping[str, Any], ctx: NodeContext
    ) -> Any:
        """多径展开调度（ENG2-1/2/3 接线）：候选集 → MultipartRunner 执行。

        数据形态（组装编排节点产出）：``{request, candidates, entry_state,
        signal, k?, quality_gate?, synth_provider?}``——request/candidates
        为进程内对象（与 ``__spawn__`` 经 ``ctx._spawns`` 携带 Graph 对象
        同构，不落状态/checkpoint）。

        机制开关读装配运行期（get_default_assembly_runtime 挂载的多径位；
        未挂载 = 关闭 = 零触发）。证据存储/审计回调同源取自运行期；无
        运行期时按单径降级执行首候选（候选不静默丢弃）。
        """
        from .multipath import (
            MultiPathConfig,
            MultipathRunner,
        )
        from .path_assembler import get_default_assembly_runtime

        runtime = get_default_assembly_runtime()
        if runtime is None or not getattr(runtime, "multipath_enabled", False):
            # 防御性降级：开关关闭但清单存在（编排节点与运行期不同步）——
            # 按单径执行首候选，不静默丢弃候选
            return await self._run_multipath_degraded_single(data, ctx)
        runner = MultipathRunner(
            self,
            evidence_store=getattr(runtime, "evidence_store", None),
            config=MultiPathConfig(enabled=True),
            sink=getattr(runtime, "sink", None),
        )
        request = data["request"]
        candidates = list(data["candidates"] or ())
        entry_state = dict(data.get("entry_state") or {})
        if not candidates:
            raise ValueError("多径展开清单缺候选（编排节点产出非法）")
        # 注入透传（ENG2-12）：回合级注入值已在 run/ainvoke 入口进父
        # coordinator——支流与父图同一通道，但同 review_key 的注入值
        # 被首条命中支流 consume 后其余支流会抛 InterruptError；把父
        # coordinator 的待消费注入快照传给支流执行器，由支流侧按分支
        # 隔离（每条支流各持副本消费）
        return await runner.run(
            request,
            candidates,
            entry_state=entry_state,
            thread_id=ctx.thread_id,
            round_id=ctx.round_id,
            trace_id=ctx.trace_id,
            k=data.get("k"),
            quality_gate=data.get("quality_gate"),
            synth_provider=data.get("synth_provider"),
            inject=dict(self._coordinator.pending_inject) or None,
        )

    async def _run_multipath_degraded_single(
        self, data: Mapping[str, Any], ctx: NodeContext
    ) -> Any:
        """降级单径执行：不触发多径机制，仅执行首候选并回收增量。"""
        from .multipath import (
            MultiPathConfig,
            MultipathRunner,
        )

        runner = MultipathRunner(
            self,
            evidence_store=None,
            config=MultiPathConfig(enabled=True),
        )
        return await runner.run(
            data["request"],
            list(data["candidates"] or ())[:1],
            entry_state=dict(data.get("entry_state") or {}),
            thread_id=ctx.thread_id,
            round_id=ctx.round_id,
            trace_id=ctx.trace_id,
            k=1,
            concurrency=1,
        )


async def run_subgraph(subgraph: Graph, parent_ctx: NodeContext) -> dict | None:
    """嵌套图节点包装执行（graph.py _subgraph_runner 调用）。

    子图复用父引擎（共享 storage/transports/budget/coordinator——
    interrupt 在子图内同样可用），graph_path 追加子图名；子图最终状态
    整体作为增量返回父图（输出回流，reducer 合并，绝不静默丢值）。
    子图引擎按图内容 digest 缓存（ENG2-6：数据驱动子图每次新建实例，
    id() 缓存键永不命中 → 每次重复 compile；digest 键让同定义子图
    跨实例复用）；复用实例的事件计数由 _execute 入口复位（每轮从零
    起算，父引擎按差值合并，events_emitted 无历史轮残留）。

    schema 继承检查（ENG2-7）：子图自定义 schema 的 merge reducer 分类
    与父图不一致时回流语义错位（子图按自身口径剥离/求差，父图按自身
    口径合并——同通道分类不同 = 二次加和或丢值），首跑即显式拒绝。
    """
    parent: _NodeContextImpl = parent_ctx  # type: ignore[assignment]
    engine = parent._engine
    # 子图允许自定义 schema（业务子图按自身通道声明），未声明时继承父引擎 schema
    sub_schema = subgraph.schema or engine.options.schema
    if subgraph.schema is not None and engine.options.schema is not None:
        _validate_subgraph_schema_inheritance(
            parent_schema=engine.options.schema,
            sub_schema=subgraph.schema,
            subgraph_name=subgraph.name,
        )
    sub_engine = engine._subgraph_engines.get(subgraph.digest())
    if sub_engine is None:
        sub_engine = Engine(
            subgraph,
            options=RunOptions(
                storage=engine.options.storage,
                schema=sub_schema,
                budget=engine.options.budget,
                transports=engine.options.transports,
                max_node_retries=engine.options.max_node_retries,
                error_on_exception=engine.options.error_on_exception,
                # 成本护栏整体继承：父层禁用/收紧的 spawn 限制在子图内不旁落
                max_spawns=engine.options.max_spawns,
                spawn_concurrency=engine.options.spawn_concurrency,
                # 执行回路护栏随子图传播（嵌套层同样有成本上界）
                max_cycle=engine.options.max_cycle,
                # 建图注册表与计划配置随子图传播（数据形态子图/计划条件
                # 在子图内同样可解析；计划策略/护栏口径与父层一致）
                registries=engine.options.registries,
                plan_policy=engine.options.plan_policy,
                max_plan_steps=engine.options.max_plan_steps,
                plan_workflow=engine.options.plan_workflow,
                parallel_concurrency=engine.options.parallel_concurrency,
                # 推演配置随子图传播（嵌套决策点同口径：评估器/调配策略/
                # 分支护栏与父层一致）
                evaluator=engine.options.evaluator,
                branch_mixer=engine.options.branch_mixer,
                max_simulations=engine.options.max_simulations,
                simulate_concurrency=engine.options.simulate_concurrency,
                simulate_max_branch_steps=engine.options.simulate_max_branch_steps,
                # 输入调配随子图传播（嵌套子图执行面同样统一走调配管线）
                assembly=engine.options.assembly,
                assembly_sources=engine.options.assembly_sources,
                # 系统信号/链级 rebase 窗口随子图传播：嵌套层不静默漂移
                system_events=engine.options.system_events,
                checkpoint_keep=engine.options.checkpoint_keep,
            ),
        )
        engine._subgraph_engines[subgraph.digest()] = sub_engine
    # 共享父引擎 coordinator：子图内 interrupt 重入与父图同一通道
    sub_engine._coordinator = engine._coordinator
    entry_state = dict(parent_ctx.state)
    # 入口剥离合并累加族通道（merge_metrics/merge_dicts）：子图内从 0 起算，
    # 回流增量 = 子图内新增（父图 reducer 加和恰好一次，防二次加和翻倍）。
    # 分类声明化（is_merge_reducer）：业务注册的自定义合并 reducer 同样生效。
    # 按子图自身 schema 判定剥离集合：子图声明为合并累加族的通道才归零，
    # 未声明（或子图想原样继承）的通道保持父值透传——父 schema 仅描述父图
    # 归约，子图内实际执行累加的是子图 schema，两者不一致时以子图为准。
    schema = sub_engine.options.schema
    if schema is not None:
        for key, channel in schema.channels.items():
            if is_merge_reducer(channel.reducer) and key in entry_state:
                entry_state[key] = {}
    sub_path = (*parent_ctx.graph_path, subgraph.name)
    # 子图首写 checkpoint 的 parent 须跟随父链尾（版本链跨引擎线性连续——
    # 子图进入时链尾 = 父层最近 checkpoint；置位后由首写处统一查询并复位）
    if engine.options.storage is not None:
        sub_engine._chain_advanced = True
    final_state, sub_result = await sub_engine._execute(
        state=entry_state,
        thread_id=parent._thread_id,
        round_id=parent_ctx.round_id,
        # 恢复锚点消费即清除：同 run 内条件边回路二次进入同名子图不得复用
        # 旧锚点"恢复"（会跳过子图前段节点或直接收尾回流陈旧状态）
        resume_from=(parent_ctx.resume_map or {}).pop(sub_path, None),
        trace_id=parent_ctx.trace_id,
        queue=None,
        graph_path=sub_path,
        transports=parent._transports,  # 继承父传输链（含顶层队列）
        resume_map=parent_ctx.resume_map,
    )
    # 子图 checkpoint 推进版本链：父引擎下次写 checkpoint 前须查询链尾作为
    # parent（版本链严格线性；顺序执行路径则复用内存态，免每节点查询）。
    # 置于中断提升前：子图中断同样推进过链尾（中断 checkpoint 已写入）。
    if engine.options.storage is not None:
        engine._chain_advanced = True
    # 子图事件并入父引擎计数（父结果 events_emitted 含子图发射量）
    engine._event_counter += sub_engine._event_counter
    # 子图轨迹并入父引擎（结点级成败留痕跨层连续，沉淀回放同源）
    engine._trace_merge_from(sub_engine)
    # 子图事件 seq 同步回父引擎：子图事件已落父 thread 日志，父引擎
    # 后续 checkpoint 锚点须含子图事件 seq（否则恢复时子图事件被重复
    # 重放）。子图引擎 _latest_event_seq 与父引擎同读父日志，取大者。
    if sub_engine._latest_event_seq is not None:
        engine._latest_event_seq = (
            sub_engine._latest_event_seq
            if engine._latest_event_seq is None
            else max(engine._latest_event_seq, sub_engine._latest_event_seq)
        )
    # 子图内中断 → 提升为父图 interrupt（挂起卡跨嵌套层保留，重入语义一致）
    if sub_result.interrupt is not None:
        raise InterruptSignal(sub_result.interrupt.key, sub_result.interrupt.payload)
    # 子图终态为 ERROR → 向父图传播（与顶层 error_on_exception 语义一致：
    # 子图失败不得静默吞没，父图照常回流陈旧部分增量会掩盖数据损坏）。
    # 父层节点循环捕获后按 error_on_exception 决定终止或跳过。
    if sub_result.reason == TerminateReason.ERROR:
        raise NodeExecutionError(
            subgraph.name,
            RuntimeError(sub_result.error or f"子图执行失败: {subgraph.name}"),
        )
    # 子图终态 → 父图增量（delta = 子图内实际变化，防 reducer 加和翻倍）：
    # 子图执行以入口快照为基，reducer（merge_metrics 等）已把入口值并入
    # 终态——整体回流父图会二次加和。规则：
    # - add_messages 通道：返回新增消息（按 id 差集），父图追加恰好一次；
    # - 其余通道：返回终态（入口已剥离归零，终态即子图内新增）。
    # 分类判定用子图自身 schema：与入口剥离（run_subgraph 内同口径）一致，
    # 子图自定义 schema 的 additive/merge 声明不回流入父口径错位。
    return subgraph_overlay_delta(
        entry_state, final_state, sub_engine.options.schema
    )


def _validate_subgraph_schema_inheritance(
    *,
    parent_schema: StateSchema,
    sub_schema: StateSchema,
    subgraph_name: str,
) -> None:
    """子图 schema 与父图 merge reducer 分类的继承检查（ENG2-7）。

    回流语义依赖两端的 merge 分类一致：子图入口按**自身** schema 剥离
    合并累加族通道、回流增量按**自身** schema 求差，父图再按**自身**
    schema 合并——同一通道两端分类不同 = 二次加和（父合并子终态）或
    丢值（父覆盖子增量）。声明期（首跑）显式拒绝，不静默错位：

    - 子图声明 merge、父图未声明（或非 merge）→ 父图不合并子增量，
      父图既有值又已被入口剥离 → 丢值；
    - 父图声明 merge、子图声明非 merge → 子图不剥离入口、回流全量，
      父图合并 → 二次加和。
    """
    sub_merge = {
        key
        for key, channel in sub_schema.channels.items()
        if is_merge_reducer(channel.reducer)
    }
    parent_merge = {
        key
        for key, channel in parent_schema.channels.items()
        if is_merge_reducer(channel.reducer)
    }
    conflict = (sub_merge - parent_merge) | (
        parent_merge & (set(sub_schema.channels) - sub_merge)
    )
    if conflict:
        raise GraphDefinitionError(
            f"子图 {subgraph_name} 的 schema 与父图 merge reducer 声明不一致"
            f"（回流语义错位，拒绝执行）: {sorted(conflict)}"
            "——同通道的 merge 分类必须两端一致（子图未声明为 merge 的"
            "通道父图不得声明为 merge；子图声明为 merge 的通道父图必须"
            "同样声明）"
        )


__all__ = ["Engine", "RunOptions", "RunResult"]
