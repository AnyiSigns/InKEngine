"""通用存储服务单测：内存/sqlite 后端切换、checkpoint 版本链 + 乐观锁、
事件日志 append-only + 截断、structured records。"""
from __future__ import annotations

import os

import pytest

from ink_engine.core.events import EngineEvent
from ink_engine.core.exceptions import CheckpointConflictError, StorageError
from ink_engine.core.security import SENSITIVE_KEYS, strip_sensitive
from ink_engine.core.storage import CheckpointRecord, create_storage, validate_chain


@pytest.fixture(params=["memory://", "sqlite:///:memory:"])
async def storage(request):
    store = create_storage(request.param)
    yield store
    await store.close()

def _cp(**kw) -> CheckpointRecord:
    return CheckpointRecord(checkpoint_id=0, thread_id="t1", node="n1", **kw)


async def test_create_storage_unknown_scheme():
    with pytest.raises(ValueError):
        create_storage("mysql://x")


async def test_sqlite_connection_sets_concurrency_pragmas(tmp_path):
    """回归 ENG5-1：sqlite 连接后立即设 busy_timeout/WAL/synchronous。

    宿主默认后端为 sqlite:///（跨进程并发写）：无 busy_timeout 时锁竞争
    直接报 database is locked；无 WAL 时读写互斥放大竞争。
    """
    from ink_engine.core.storage_sqlite import SqliteStorage

    path = tmp_path / "pragma.db"
    store = SqliteStorage(str(path))
    try:
        await store._connect()

        async def pragma(name):
            cur = await store._conn.execute(f"PRAGMA {name}")
            row = await cur.fetchone()
            await cur.close()
            return row[0] if row else None

        assert await pragma("busy_timeout") == 5000
        assert await pragma("journal_mode") == "wal"
        assert await pragma("synchronous") == 1  # NORMAL
        # pragma 生效后常规读写不受影响
        rec = await store.put_checkpoint(_cp(state={"x": 1}))
        got = await store.get_checkpoint(rec.checkpoint_id)
        assert got is not None and got.state == {"x": 1}
    finally:
        await store.close()


async def test_checkpoint_create_and_get(storage):
    rec = await storage.put_checkpoint(_cp(state={"a": 1}))
    assert rec.checkpoint_id > 0
    got = await storage.get_checkpoint(rec.checkpoint_id)
    assert got is not None
    assert got.state == {"a": 1}
    assert got.node == "n1"


async def test_checkpoint_latest_and_list(storage):
    c1 = await storage.put_checkpoint(_cp(state={"v": 1}))
    c2 = await storage.put_checkpoint(
        CheckpointRecord(checkpoint_id=0, thread_id="t1", node="n2", state={"v": 2}, parent_id=c1.checkpoint_id)
    )
    latest = await storage.get_latest_checkpoint("t1")
    assert latest is not None and latest.checkpoint_id == c2.checkpoint_id
    cps = await storage.list_checkpoints("t1")
    assert [c.checkpoint_id for c in cps] == [c2.checkpoint_id, c1.checkpoint_id]


async def test_optimistic_lock_conflict(storage):
    """并发写保护：版本号乐观锁，冲突拒绝。"""
    rec = await storage.put_checkpoint(_cp(state={"v": 1}))
    # 正常更新：期望版本匹配 → 版本 +1
    updated = await storage.put_checkpoint(
        CheckpointRecord(
            checkpoint_id=rec.checkpoint_id,
            thread_id="t1",
            node="n1",
            state={"v": 2},
            version=rec.version,
        ),
        expected_version=rec.version,
    )
    assert updated.version == rec.version + 1
    # 冲突更新：期望旧版本 → 拒绝
    with pytest.raises(CheckpointConflictError):
        await storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=rec.checkpoint_id,
                thread_id="t1",
                node="n1",
                state={"v": 3},
                version=rec.version,
            ),
            expected_version=rec.version,
        )
    # P1 回归：更新路径父指针不可变（与 sqlite/postgres 同口径——传不同
    # parent_id 不得改写链上父指针，父指针改写是链级 rebase 专属操作）
    child = await storage.put_checkpoint(
        _cp(state={"v": 9}, parent_id=rec.checkpoint_id)
    )
    updated_child = await storage.put_checkpoint(
        CheckpointRecord(
            checkpoint_id=child.checkpoint_id,
            thread_id="t1",
            node="n2",
            state={"v": 10},
            parent_id=999,  # 注入非法父指针：更新路径必须忽略
        ),
        expected_version=child.version,
    )
    assert updated_child.parent_id == rec.checkpoint_id
    got_child = await storage.get_checkpoint(child.checkpoint_id)
    assert got_child is not None and got_child.parent_id == rec.checkpoint_id
    assert await validate_chain(storage, "t1") == []


