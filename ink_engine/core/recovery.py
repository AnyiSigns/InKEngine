"""恢复/续流解析（checkpoint 锚点解析 + 增量日志重放 + 子图锚点回溯）。

executor 的恢复面在此收敛：resume 语义（断线续流/新回合续链/编辑重放）
的锚点选择、输入状态覆盖、事件重放、嵌套子图锚点回溯，全部为纯解析
函数——不触碰引擎运行态（计数器/链尾标志由调用方在解析后设置），
可独立测试。

恢复模型：checkpoint 版本链快照 + 执行事件日志（append-only）——
恢复 = 读取 checkpoint 快照 + 增量日志重放（断线续流）；编辑重放 =
日志截断 + 新分支（truncate_log_after + parent_checkpoint）。

重放纪律：事件只从「最终锚点」重放一次（resume_from 锚点与回溯出的
顶层锚点取后者，其 event_seq 不高于前者，重放区间为超集——先重放
子集再重放超集会在流中出现重复事件）。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .events import EngineEvent
from .exceptions import StorageError
from .state import StateSchema
from .storage import CheckpointRecord, Storage


@dataclass(slots=True)
class ResumeResolution:
    """恢复解析结果：基底状态 + 恢复锚点 + 子图锚点表 + 待重放事件。"""

    state: dict
    last_checkpoint: CheckpointRecord | None
    resume_map: dict[tuple[str, ...], int] = field(default_factory=dict)
    replay: tuple[EngineEvent, ...] = ()


async def tail_checkpoint(storage: Storage, thread_id: str) -> CheckpointRecord | None:
    """查询版本链链尾（跨引擎续链的 parent 跟随用）。"""
    return await storage.get_latest_checkpoint(thread_id)


async def resolve_resume(
    *,
    storage: Storage | None,
    state: dict,
    schema: StateSchema | None,
    thread_id: str,
    chain_thread: str,
    resume_from: int | None,
    continue_chain: bool,
    graph_path: tuple[str, ...],
    replay: bool,
    resume_map: dict[tuple[str, ...], int] | None,
) -> ResumeResolution:
    """解析恢复起点：初始状态归一化 + 续链/续跑锚点 + 锚点回溯 + 重放清单。

    Args:
        storage: 存储服务（None = 纯内存执行，无恢复语义）。
        state: 输入状态（无 checkpoint 时的初始值 / 恢复时的覆盖层）。
        schema: 状态通道 schema（None = 全部裸通道覆盖语义）。
        thread_id: 事件日志归属线程（事件重放按此查询）。
        chain_thread: checkpoint 版本链归属（spawn 实例 = 独立子链）。
        resume_from: checkpoint_id 锚点（恢复/续流；None = 从头执行）。
        continue_chain: 新回合续链（读链尾为基底，输入 state 覆盖后从入口执行）。
        graph_path: 本图执行路径（顶层 () 才做嵌套子图锚点回溯）。
        replay: 是否收集增量日志重放（顶层事件流挂载时）。
        resume_map: 嵌套子图恢复锚点表（graph_path → checkpoint_id）。

    Returns:
        ResumeResolution：基底状态 + 最终恢复锚点 + 子图锚点表 + 重放事件。
    """
    current_state = (
        schema.apply({}, state) if schema is not None else dict(state)
    )
    last_checkpoint: CheckpointRecord | None = None
    resume_map = dict(resume_map or {})
    replay_events: list[EngineEvent] = []
    if continue_chain and storage is not None:
        # 新回合续链：读链尾 checkpoint 为基底，输入 state 经 schema 覆盖
        # 合并（消息追加/指标复位等 reducer 语义），从入口执行，版本链
        # 续接链尾——不重放事件（新回合事件全新产生）。
        last_checkpoint = await storage.get_latest_checkpoint(chain_thread)
        if last_checkpoint is not None:
            base = dict(last_checkpoint.state)
            current_state = schema.apply(base, state) if schema else {
                **base, **state
            }
    elif resume_from is not None and storage is not None:
        # 恢复续跑：历史链尾可能已推进（上次中断/子图锚点），首写 parent
        # 须跟随当前链尾——由调用方置位链尾标志，写入处统一查询。
        last_checkpoint = await storage.get_checkpoint(resume_from)
        if last_checkpoint is None:
            raise StorageError(f"恢复锚点不存在: {resume_from}")
        # 输入 state 作为覆盖层（对齐 langgraph 续跑语义）：checkpoint 状态
        # 为基底，输入中提供的通道值经 reducer 合并（弹卡注入的 decision/
        # 清空的一次性状态等），缺失键保留 checkpoint 值
        current_state = dict(last_checkpoint.state)
        if state:
            current_state = schema.apply(current_state, state) if schema else {
                **current_state, **state
            }
        # 增量日志重放：把 checkpoint 之后的事件补发给传输（断线续流）；
        # 顶层锚点回溯后若找到更近的顶层锚点，重放区间以顶层锚点为准
        # （超集一次，防重复事件）。
        if replay:
            replay_events = await storage.events_after(
                thread_id, last_checkpoint.event_seq
            )
        # 顶层引擎（graph_path 空）：锚点可能落在任一层（含嵌套子图内），
        # 沿版本链回溯收集各级恢复锚点（graph_path → checkpoint_id）——
        # 中断链上每级引擎都写有 interrupted checkpoint（顶层中断锚点的
        # 父链含各级子图锚点），各级从各自最近 checkpoint 恢复，子图锚点
        # 经 resume_map 下沉（子图 runner 路径匹配时传给子图引擎，
        # 跳过祖先节点重执行）。子图引擎（graph_path 非空）收到的
        # resume_from 已匹配本层路径，直接恢复不再回溯。
        if not graph_path:
            top_anchor, resume_map = await collect_resume_anchors(
                storage, last_checkpoint, resume_map
            )
            if top_anchor is not None:
                last_checkpoint = await storage.get_checkpoint(top_anchor)
                current_state = dict(last_checkpoint.state)
                if replay:
                    replay_events = await storage.events_after(
                        thread_id, last_checkpoint.event_seq
                    )
            else:
                # 顶层锚点缺失（图入口即子图）：本级从入口开始，子图锚点
                # 保留在 resume_map（到达路径匹配的子图节点时恢复）
                last_checkpoint = None
                current_state = dict(state)
    return ResumeResolution(
        state=current_state,
        last_checkpoint=last_checkpoint,
        resume_map=resume_map,
        replay=tuple(replay_events),
    )


async def collect_resume_anchors(
    storage: Storage,
    tail: CheckpointRecord,
    resume_map: dict[tuple[str, ...], int],
) -> tuple[int | None, dict[tuple[str, ...], int]]:
    """沿版本链回溯收集恢复锚点（顶层中断 checkpoint 的父链含各级子图锚点）。

    - 非空路径节点：仅收未完成/中断锚点（reason 为 None 的节点快照或
      interrupted 挂起轮）——reply/stop/error 终态 = 已完成子图的陈旧
      结果，作恢复锚点会让子图直接收尾回流旧状态；
    - 空路径节点：最近的顶层锚点（本级恢复起点）。

    Returns:
        (top_anchor, resume_map)：顶层锚点 checkpoint_id（None = 图入口
        即子图，本级无顶层锚点）+ 子图锚点表（沿用传入表，逐级补录）。
    """
    cp: CheckpointRecord | None = tail
    top_anchor: int | None = None
    while cp is not None:
        path = cp.graph_path or ()
        if path:
            if cp.reason in (None, "interrupted"):
                resume_map.setdefault(path, cp.checkpoint_id)
        elif top_anchor is None:
            top_anchor = cp.checkpoint_id  # 最近的顶层锚点
        # 继续沿父链回溯：顶层中断 checkpoint 的父链含子图层锚点
        cp = (
            await storage.get_checkpoint(cp.parent_id)
            if cp.parent_id is not None
            else None
        )
    return top_anchor, resume_map


__all__ = [
    "ResumeResolution",
    "collect_resume_anchors",
    "resolve_resume",
    "tail_checkpoint",
]
