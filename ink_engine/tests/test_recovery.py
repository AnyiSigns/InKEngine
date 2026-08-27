"""恢复/续流解析单测（resume 锚点解析 + 覆盖层保留 + 图版本校验 + 子图回溯）。

恢复是重放语义的核心（快照 + 事件重放），此前零测试覆盖——本模块
补齐 resolve_resume/collect_resume_anchors/_assert_graph_version 的
关键契约。
"""
from __future__ import annotations

import pytest

from ink_engine.core.events import EngineEvent
from ink_engine.core.exceptions import GraphVersionMismatchError, StorageError
from ink_engine.core.recovery import (
    collect_resume_anchors,
    resolve_resume,
    tail_checkpoint,
)
from ink_engine.core.state import StateSchema
from ink_engine.core.storage import CheckpointRecord


def _ckpt(
    thread_id: str,
    *,
    parent_id: int | None = None,
    reason: str | None = None,
    event_seq: int = 0,
    graph_path: tuple[str, ...] = (),
    graph_version: str | None = None,
    state: dict | None = None,
    node: str | None = None,
) -> CheckpointRecord:
    return CheckpointRecord(
        checkpoint_id=0,  # 新节点：存储分配自增 id
        thread_id=thread_id,
        node=node,
        graph_path=graph_path,
        state=state or {},
        parent_id=parent_id,
        reason=reason,
        created_at=float(event_seq or 1),
        version=1,
        event_seq=event_seq,
        error=None,
        interrupt=None,
        graph_version=graph_version,
        plan=None,
    )


async def _chain(memory_storage, specs):
    """按声明顺序落链（顺序插入返回 id 表：checkpoint_id → 记录）。"""
    ids: dict[int, CheckpointRecord] = {}
    for spec in specs:
        rec = await memory_storage.put_checkpoint(_ckpt("t1", **spec))
        ids[rec.checkpoint_id] = rec
    return ids


async def test_resume_from_basic_restore(memory_storage):
    """resume_from：checkpoint 为基底，输入 state 为覆盖层（缺失键保留）。"""
    ids = await _chain(memory_storage, [{"state": {"input": "旧", "keep": "v"}, "node": "n1"}])
    cid = next(iter(ids))
    res = await resolve_resume(
        storage=memory_storage,
        state={"input": "新"},
        schema=None,
        thread_id="t1",
        chain_thread="t1",
        resume_from=cid,
        continue_chain=False,
        graph_path=(),
        replay=False,
        resume_map=None,
    )
    assert res.last_checkpoint is not None and res.last_checkpoint.checkpoint_id == cid
    assert res.state["input"] == "新"
    assert res.state["keep"] == "v"


async def test_continue_chain_uses_tail(memory_storage):
    """continue_chain：链尾为基底，输入覆盖，不校验图版本、不重放。"""
    await _chain(memory_storage, [{"state": {"input": "旧", "keep": "v"}, "node": "n1", "graph_version": "g-old"}])
    res = await resolve_resume(
        storage=memory_storage,
        state={"input": "新"},
        schema=None,
        thread_id="t1",
        chain_thread="t1",
        resume_from=None,
        continue_chain=True,
        graph_path=(),
        replay=True,
        resume_map=None,
        graph_version="g-new",  # 续链不校验：换图续链合法
    )
    assert res.last_checkpoint is not None
    assert res.state["input"] == "新"
    assert res.state["keep"] == "v"
    assert res.replay == ()


async def test_resume_version_mismatch_rejected(memory_storage):
    """resume_from 恢复锚点图版本与当前不一致 → 显式拒绝。"""
    ids = await _chain(memory_storage, [{"state": {"input": "旧"}, "node": "n1", "graph_version": "g-old"}])
    with pytest.raises(GraphVersionMismatchError):
        await resolve_resume(
            storage=memory_storage,
            state={},
            schema=None,
            thread_id="t1",
            chain_thread="t1",
            resume_from=next(iter(ids)),
            continue_chain=False,
            graph_path=(),
            replay=False,
            resume_map=None,
            graph_version="g-new",
        )


async def test_resume_version_missing_skips(memory_storage):
    """旧数据无图指纹 → 跳过校验（兼容既有库）。"""
    ids = await _chain(memory_storage, [{"state": {}, "node": "n1"}])
    res = await resolve_resume(
        storage=memory_storage,
        state={},
        schema=None,
        thread_id="t1",
        chain_thread="t1",
        resume_from=next(iter(ids)),
        continue_chain=False,
        graph_path=(),
        replay=False,
        resume_map=None,
        graph_version="g-new",
    )
    assert res.last_checkpoint is not None


async def test_top_anchor_backtrack_keeps_overlay(memory_storage):
    """顶层锚点回溯后输入覆盖层不丢失（回归：此前回溯直接覆盖丢弃 state）。"""
    # 链：1(顶层, 终态 reply) → 2(子图 s1 中断锚点)
    ids = await _chain(memory_storage, [
        {"state": {"input": "旧", "keep": "v"}, "node": "n1", "reason": "reply", "graph_path": ()},
        {"state": {"input": "子图旧"}, "node": "n2", "parent_id": 1, "reason": None, "graph_path": ("s1",), "event_seq": 3},
    ])
    sub_id = ids[2].checkpoint_id
    res = await resolve_resume(
        storage=memory_storage,
        state={"input": "覆盖", "fresh": "x"},
        schema=None,
        thread_id="t1",
        chain_thread="t1",
        resume_from=sub_id,
        continue_chain=False,
        graph_path=(),
        replay=False,
        resume_map=None,
    )
    # 回溯到顶层锚点 1，但覆盖层仍生效
    assert res.last_checkpoint is not None and res.last_checkpoint.checkpoint_id == 1
    assert res.state["input"] == "覆盖"
    assert res.state["keep"] == "v"
    assert res.state["fresh"] == "x"
    # 子图锚点入 resume_map
    assert res.resume_map.get(("s1",)) == sub_id


