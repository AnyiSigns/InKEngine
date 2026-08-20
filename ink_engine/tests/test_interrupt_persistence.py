"""挂起卡随 checkpoint 持久化的单测：中断态落库/链尾读取/注入续流。

挂起卡（interrupt 键 + 卡负载）随终态快照持久化是「挂卡续流」的
定位锚点：挂起轮结束后从链尾取卡，用户决策后按同一键注入重入。
"""
from __future__ import annotations

import pytest
from conftest import make_engine

from ink_engine.core.executor import Engine
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.interrupt import InterruptState
from ink_engine.core.storage import CheckpointRecord, create_storage

_STORE_PARAMS = ["memory://", "sqlite:///:memory:"]


@pytest.fixture(params=_STORE_PARAMS)
def store(request):
    storage = create_storage(request.param)
    yield storage


async def _execute(engine: Engine, **kw):
    state, result = await engine._execute(
        state={},
        thread_id=kw.pop("thread_id", "t"),
        round_id=kw.pop("round_id", None),
        resume_from=kw.pop("resume_from", None),
        trace_id=kw.pop("trace_id", "trace"),
        queue=None,
        **kw,
    )
    return state, result


def _gated_graph() -> Graph:
    async def gated(ctx):
        decision = await ctx.interrupt("review:audit:n1", {"question": "是否通过?"})
        return {"approved": decision == "yes"}

    g = Graph(name="g", entry="a")
    g.add_node("a", gated)
    g.add_exit("a")
    return g


async def test_interrupt_persisted_in_checkpoint(store):
    """中断轮终态快照携带挂起卡（键 + 负载），普通快照不带。"""
    engine = make_engine(_gated_graph(), storage=store)
    _, result = await _execute(engine, thread_id="t1")
    assert result.reason == "interrupted"
    latest = await store.get_latest_checkpoint("t1")
    assert latest is not None
    assert latest.interrupt is not None
    assert latest.interrupt.key == "review:audit:n1"
    assert latest.interrupt.payload == {"question": "是否通过?"}
    cps = await store.list_checkpoints("t1")
    assert all(cp.interrupt is None for cp in cps if cp.reason != "interrupted")


async def test_get_latest_interrupt_roundtrip(store):
    engine = make_engine(_gated_graph(), storage=store)
    await _execute(engine, thread_id="t1")
    interrupt = await engine.get_latest_interrupt("t1")
    assert interrupt is not None
    assert interrupt.key == "review:audit:n1"
    assert interrupt.payload == {"question": "是否通过?"}


async def test_get_latest_interrupt_none_when_no_pending(store):
    """无挂起卡（未中断/补丁快照）返回 None。"""
    g = Graph(name="g", entry="a")
    g.add_node("a", lambda ctx: {"done": True})
    g.add_exit("a")
    engine = make_engine(g, storage=store)
    await _execute(engine, thread_id="t1")
    assert await engine.get_latest_interrupt("t1") is None


async def test_update_state_drops_interrupt_marker(store):
    """外部补丁快照不沿袭挂起卡标记（补丁不是挂起轮）。"""
    engine = make_engine(_gated_graph(), storage=store)
    await _execute(engine, thread_id="t1")
    assert await engine.get_latest_interrupt("t1") is not None
    await engine.update_state("t1", {"extra": 1})
    assert await engine.get_latest_interrupt("t1") is None


async def test_resume_with_inject_via_public_run(store):
    """公开 API 续流：run(resume_from + inject) 重入挂起节点拿到决策值。"""
    engine = make_engine(_gated_graph(), storage=store)
    await _execute(engine, thread_id="t1")
    latest = await store.get_latest_checkpoint("t1")
    assert latest is not None
    events: list = []
    async for event in engine.run(
        {},
        thread_id="t1",
        resume_from=latest.checkpoint_id,
        inject={"review:audit:n1": "yes"},
    ):
        events.append(event)
    snap = await store.get_latest_checkpoint("t1")
    assert snap is not None
    assert snap.state.get("approved") is True
    assert snap.reason == TerminateReason.REPLY


async def test_checkpoint_record_serialization_roundtrip():
    """CheckpointRecord to_dict/from_dict 往返保留挂起卡（存储层序列化契约）。"""
    record = CheckpointRecord(
        checkpoint_id=7,
        thread_id="t1",
        node="a",
        state={"approved": False},
        reason="interrupted",
        interrupt=InterruptState(
            key="review:audit:n1",
            payload={"question": "是否通过?"},
            node="a",
            graph_path=("sub",),
        ),
    )
    restored = CheckpointRecord.from_dict(record.to_dict())
    assert restored.interrupt is not None
    assert restored.interrupt.key == "review:audit:n1"
    assert restored.interrupt.payload == {"question": "是否通过?"}
    assert restored.interrupt.graph_path == ("sub",)
    assert restored.reason == "interrupted"


async def test_sqlite_file_backend_roundtrip(tmp_path):
    """sqlite 文件后端：中断快照落库后重开存储读取，挂起卡完整还原。"""
    path = tmp_path / "engine.db"
    store = create_storage(f"sqlite:///{path}")
    engine = make_engine(_gated_graph(), storage=store)
    await _execute(engine, thread_id="t1")
    await store.close()

    reopened = create_storage(f"sqlite:///{path}")
    latest = await reopened.get_latest_checkpoint("t1")
    assert latest is not None
    assert latest.interrupt is not None
    assert latest.interrupt.key == "review:audit:n1"
    assert latest.interrupt.payload == {"question": "是否通过?"}
    await reopened.close()