async def test_optimistic_lock_update_without_expected_version(storage):
    """expected_version=None 时自动读当前版本（三后端同口径）。"""
    rec = await storage.put_checkpoint(_cp(state={"v": 1}))
    updated = await storage.put_checkpoint(
        CheckpointRecord(
            checkpoint_id=rec.checkpoint_id,
            thread_id="t1",
            node="n1",
            state={"v": 2},
            version=rec.version,
        )
    )
    assert updated.version == rec.version + 1


async def test_checkpoint_chain_tail_conflict(storage):
    """并发写保护：链尾已前进时续链冲突（乐观锁语义，executor 续链路径）。"""
    c1 = await storage.put_checkpoint(_cp(state={"v": 1}))  # 链头（parent=None）
    c2 = await storage.put_checkpoint(
        CheckpointRecord(checkpoint_id=0, thread_id="t1", node="n2", state={"v": 2}, parent_id=c1.checkpoint_id)
    )
    # 期望链尾 = c1 但实际链尾已是 c2 → 冲突
    with pytest.raises(CheckpointConflictError):
        await storage.put_checkpoint(
            CheckpointRecord(checkpoint_id=0, thread_id="t1", node="n3", state={"v": 3}, parent_id=c1.checkpoint_id)
        )
    # fork=True（编辑重放分叉）：允许锚点指向历史链节点
    fork_rec = await storage.put_checkpoint(
        CheckpointRecord(checkpoint_id=0, thread_id="t1", node="n3", state={"v": 3}, parent_id=c1.checkpoint_id),
        fork=True,
    )
    assert fork_rec.checkpoint_id > c2.checkpoint_id


async def test_checkpoint_error_field_roundtrip(storage):
    """异常快照随 checkpoint 持久化（reason=error 时携带脱敏错误消息）。"""
    rec = await storage.put_checkpoint(_cp(state={"v": 1}, reason="error", error="节点执行失败: a"))
    got = await storage.get_checkpoint(rec.checkpoint_id)
    assert got is not None
    assert got.reason == "error"
    assert got.error == "节点执行失败: a"


async def test_checkpoint_graph_version_plan_roundtrip(storage):
    """图版本 + 计划快照三后端持久化（随 checkpoint 版本链落盘）。

    回归 P0-1：postgres 守卫式续链 INSERT 曾发生 $14/$15 参数错位（thread_id
    喂给 checkpoint_id::bigint），常规续链第二个 checkpoint 起必然失败——
    memory/sqlite 全路径在此覆盖（插入 + 守卫式续链 + 更新），postgres
    由同构 marker 用例覆盖。
    """
    rec = await storage.put_checkpoint(
        _cp(
            state={"v": 1},
            graph_version="a" * 64,
            plan={"steps": [{"nodes": ["a"]}, {"nodes": ["b"]}], "index": 1},
        )
    )
    got = await storage.get_checkpoint(rec.checkpoint_id)
    assert got is not None
    assert got.graph_version == "a" * 64
    assert got.plan == {"steps": [{"nodes": ["a"]}, {"nodes": ["b"]}], "index": 1}
    # 守卫式续链插入（常规续链路径：not fork 且 parent_id 非 None）
    c2 = await storage.put_checkpoint(
        CheckpointRecord(
            checkpoint_id=0,
            thread_id="t1",
            node="n2",
            state={"v": 2},
            parent_id=rec.checkpoint_id,
            graph_version="b" * 64,
            plan=None,
        )
    )
    got2 = await storage.get_checkpoint(c2.checkpoint_id)
    assert got2 is not None
    assert got2.graph_version == "b" * 64
    assert got2.plan is None
    # 更新路径（update_state 的写回语义）字段保持
    updated = await storage.put_checkpoint(
        CheckpointRecord(
            checkpoint_id=c2.checkpoint_id,
            thread_id="t1",
            node="n2",
            state={"v": 3},
            parent_id=rec.checkpoint_id,
            version=c2.version,
            graph_version="b" * 64,
            plan={"steps": [{"nodes": ["b"]}], "index": 0},
        ),
        expected_version=c2.version,
    )
    got3 = await storage.get_checkpoint(updated.checkpoint_id)
    assert got3 is not None
    assert got3.graph_version == "b" * 64
    assert got3.plan == {"steps": [{"nodes": ["b"]}], "index": 0}
    assert await validate_chain(storage, "t1") == []