async def test_top_anchor_backtrack_overlay_with_schema(memory_storage):
    """带 schema 时回溯后覆盖层经 reducer 合并（与 resume_from 分支同语义）。"""
    from ink_engine.core.state import register_reducer

    def numeric_add(base, overlay):
        return (base or 0) + overlay

    register_reducer("test_numeric_add", numeric_add)
    schema = StateSchema({"count": "test_numeric_add"})
    await _chain(memory_storage, [
        {"state": {"count": 5}, "node": "n1", "reason": "reply", "graph_path": ()},
        {"state": {"count": 9}, "node": "n2", "parent_id": 1, "reason": None, "graph_path": ("s1",)},
    ])
    res = await resolve_resume(
        storage=memory_storage,
        state={"count": 3},
        schema=schema,
        thread_id="t1",
        chain_thread="t1",
        resume_from=2,
        continue_chain=False,
        graph_path=(),
        replay=False,
        resume_map=None,
    )
    assert res.last_checkpoint is not None and res.last_checkpoint.checkpoint_id == 1
    # 基底 5 + 覆盖 3（add reducer 累加）
    assert res.state["count"] == 8


async def test_replay_from_top_anchor(memory_storage):
    """回溯后重放区间以顶层锚点为准（超集一次，防重复事件）。"""
    await _chain(memory_storage, [
        {"state": {}, "node": "n1", "reason": "reply", "graph_path": (), "event_seq": 0},
        {"state": {}, "node": "n2", "parent_id": 1, "reason": None, "graph_path": ("s1",), "event_seq": 3},
    ])
    await memory_storage.append_event("t1", EngineEvent(type="probe", payload={}))
    res = await resolve_resume(
        storage=memory_storage,
        state={},
        schema=None,
        thread_id="t1",
        chain_thread="t1",
        resume_from=2,
        continue_chain=False,
        graph_path=(),
        replay=True,
        resume_map=None,
    )
    # 顶层锚点 event_seq=2，重放其后的事件
    assert len(res.replay) == 1
    assert res.replay[0].type == "probe"


async def test_collect_anchors_skips_completed_subchains(memory_storage):
    """子链终态（reply）不作恢复锚点，仅中断/未完成锚点入表。"""
    await _chain(memory_storage, [
        {"state": {}, "node": "n1", "graph_path": ()},
        {"state": {}, "node": "n2", "parent_id": 1, "reason": "reply", "graph_path": ("done",)},
        {"state": {}, "node": "n3", "parent_id": 2, "reason": None, "graph_path": ("pending",)},
    ])
    tail = await tail_checkpoint(memory_storage, "t1")
    assert tail is not None
    top, m = await collect_resume_anchors(memory_storage, tail, {})
    assert top == 1
    assert ("pending",) in m
    assert ("done",) not in m


async def test_resume_from_missing_anchor_raises(memory_storage):
    """resume_from 锚点不存在 → 显式 StorageError。"""
    with pytest.raises(StorageError):
        await resolve_resume(
            storage=memory_storage,
            state={},
            schema=None,
            thread_id="t1",
            chain_thread="t1",
            resume_from=99,
            continue_chain=False,
            graph_path=(),
            replay=False,
            resume_map=None,
        )


async def test_top_level_chain_thread_contract_enforced(memory_storage):
    """ENG5-13 回归：顶层恢复路径（graph_path 空）强制 checkpoint 链与
    事件日志同线程——chain_index 与 events_after 都按单一 thread 定位，
    混用会静默跨线程取锚点/重放。嵌套路径（graph_path 非空，spawn/分支
    经 checkpoint_thread_id 显式隔离）不受限。"""
    with pytest.raises(AssertionError, match="顶层恢复路径"):
        await resolve_resume(
            storage=memory_storage,
            state={},
            schema=None,
            thread_id="t1",
            chain_thread="t1:spawn:0",  # 顶层分离 = 契约违例
            resume_from=None,
            continue_chain=True,
            graph_path=(),
            replay=False,
            resume_map=None,
        )
    # 嵌套路径合法（spawn/分支的显式隔离形态）
    res = await resolve_resume(
        storage=memory_storage,
        state={"x": 1},
        schema=None,
        thread_id="t1",
        chain_thread="t1:spawn:0",
        resume_from=None,
        continue_chain=True,
        graph_path=("sub", "0"),
        replay=False,
        resume_map=None,
    )
    assert res.state == {"x": 1}
    # 纯内存执行（storage=None）无线程语义，不触发契约
    res2 = await resolve_resume(
        storage=None,
        state={"x": 1},
        schema=None,
        thread_id="t1",
        chain_thread="anything",
        resume_from=None,
        continue_chain=True,
        graph_path=(),
        replay=False,
        resume_map=None,
    )
    assert res2.state == {"x": 1}
