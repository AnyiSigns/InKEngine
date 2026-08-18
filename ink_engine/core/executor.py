"""执行引擎：run 执行循环（替代 langgraph StateGraph 执行/checkpoint/interrupt）。

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
"""
from __future__ import annotations

import asyncio
import inspect
import time
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field, replace
from typing import Any

from .budget import BudgetManager
from .events import EngineEvent, EngineTransport
from .exceptions import NodeExecutionError
from .fanout import fan_out
from .graph import Graph, NodeContext, TerminateReason
from .interrupt import InterruptCoordinator, InterruptSignal, InterruptState
from .logging import get_logger, trace_id_var
from .recovery import resolve_resume, tail_checkpoint
from .security import strip_sensitive
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
from .storage import CheckpointRecord, Storage

logger = get_logger(__name__)


@dataclass(slots=True)
class RunOptions:
    """单次 run 的引擎配置（DI：存储/传输/预算/状态 schema 均注入）。

    Attributes:
        storage: 存储服务（None = 纯内存执行，不持久化）。
        schema: 状态通道 schema（None = 全部裸通道覆盖语义）。
        budget: 预算管理器（None = 不检查）。
        transports: 事件传输列表（None = 仅执行不消费）。
        max_node_retries: 节点异常重试次数（0 = 不重试，直接终止）。
        error_on_exception: True = 节点异常终止本轮（reason=error）；
            False = 跳过异常节点继续（reason=stop 语义由业务边决定）。
        max_spawns: 单次展开的子任务清单数量上限（成本护栏：清单
            超限即节点失败，防拆解爆炸）。
        spawn_concurrency: spawn 实例并发上限（fan_out 限流）。
    """

    storage: Storage | None = None
    schema: StateSchema | None = None
    budget: BudgetManager | None = None
    transports: list[EngineTransport] = field(default_factory=list)
    max_node_retries: int = 0
    error_on_exception: bool = True
    max_spawns: int = 16
    spawn_concurrency: int = 4
    # 系统信号事件集合（宿主协议注入）：命中的事件类型强制 step_id=None、
    # 不入回合步骤序列（机制层默认空——不预置任何领域事件名）
    system_events: frozenset[str] = frozenset()


@dataclass(slots=True)
class RunResult:
    """run 执行结果（最终状态 + 终止原因 + 中断点 + 事件统计）。"""

    state: dict
    reason: str
    checkpoint_id: int | None = None
    interrupt: InterruptState | None = None
    events_emitted: int = 0
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "reason": self.reason,
            "checkpoint_id": self.checkpoint_id,
            "interrupt": self.interrupt.to_dict() if self.interrupt else None,
            "events_emitted": self.events_emitted,
            "error": self.error,
        }


class _QueueTransport:
    """内部传输：事件 → asyncio.Queue（顶层 run 的流式产出通道）。"""

    def __init__(self, queue: asyncio.Queue[EngineEvent]) -> None:
        self._queue = queue

    async def send(self, event: EngineEvent) -> None:
        await self._queue.put(event)


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

    @property
    def state(self) -> dict:
        return self._state

    @property
    def graph_path(self) -> tuple[str, ...]:
        return self._graph_path

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

    def terminate(self, reason: str, **meta: Any) -> None:
        """声明终止（校验延迟到执行器检查点：编程错误不被节点异常捕获吞掉）。"""
        self._terminated = reason

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


