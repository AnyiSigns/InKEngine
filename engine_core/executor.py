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
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any

from .budget import BudgetManager
from .events import EngineEvent, EngineTransport, is_system_event
from .exceptions import NodeExecutionError, StorageError
from .graph import Graph, NodeContext, TerminateReason
from .interrupt import InterruptCoordinator, InterruptSignal, InterruptState
from .logging import get_logger, trace_id_var
from .security import strip_sensitive
from .state import StateSchema
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
    """

    storage: Storage | None = None
    schema: StateSchema | None = None
    budget: BudgetManager | None = None
    transports: list[EngineTransport] = field(default_factory=list)
    max_node_retries: int = 0
    error_on_exception: bool = True


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

        系统信号（chapter_written/title_update/regenerated_from/end）不入
        回合步骤序列——强制 step_id=None，与协议 v2 语义对齐。
        """
        if is_system_event(etype):
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

    def terminate(self, reason: str, **meta: Any) -> None:
        """声明终止（校验延迟到执行器检查点：编程错误不被节点异常捕获吞掉）。"""
        self._terminated = reason

async def _select_next_node(graph: Graph, ctx: NodeContext, current: str) -> str | None:
    """选择下一节点：静态边直接取；条件边逐条判定（首个为真生效）。

    条件边兼容同步/异步判定（``inspect.isawaitable`` 检测），业务可写
    同步 lambda 或 async 函数，无需关心执行器形态。
    """
    import inspect

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
        # 子图引擎缓存（嵌套图/循环/发散场景避免每次执行重复 compile）
        self._subgraph_engines: dict[int, Engine] = {}
        # 事件日志写失败降频时间戳（存储故障时避免每事件一条 ERROR 洪水）
        self._event_log_error_ts = 0.0

    async def _publish(
        self, event: EngineEvent, *, transports: list[EngineTransport] | None = None
    ) -> None:
        """事件发布：落执行日志（append-only，拿 seq）→ 推送全部传输。

        存储/传输消费失败都不影响主流程（观测不阻断执行）；存储故障按
        时间窗降频记录，避免 token 级事件流触发日志洪水。
        """
        import time
        from dataclasses import replace

        self._event_counter += 1
        if self.options.storage is not None:
            try:
                seq = await self.options.storage.append_event(event.thread_id, event)
                event = replace(event, seq=seq)
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

    async def run(
        self,
        state: dict,
        *,
        thread_id: str | None = None,
        round_id: str | None = None,
        resume_from: int | None = None,
        inject: dict[str, Any] | None = None,
        trace_id: str | None = None,
        truncate_log_after: int | None = None,
        parent_checkpoint: int | None = None,
    ) -> AsyncGenerator[EngineEvent, None]:
        """流式执行入口：产出事件流（含子图事件，顺序 = 发射顺序）。

        Args:
            state: 初始状态（无 checkpoint 时）。
            thread_id: 会话/线程 id（版本链归属，None = 自动生成）。
            round_id: 回合 id（事件契约）。
            resume_from: checkpoint_id 锚点（恢复/续流；None = 从头执行）。
            inject: interrupt 注入值（{review_key: value}，重入语义）。
            trace_id: 链路追踪 ID（None = 自动生成）。
            truncate_log_after: 编辑重放：先截断执行日志 seq 之后（删除
                目标之后步骤，失效区保留），再续跑。
            parent_checkpoint: 编辑重放：新 checkpoint 链的父锚点（分叉）。
        """
        thread_id = thread_id or f"thread-{uuid.uuid4().hex[:12]}"
        trace_id = trace_id or uuid.uuid4().hex
        token = trace_id_var.set(trace_id)
        queue: asyncio.Queue[EngineEvent | None] = asyncio.Queue()
        # 事件流产出通道挂到传输列表（顺序 = 发射顺序；挂载后事件既落日志又进队列）
        transports = [*self.options.transports, _QueueTransport(queue)]
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
            # 清理本轮注入但未被消费的值：注入值一次性（已注入决策的审批视为
            # 放弃，防门控绕过），残留会泄漏到下一次 run 被静默消费
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
        parent_ctx: _NodeContextImpl | None = None,
        graph_path: tuple[str, ...] = (),
        transports: list[EngineTransport] | None = None,
    ) -> tuple[dict, RunResult]:
        """主执行循环（顶层与嵌套子图共用）。

        Args:
            parent_ctx: 嵌套子图执行时父上下文（事件经父 graph_path 透传，
                子图最终状态作为增量返回父图）。
            graph_path: 本图执行的事件路径（顶层 ()；子图 = 父路径 + 子图名）。
            transports: 事件传输列表（None = 引擎 options 默认；顶层 run
                传入含队列的传输链，子图 None 走共享传输）。
        """
        graph = self.graph
        schema = self.options.schema
        storage = self.options.storage
        transports = transports if transports is not None else self.options.transports

        # ── 恢复：checkpoint 快照 + 增量日志重放（断线续流）──
        current: str = graph.entry
        current_state = dict(state)
        last_checkpoint: CheckpointRecord | None = None
        if resume_from is not None and storage is not None:
            last_checkpoint = await storage.get_checkpoint(resume_from)
            if last_checkpoint is None:
                raise StorageError(f"恢复锚点不存在: {resume_from}")
            current_state = dict(last_checkpoint.state)
            # 增量日志重放：把 checkpoint 之后的事件补发给传输（断线续流）
            if queue is not None:
                for event in await storage.events_after(thread_id, last_checkpoint.event_seq):
                    await queue.put(event)

        ctx = _NodeContextImpl(
            engine=self,
            state=current_state,
            graph_path=graph_path,
            round_id=round_id,
            trace_id=trace_id,
            thread_id=thread_id,
            transports=transports,
        )
        # 恢复起点定位：
        # - 中断 checkpoint（reason=interrupted）：重入中断节点（节点内按注入值分支）；
        # - 正常 checkpoint（节点已完成）：从已完成节点的下一节点继续，不重跑已完成节点。
        skip_first_node = False
        if last_checkpoint is not None and last_checkpoint.node:
            if last_checkpoint.reason == "interrupted":
                current = last_checkpoint.node
            else:
                nxt = await _select_next_node(graph, ctx, last_checkpoint.node)
                if nxt is not None:
                    current = nxt
                else:
                    # 已完成节点无出边：图已走完（或节点为出口），终止不再执行
                    skip_first_node = True
        parent_id = parent_checkpoint or (last_checkpoint.checkpoint_id if last_checkpoint else None)
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
            import inspect

            overlay: dict | None = None
            node_error: str | None = None
            for attempt in range(self.options.max_node_retries + 1):
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

            # ── checkpoint 快照（每节点完成，版本链）──
            if storage is not None:
                # 恢复锚点权威来源 = 事件日志本身（跨实例/跨 run/子图事件全部
                # 自然包含，无内存态依赖；恢复 = 快照 + 该 seq 之后的增量重放）
                event_seq = await storage.latest_event_seq(thread_id)
                last_checkpoint = await storage.put_checkpoint(
                    CheckpointRecord(
                        checkpoint_id=0,
                        thread_id=thread_id,
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
            event_seq = await storage.latest_event_seq(thread_id)
            last_checkpoint = await storage.put_checkpoint(
                CheckpointRecord(
                    checkpoint_id=0,
                    thread_id=thread_id,
                    node=current,
                    graph_path=ctx.graph_path,
                    state=current_state,
                    parent_id=parent_id,
                    reason=reason,
                    event_seq=event_seq,
                    error=error_msg,
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


async def run_subgraph(subgraph: Graph, parent_ctx: NodeContext) -> dict | None:
    """嵌套图节点包装执行（graph.py _subgraph_runner 调用）。

    子图复用父引擎（共享 storage/transports/budget/coordinator——
    interrupt 在子图内同样可用），graph_path 追加子图名；子图最终状态
    整体作为增量返回父图（输出回流，reducer 合并，绝不静默丢值）。
    子图引擎按图实例缓存（循环/发散场景避免每次执行重复 compile）；
    复用实例的事件计数跨执行累加，events_emitted 用差值统计不受影响。
    """
    parent: _NodeContextImpl = parent_ctx  # type: ignore[assignment]
    engine = parent._engine
    sub_engine = engine._subgraph_engines.get(id(subgraph))
    if sub_engine is None:
        sub_engine = Engine(subgraph, options=engine.options)
        engine._subgraph_engines[id(subgraph)] = sub_engine
    # 共享父引擎 coordinator：子图内 interrupt 重入与父图同一通道
    sub_engine._coordinator = engine._coordinator
    final_state, sub_result = await sub_engine._execute(
        state=dict(parent_ctx.state),
        thread_id=parent._thread_id,
        round_id=parent_ctx.round_id,
        resume_from=None,
        trace_id=parent_ctx.trace_id,
        queue=None,
        graph_path=(*parent_ctx.graph_path, subgraph.name),
        transports=parent._transports,  # 继承父传输链（含顶层队列）
    )
    # 子图内中断 → 提升为父图 interrupt（挂起卡跨嵌套层保留，重入语义一致）
    if sub_result.interrupt is not None:
        raise InterruptSignal(sub_result.interrupt.key, sub_result.interrupt.payload)
    # 子图事件并入父引擎计数（父结果 events_emitted 含子图发射量）
    engine._event_counter += sub_engine._event_counter
    return final_state


__all__ = ["Engine", "RunOptions", "RunResult"]