@pytest.mark.postgres
@pytest.mark.skipif(
    not os.environ.get("POSTGRES_TEST_URL"),
    reason="未配置 POSTGRES_TEST_URL，跳过真实 Postgres 后端验证",
)
async def test_checkpoint_graph_version_plan_roundtrip_postgres():
    """postgres 后端同构字段 round-trip（CI 有 PG 环境时跑；无环境跳过）。

    回归 P0-1：此用例直接覆盖守卫式续链 INSERT 的参数序（$14/$15
    错位会让第二个 checkpoint 写入失败）。
    """
    store = create_storage(os.environ["POSTGRES_TEST_URL"])
    try:
        rec = await store.put_checkpoint(
            _cp(
                state={"v": 1},
                graph_version="a" * 64,
                plan={"steps": [{"nodes": ["a"]}], "index": 0},
            )
        )
        c2 = await store.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=0,
                thread_id="t1",
                node="n2",
                state={"v": 2},
                parent_id=rec.checkpoint_id,
                graph_version="b" * 64,
                plan=None,
            )
        )
        got = await store.get_checkpoint(c2.checkpoint_id)
        assert got is not None
        assert got.graph_version == "b" * 64
        assert got.plan is None
    finally:
        await store.close()


async def test_checkpoint_sensitive_keys_stripped(storage):
    """安全：checkpoint 永不落 api_key（引擎默认剥离语义）。"""
    rec = await storage.put_checkpoint(
        _cp(state={"model_config": {"api_key": "sk-secret", "model": "x"}, "ok": 1})
    )
    got = await storage.get_checkpoint(rec.checkpoint_id)
    assert got is not None
    assert got.state["model_config"].get("api_key") == ""
    assert got.state["model_config"]["model"] == "x"
    assert got.state["ok"] == 1


async def test_checkpoint_sensitive_keys_stripped_in_patch_chain(storage):
    """安全：补丁链通道（引擎主内容通道）内敏感键同样剥离，不绕过。"""
    from ink_engine.core.patch_chain import Patch, PatchChain, PatchOp

    chain = PatchChain(base={"content": ""})
    chain.apply(Patch(op=PatchOp.APPEND, path=("content",), value="正文"))
    chain.apply(Patch(op=PatchOp.REPLACE, path=("model_config",), value={"api_key": "sk", "model": "x"}))
    rec = await storage.put_checkpoint(_cp(state={"draft": chain}))
    got = await storage.get_checkpoint(rec.checkpoint_id)
    assert got is not None
    restored: PatchChain = got.state["draft"]
    assert restored.assemble()["model_config"]["api_key"] == ""
    assert restored.assemble()["model_config"]["model"] == "x"
    assert restored.assemble()["content"] == "正文"


async def test_event_log_strips_sensitive_payload(storage):
    """安全：事件日志落库前剥离敏感键（与 checkpoint 同口径）。"""
    e = EngineEvent(type="review_card", payload={"review": "ok", "api_key": "sk-secret"})
    await storage.append_event("t1", e)
    after = await storage.events_after("t1", 0)
    assert len(after) == 1
    assert after[0].payload["api_key"] == ""
    assert after[0].payload["review"] == "ok"


async def test_records_strip_sensitive_payload(storage):
    """安全：structured records（记忆/世界状态）落库前剥离敏感键。"""
    await storage.put_record("memory", "k1", {"token": "sk-secret", "keep": 1})
    got = await storage.get_record("memory", "k1")
    assert got is not None
    assert got["token"] == ""
    assert got["keep"] == 1


async def test_sensitive_suffix_keys_stripped(storage):
    """安全：常见前后缀凭据键（openai_api_key/client_secret 等）同样剥离。"""
    rec = await storage.put_checkpoint(
        _cp(
            state={
                "openai_api_key": "sk-secret",
                "client_secret": "s",
                "auth_token": "t",
                "token_count": 3,  # 指标键不误伤
                "key_insight": "剧情关键",  # 业务键不误伤
                "ok": 1,
            }
        )
    )
    got = await storage.get_checkpoint(rec.checkpoint_id)
    assert got is not None
    assert got.state["openai_api_key"] == ""
    assert got.state["client_secret"] == ""
    assert got.state["auth_token"] == ""
    assert got.state["token_count"] == 3
    assert got.state["key_insight"] == "剧情关键"
    assert got.state["ok"] == 1