class Engine:
    """引擎实例：Graph + 配置的组装点（业务侧一次构建，多次 run）。

    并发模型：checkpoint 并发写保护在存储层（链尾乐观锁，冲突拒绝/重读），
    同实例并发 run 由存储层与业务层串行化保障。
    """

    def __init__(self, graph: Graph, *, options: RunOptions | None = None) -> None:
        self.graph = graph
        self.options = options or RunOptions()
        self.compiled = graph.compile()
        self._coordinator = InterruptCoordinator()
        self._event_counter = 0
        # 子图引擎缓存（嵌套图/循环/并行场景避免每次执行重复 compile）
        self._subgraph_engines: dict[int, Engine] = {}
        # 事件日志写失败降频时间戳（存储故障时避免每事件一条 ERROR 洪水）
        self._event_log_error_ts = 0.0
        # 内存态执行日志 seq（checkpoint 锚点权威来源；append_event 已返回 seq，
        # 避免每节点一次 latest_event_seq 查询；None = 尚未产生事件/无存储）
        self._latest_event_seq: int | None = None
        # 链尾推进标志：嵌套子图执行后置位（子图 checkpoint 推进版本链），
        # 下次写 checkpoint 前据此查询链尾作为 parent（避免顺序执行时每节点查询）
        self._chain_advanced = False

    async def _publish(
        self, event: EngineEvent, *, transports: list[EngineTransport] | None = None
    ) -> None:
        """事件发布：落执行日志（append-only，拿 seq）→ 推送全部传输。

        存储/传输消费失败都不影响主流程（观测不阻断执行）；存储故障按
        时间窗降频记录，避免 token 级事件流触发日志洪水。
        """
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
        """外部状态补丁（对齐 langgraph aupdate_state 语义）：读最新 checkpoint，
        按 schema reducer 合并 values 后写回新 checkpoint——不执行任何节点。

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
                追加——与 langgraph 续跑语义一致）。
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
        try:
            if inject:
                self._coordinator.inject(inject)
            if truncate_log_after is not None and self.options.storage is not None:
                await self.options.storage.truncate_events(thread_id, truncate_log_after)
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
            await task
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
        try:
            if inject:
                self._coordinator.inject(inject)
            if truncate_log_after is not None and self.options.storage is not None:
                await self.options.storage.truncate_events(thread_id, truncate_log_after)
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
            return result
        finally:
            if inject:
                for key in inject:
                    self._coordinator.pending_inject.pop(key, None)
            trace_id_var.reset(token)

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
        """
        graph = self.graph
        schema = self.options.schema
        storage = self.options.storage
        transports = transports if transports is not None else self.options.transports
        chain_thread = checkpoint_thread_id or thread_id

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
        )
        # 恢复起点定位：
        # - 中断 checkpoint（reason=interrupted）：重入中断节点（节点内按注入值分支）；
        # - 异常 checkpoint（reason=error）：重入失败节点（该节点未完成，
        #   恢复即重试；error_on_exception=False 的跳过语义不落 error 终态）；
        # - 正常 checkpoint（节点已完成）：从已完成节点的下一节点继续，不重跑已完成节点。
        skip_first_node = False
        if last_checkpoint is not None and last_checkpoint.node:
            if last_checkpoint.reason in ("interrupted", TerminateReason.ERROR):
                current = last_checkpoint.node
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

            # ── 恢复终点：已完成节点无出边，直接进入终态收尾 ──
            if skip_first_node:
                skip_first_node = False
                # 终态快照沿用恢复锚点的已完成节点：回写入口节点会让链尾
                # 变成"entry 已完成"，后续 resume 从 entry 的下一节点整图
                # 重跑（重复执行 + 重复写 checkpoint）
                if last_checkpoint is not None and last_checkpoint.node:
                    current = last_checkpoint.node
                break

            # ── 预算检查（节点边界，策略由业务注册）──
            if self.options.budget is not None:
                try:
                    await self.options.budget.check(ctx)
                except Exception as exc:
                    reason = TerminateReason.BUDGET_EXCEEDED
                    error_msg = str(exc)
                    break

            # ── 执行节点（重试 N 次 / 终止；兼容同步/异步节点函数）──
            overlay: dict | None = None
            node_error: str | None = None
            for attempt in range(self.options.max_node_retries + 1):
                # 每次尝试复位收集器与终止标记：失败尝试的残留清单不得在
                # 重试成功后一并展开（序号冲突/重复执行），终止信号同理
                ctx._spawns.clear()
                ctx._terminated = None
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
            if interrupt_state is not None:
                break
            if reason in (TerminateReason.ERROR, TerminateReason.STOP):
                break

            # ── 增量类型防线：节点必须返回 dict（或 None）──
            if overlay is not None and not isinstance(overlay, dict):
                node_error = f"节点返回非法增量类型: {type(overlay).__name__}（须为 dict 或 None）"
                logger.error(f"节点返回非法增量类型 [{current}]: {type(overlay).__name__}")
                await ctx.emit("error", {"node": current, "message": node_error})
                error_msg = node_error
                reason = TerminateReason.ERROR
                break

            # ── spawn 清单提取（保留键不落状态；与命令式收集项合并）──
            if self.options.max_spawns > 0:
                try:
                    spawn_specs = collect_spawn_specs(overlay, ctx._spawns)
                    # 命令式清单一次性消费：清空收集器，防清单泄漏到后续
                    # 节点被重复展开（数据驱动项已随 overlay 弹出，不重复）
                    ctx._spawns.clear()
                except (ValueError, TypeError) as exc:
                    # TypeError 双保险：不可信清单的类型错误必须走同一
                    # 错误路径（终态 checkpoint + error 事件），不得穿出
                    node_error = f"spawn 清单非法: {exc}"
                    logger.error(f"spawn 清单非法 [{current}]: {exc}")
                    await ctx.emit("error", {"node": current, "message": node_error})
                    error_msg = node_error
                    reason = TerminateReason.ERROR
                    break
            else:
                spawn_specs = []
                # spawn 禁用：保留键仍须从增量弹出（不落状态/checkpoint——
                # 清单含 Graph 对象，泄漏会破坏状态可序列化性）
                if overlay is not None and SPAWN_KEY in overlay:
                    overlay.pop(SPAWN_KEY)

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
                if len(spawn_specs) > self.options.max_spawns:
                    node_error = (
                        f"spawn 清单超限: {len(spawn_specs)} > {self.options.max_spawns}"
                    )
                    logger.error(f"spawn 清单超限 [{current}]: {node_error}")
                    await ctx.emit("error", {"node": current, "message": node_error})
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

            # ── checkpoint 快照（每节点完成，版本链）──
            if storage is not None:
                # 恢复锚点权威来源 = 事件日志本身（跨实例/跨 run/子图事件全部
                # 自然包含，无内存态依赖；恢复 = 快照 + 该 seq 之后的增量重放）。
                # seq 取内存态（_publish 已维护），避免每节点一次 latest_event_seq 查询。
                event_seq = (
                    self._latest_event_seq
                    if self._latest_event_seq is not None
                    else await storage.latest_event_seq(thread_id)
                )
                if self._chain_advanced:
                    # 嵌套子图/spawn 实例推进过链尾（或恢复续跑）：parent 跟随
                    # 当前链尾（版本链严格线性，跨引擎连续），查一次后复位
                    _tail = await tail_checkpoint(storage, chain_thread)
                    if _tail is not None:
                        parent_id = _tail.checkpoint_id
                    self._chain_advanced = False
                last_checkpoint = await storage.put_checkpoint(
                    CheckpointRecord(
                        checkpoint_id=0,
                        thread_id=chain_thread,
                        node=current,
                        graph_path=ctx.graph_path,
                        state=current_state,
                        parent_id=parent_id,
                        event_seq=event_seq,
                    ),
                    # 编辑重放分叉（parent_checkpoint 锚点指向历史链）：首写跳过
                    # 链尾校验，其余写正常续链（存储层原子校验并发写）
                    fork=fork_write,
                )
                fork_write = False
                parent_id = last_checkpoint.checkpoint_id

            # ── 条件边选下一节点 / 出口 ──
            if current in graph.exits:
                reason = TerminateReason.REPLY
                break
            nxt = await _select_next_node(graph, ctx, current)
            if nxt is None:
                # 无出边且非 exit：图定义不完备，按 stop 终止（入轨迹可诊断）
                if current not in graph.exits:
                    reason = TerminateReason.STOP
                break
            current = nxt

        # ── 终态 checkpoint（携带终止原因/异常快照，入轨迹与审计）──
        if storage is not None:
            event_seq = (
                self._latest_event_seq
                if self._latest_event_seq is not None
                else await storage.latest_event_seq(thread_id)
            )
            if self._chain_advanced:
                # 版本链严格线性：parent 跟随当前链尾（与节点 checkpoint 同语义）
                _tail = await tail_checkpoint(storage, chain_thread)
                if _tail is not None:
                    parent_id = _tail.checkpoint_id
                self._chain_advanced = False
            last_checkpoint = await storage.put_checkpoint(
                CheckpointRecord(
                    checkpoint_id=0,
                    thread_id=chain_thread,
                    node=current,
                    graph_path=ctx.graph_path,
                    state=current_state,
                    parent_id=parent_id,
                    reason=reason,
                    event_seq=event_seq,
                    error=error_msg,
                    # 挂起卡状态随终态快照持久化：reason=interrupted 时携带
                    # 中断键与卡负载（续流恢复定位锚点，宿主据此注入决策值）
                    interrupt=interrupt_state,
                ),
                fork=fork_write,
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

    def _make_instance_engine(self, subgraph: Graph) -> Engine:
        """实例引擎：独立实例（并发安全，不复用图级缓存——实例间互不干扰）。

        共享父引擎存储/schema/预算/传输配置；coordinator 共享（实例内
        interrupt 重入与父图同一通道）。
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

        async def run_one(index: int) -> None:
            spec = specs[index]
            sub_engine = self._make_instance_engine(spec.subgraph)
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
            if sub_engine._latest_event_seq is not None:
                self._latest_event_seq = (
                    sub_engine._latest_event_seq
                    if self._latest_event_seq is None
                    else max(self._latest_event_seq, sub_engine._latest_event_seq)
                )
            # 实例内中断 → 提升为父图 interrupt（挂起卡跨层保留，重入语义一致）
            if sub_result.interrupt is not None:
                raise InterruptSignal(sub_result.interrupt.key, sub_result.interrupt.payload)
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
            failures.append(SpawnFailure(failure.index, failure.error))

        overlay: dict = {}
        for spec in sorted(specs, key=lambda s: s.index):
            if spec.index in results:
                overlay.update(results[spec.index])
        return SpawnResult(overlay=overlay, failures=failures)


async def run_subgraph(subgraph: Graph, parent_ctx: NodeContext) -> dict | None:
    """嵌套图节点包装执行（graph.py _subgraph_runner 调用）。

    子图复用父引擎（共享 storage/transports/budget/coordinator——
    interrupt 在子图内同样可用），graph_path 追加子图名；子图最终状态
    整体作为增量返回父图（输出回流，reducer 合并，绝不静默丢值）。
    子图引擎按图实例缓存（循环/并行场景避免每次执行重复 compile）；
    复用实例的事件计数跨执行累加，events_emitted 用差值统计不受影响。
    """
    parent: _NodeContextImpl = parent_ctx  # type: ignore[assignment]
    engine = parent._engine
    sub_engine = engine._subgraph_engines.get(id(subgraph))
    if sub_engine is None:
        # 子图允许自定义 schema（业务子图按自身通道声明），未声明时继承父引擎 schema
        sub_schema = subgraph.schema or engine.options.schema
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
            ),
        )
        engine._subgraph_engines[id(subgraph)] = sub_engine
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


__all__ = ["Engine", "RunOptions", "RunResult"]
