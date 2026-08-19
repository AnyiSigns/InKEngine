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
from .exceptions import GraphVersionMismatchError, StorageError
from .state import StateSchema
from .storage import ChainLink, CheckpointRecord, Storage


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
    graph_version: str | None = None,
) -> ResumeResolution:
    """解析恢复起点：初始状态归一化 + 续链/续跑锚点 + 锚点回溯 + 重放清单。

    Args:
        storage: 存储服务（None = 纯内存执行，无恢复语义）。
        state: 输入状态（无 checkpoint 时的初始值 / 恢复时的覆盖层）。
        schema: 状态通道 schema（None = 全部裸通道覆盖语义）。
        thread_id: 事件日志归属线程（事件重放按此查询）。
        chain_thread: checkpoint 版本链归属（spawn 实例 = 独立子链）。
        resume_from: checkpoint_id 锚点（恢复/续跑；None = 从头执行）。
        continue_chain: 新回合续链（读链尾为基底，输入 state 覆盖后从入口执行）。
        graph_path: 本图执行路径（顶层 () 才做嵌套子图锚点回溯）。
        replay: 是否收集增量日志重放（顶层事件流挂载时）。
        resume_map: 嵌套子图恢复锚点表（graph_path → checkpoint_id）。
        graph_version: 当前图内容指纹（None = 不校验）。恢复锚点携带的图
            指纹与当前图不一致 = 图定义已变更，恢复语义不保证——显式拒绝
            （GraphVersionMismatchError）而非静默错位续跑。只对 resume_from
            真恢复生效；continue_chain 续链不重放事件，不校验。

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
        # 续接链尾——不重放事件（新回合事件全新产生）。图版本不校验：
        # 续链无重放/回溯语义（状态通道继承、事件全新产生），同 thread
        # 换图（按任务切 harness）是合法场景——图版本校验只作用于
        # resume_from（真恢复/重放）。
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
        # 输入 state 作为覆盖层：checkpoint 状态为基底，输入中提供的
        # 通道值经 reducer 合并（弹卡注入的 decision/
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
    if resume_from is not None:
        # 图版本校验只作用于真恢复（resume_from 锚点）：恢复 = 快照 +
        # 事件重放，图定义变了重放语义不保证；continue_chain 不重放事件，
        # 状态通道继承（同 thread 换图是合法场景），不校验。
        _assert_graph_version(last_checkpoint, graph_version)
    return ResumeResolution(
        state=current_state,
        last_checkpoint=last_checkpoint,
        resume_map=resume_map,
        replay=tuple(replay_events),
    )


def _assert_graph_version(
    checkpoint: CheckpointRecord | None, graph_version: str | None
) -> None:
    """恢复锚点图版本校验：锚点带图指纹且与当前图不一致 → 拒绝续跑。

    图定义 = 可恢复状态的一部分：拓扑/节点/条件引用变了，同一份状态与
    事件日志的语义就不同——继续重放会产生错位结果。显式报错让调用方
    决定重建或换锚点，绝不静默错位（旧数据无指纹，跳过校验兼容）。
    """
    if (
        graph_version is None
        or checkpoint is None
        or checkpoint.graph_version is None
    ):
        return
    if checkpoint.graph_version != graph_version:
        raise GraphVersionMismatchError(
            f"图定义版本与恢复锚点不匹配（锚点 {checkpoint.graph_version[:12]}…"
            f" vs 当前 {graph_version[:12]}…）：图已变更，恢复语义不保证，"
            f"请重建会话或选择匹配的锚点"
        )


async def collect_resume_anchors(
    storage: Storage,
    tail: CheckpointRecord,
    resume_map: dict[tuple[str, ...], int],
) -> tuple[int | None, dict[tuple[str, ...], int]]:
    """沿版本链回溯收集恢复锚点（顶层中断 checkpoint 的父链含各级子链锚点）。

    - 非空路径节点：仅收未完成/中断锚点（reason 为 None 的节点快照或
      interrupted 挂起轮）——reply/stop/error 终态 = 已完成子链的陈旧
      结果，作恢复锚点会让子链直接收尾回流旧状态；
    - 空路径节点：最近的顶层锚点（本级恢复起点）。

    遍历实现：整链索引一次取回（:meth:`Storage.chain_index`，轻量行无
    快照负载），内存内按 parent_id 回溯——避免逐跳 get_checkpoint 的
    O(链长) 次串行 DB 往返；链级 rebase 压缩后链长有界（窗口内），
    回溯自然停在归档链头（parent_id=None）。

    Returns:
        (top_anchor, resume_map)：顶层锚点 checkpoint_id（None = 图入口
        即子链，本级无顶层锚点）+ 子链锚点表（沿用传入表，逐级补录）。
    """
    if tail is None:
        # 无恢复锚点（首轮执行/无 checkpoint）：无回溯可言
        return None, resume_map
    links = await storage.chain_index(tail.thread_id)
    by_id = {link.checkpoint_id: link for link in links}
    cp = by_id.get(tail.checkpoint_id)
    if cp is None:
        # 防御：锚点不在索引（异常状态）仍可沿传入记录回溯一步
        cp = ChainLink(
            checkpoint_id=tail.checkpoint_id,
            parent_id=tail.parent_id,
            event_seq=tail.event_seq,
            graph_path=tail.graph_path,
            reason=tail.reason,
        )
    top_anchor: int | None = None
    while cp is not None:
        path = cp.graph_path or ()
        if path:
            if cp.reason in (None, "interrupted"):
                resume_map.setdefault(path, cp.checkpoint_id)
        elif top_anchor is None:
            top_anchor = cp.checkpoint_id  # 最近的顶层锚点
        # 继续沿父链回溯：顶层中断 checkpoint 的父链含子图层锚点
        cp = by_id.get(cp.parent_id) if cp.parent_id is not None else None
    return top_anchor, resume_map


__all__ = [
    "ResumeResolution",
    "collect_resume_anchors",
    "resolve_resume",
    "tail_checkpoint",
]