async def test_latest_event_seq(storage):
    """事件日志最新 seq 锚点（恢复 = 快照 + 该 seq 之后的增量重放）。"""
    s1 = await storage.append_event("t1", EngineEvent(type="a"))
    s2 = await storage.append_event("t1", EngineEvent(type="b"))
    await storage.append_event("t2", EngineEvent(type="c"))
    assert await storage.latest_event_seq("t1") == s2
    assert await storage.latest_event_seq("t2") == s2 + 1
    assert await storage.latest_event_seq("t3") == 0
    await storage.truncate_events("t1", s1)
    assert await storage.latest_event_seq("t1") == s1  # 截断后锚点回退


async def test_use_after_close_raises():
    """close() 后再读写必须显式报错（不静默重连成空库）。"""
    store = create_storage("sqlite:///:memory:")
    await store.put_checkpoint(_cp(state={"x": 1}))
    await store.close()
    with pytest.raises(StorageError):
        await store.get_latest_checkpoint("t1")


async def test_checkpoint_patch_chain_roundtrip(storage):
    """内容型补丁链随 checkpoint 序列化往返（sqlite JSON 列内联还原）。"""
    from ink_engine.core.patch_chain import Patch, PatchChain, PatchOp

    chain = PatchChain(base={"content": ""})
    chain.apply(Patch(op=PatchOp.APPEND, path=("content",), value="草稿一"))
    chain.apply(Patch(op=PatchOp.APPEND, path=("content",), value="草稿二"))
    rec = await storage.put_checkpoint(_cp(state={"draft": chain}))
    got = await storage.get_checkpoint(rec.checkpoint_id)
    assert got is not None
    restored = got.state["draft"]
    assert isinstance(restored, PatchChain)
    assert restored.assemble()["content"] == "草稿一草稿二"


async def test_checkpoint_engine_message_roundtrip(storage):
    """引擎 Message/ToolCall 随 checkpoint 序列化往返（marker 内联还原）。

    引擎状态通道持有 Message 对象时，checkpoint 落库/恢复必须精确还原
    消息 id/tool_calls/reasoning（add_messages 按 id 去重语义跨存储一致）。
    """
    from ink_engine.core.llm.messages import Message, ToolCall

    msgs = [
        Message(role="user", content="你好", id="m1"),
        Message(
            role="assistant",
            content="",
            tool_calls=[ToolCall(id="c1", name="lookup", arguments='{"q": 1}')],
            reasoning="先查库",
            id="m2",
        ),
        Message(role="tool", content="结果", tool_call_id="c1", id="m3"),
    ]
    rec = await storage.put_checkpoint(_cp(state={"messages": msgs}))
    got = await storage.get_checkpoint(rec.checkpoint_id)
    assert got is not None
    restored = got.state["messages"]
    assert len(restored) == 3
    assert all(isinstance(m, Message) for m in restored)
    assert restored[0].id == "m1"
    assert restored[1].tool_calls[0].name == "lookup"
    assert restored[1].tool_calls[0].arguments == '{"q": 1}'
    assert restored[1].reasoning == "先查库"
    assert restored[2].role == "tool"
    assert restored[2].tool_call_id == "c1"


async def test_event_log_append_and_replay(storage):
    e1 = EngineEvent(type="reply_token", payload={"text": "a"}, seq=1)
    e2 = EngineEvent(type="reply_token", payload={"text": "b"}, seq=2)
    s1 = await storage.append_event("t1", e1)
    s2 = await storage.append_event("t1", e2)
    assert s1 < s2
    after = await storage.events_after("t1", 0)
    assert [e.type for e in after] == ["reply_token", "reply_token"]
    assert [e.seq for e in after] == [s1, s2]


async def test_event_log_truncate(storage):
    e1 = EngineEvent(type="reply_token", payload={"text": "a"})
    e2 = EngineEvent(type="reply_token", payload={"text": "b"})
    s1 = await storage.append_event("t1", e1)
    await storage.append_event("t1", e2)
    await storage.truncate_events("t1", s1)
    after = await storage.events_after("t1", 0)
    assert len(after) == 1
    assert after[0].seq == s1


async def test_event_log_partitioned_by_thread(storage):
    await storage.append_event("t1", EngineEvent(type="a"))
    await storage.append_event("t2", EngineEvent(type="b"))
    assert len(await storage.events_after("t1", 0)) == 1


async def test_records_crud(storage):
    await storage.put_record("memory", "k1", {"a": 1})
    assert await storage.get_record("memory", "k1") == {"a": 1}
    await storage.put_record("memory", "k1", {"a": 2})  # upsert
    assert await storage.get_record("memory", "k1") == {"a": 2}
    assert await storage.get_record("memory", "missing") is None
    await storage.put_record("other", "k1", {"b": 3})
    records = await storage.list_records("memory")
    assert len(records) == 1


async def test_strip_sensitive_recursive():
    data = {
        "api_key": "sk",
        "nested": {"token": "t", "keep": 1},
        "list": [{"secret": "s"}, {"ok": 2}],
    }
    out = strip_sensitive(data)
    assert out["api_key"] == ""  # 敏感键置空保留（键结构不破坏）
    assert out["nested"]["token"] == ""
    assert out["nested"]["keep"] == 1
    assert out["list"][0]["secret"] == ""
    assert out["list"][1]["ok"] == 2
    assert "api_key" in SENSITIVE_KEYS


async def test_sqlite_file_backend(tmp_path):
    path = tmp_path / "engine.db"
    store = create_storage(f"sqlite:///{path}")
    rec = await store.put_checkpoint(_cp(state={"x": 1}))
    got = await store.get_checkpoint(rec.checkpoint_id)
    assert got is not None and got.state == {"x": 1}
    await store.close()


@pytest.mark.postgres
@pytest.mark.skipif(
    not os.environ.get("POSTGRES_TEST_URL"),
    reason="未配置 POSTGRES_TEST_URL，跳过真实 Postgres 后端验证",
)
async def test_postgres_backend_switch():
    store = create_storage(os.environ["POSTGRES_TEST_URL"])
    rec = await store.put_checkpoint(_cp(state={"x": 1}))
    got = await store.get_checkpoint(rec.checkpoint_id)
    assert got is not None and got.state == {"x": 1}
    await store.close()


async def test_checkpoint_snapshot_not_mutated_by_caller(storage):
    """P1 回归：写入后修改调用方持有的状态，存储内快照不受影响
    （内存后端存活引用已修，与 SQL 后端真快照语义对齐）。"""
    rec = await storage.put_checkpoint(_cp(state={"items": [1]}))
    rec.state["items"].append(2)
    got = await storage.get_checkpoint(rec.checkpoint_id)
    assert got is not None and got.state["items"] == [1]


async def test_update_preserves_record_types(storage):
    """P1 回归：更新路径保持记录类型（graph_path 为 tuple、version 递增），
    禁止 to_dict 回灌构造器（修复前：内存端更新后 graph_path 变 list，
    恢复路径按 tuple 哈希定位锚点时崩溃）。"""
    rec = await storage.put_checkpoint(_cp(state={"v": 1}))
    updated = await storage.put_checkpoint(
        CheckpointRecord(
            checkpoint_id=rec.checkpoint_id,
            thread_id="t1",
            node="n1",
            state={"v": 2},
            version=rec.version,
        )
    )
    assert updated.graph_path == ()
    assert updated.version == rec.version + 1


async def test_update_missing_checkpoint_rejected(storage):
    """P1 回归：更新不存在的 checkpoint 抛 StorageError（三后端同口径，
    修复前：内存后端静默插入任意 id）。"""
    with pytest.raises(StorageError):
        await storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=12345, thread_id="t1", node="n1", state={"v": 1}
            )
        )


async def test_non_json_state_rejected(storage):
    """P1 回归：状态含不可 JSON 序列化对象 → StorageError（三后端同口径，
    修复前：内存后端静默通过，切 sqlite 即错）。"""

    class _Obj:
        pass

    with pytest.raises(StorageError):
        await storage.put_checkpoint(_cp(state={"obj": _Obj()}))


async def test_dangling_parent_rejected(storage):
    """链一致性不变量：parent 引用不存在（悬挂父指针）→ 写入拒绝。
    修复前：条件插入的链尾校验对不存在的 parent 空满足，悬挂节点静默成链，
    恢复回溯时断链。"""
    with pytest.raises(CheckpointConflictError):
        await storage.put_checkpoint(
            CheckpointRecord(checkpoint_id=0, thread_id="t1", node="n2", parent_id=999)
        )


async def test_cross_thread_parent_rejected(storage):
    """链一致性不变量：parent 属于其他 thread → 写入拒绝（版本链不跨线程）。"""
    c1 = await storage.put_checkpoint(_cp(state={"v": 1}))
    with pytest.raises(CheckpointConflictError):
        await storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=0,
                thread_id="t2",
                node="n2",
                state={"v": 2},
                parent_id=c1.checkpoint_id,
            )
        )


async def test_event_seq_regression_rejected(storage):
    """链一致性不变量：新节点 event_seq 低于父节点（快照锚点回退）→ 写入拒绝。
    修复前：event_seq 回退静默成链，恢复时增量日志重放顺序错乱。"""
    c1 = await storage.put_checkpoint(_cp(state={"v": 1}, event_seq=5))
    with pytest.raises(CheckpointConflictError):
        await storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=0,
                thread_id="t1",
                node="n2",
                state={"v": 2},
                parent_id=c1.checkpoint_id,
                event_seq=2,
            )
        )


async def test_fork_bypasses_chain_invariants(storage):
    """fork（编辑重放分叉）豁免链一致性校验：锚点允许指向历史链节点，
    event_seq 允许低于父锚点（事件日志截断回退语义）。"""
    c1 = await storage.put_checkpoint(_cp(state={"v": 1}, event_seq=100))
    fork_rec = await storage.put_checkpoint(
        CheckpointRecord(
            checkpoint_id=0,
            thread_id="t1",
            node="n2",
            state={"v": 2},
            parent_id=c1.checkpoint_id,
            event_seq=10,
        ),
        fork=True,
    )
    assert fork_rec.checkpoint_id > c1.checkpoint_id


async def test_validate_chain_consistent(storage):
    """validate_chain：正常线性链（event_seq 单调）返回无违规。"""
    c1 = await storage.put_checkpoint(_cp(state={"v": 1}, event_seq=0))
    c2 = await storage.put_checkpoint(
        CheckpointRecord(
            checkpoint_id=0, thread_id="t1", node="n2", state={"v": 2},
            parent_id=c1.checkpoint_id, event_seq=5,
        )
    )
    await storage.put_checkpoint(
        CheckpointRecord(
            checkpoint_id=0, thread_id="t1", node="n3", state={"v": 3},
            parent_id=c2.checkpoint_id, event_seq=5,
        )
    )
    assert await validate_chain(storage, "t1") == []
    assert await validate_chain(storage, "missing_thread") == []


async def test_validate_chain_detects_violations():
    """validate_chain：链遍历逐项报告悬挂父指针/跨线程/event_seq 回退/环。
    坏链经内存后端内部结构直接注入（写入端不变量已拒绝这些形态，此处
    验证校验器对存量坏链的检出能力）。"""
    from ink_engine.core.storage_memory import MemoryStorage

    store = MemoryStorage()
    await store.put_checkpoint(_cp(state={"v": 1}, event_seq=0))

    def _inject(cp: CheckpointRecord) -> None:
        store._checkpoints[cp.checkpoint_id] = cp
        store._latest_checkpoint_by_thread[cp.thread_id] = cp.checkpoint_id

    _inject(
        CheckpointRecord(
            checkpoint_id=101, thread_id="t1", node="dangling",
            state={}, parent_id=999, event_seq=3,
        )
    )
    violations = await validate_chain(store, "t1")
    assert any("悬挂父指针" in v for v in violations)

    _inject(
        CheckpointRecord(
            checkpoint_id=102, thread_id="t2", node="cross",
            state={}, parent_id=101, event_seq=4,
        )
    )
    violations = await validate_chain(store, "t2")
    assert any("跨线程父指针" in v for v in violations)

    _inject(
        CheckpointRecord(
            checkpoint_id=103, thread_id="t1", node="regress",
            state={}, parent_id=101, event_seq=1,
        )
    )
    violations = await validate_chain(store, "t1")
    assert any("event_seq 回退" in v for v in violations)

    _inject(
        CheckpointRecord(
            checkpoint_id=104, thread_id="t1", node="self-loop",
            state={}, parent_id=104, event_seq=0,
        )
    )
    violations = await validate_chain(store, "t1")
    assert any("父链非递减" in v for v in violations)
    # 环检测立即终止：不触发遍历超限
    assert not any("遍历超限" in v for v in violations)
