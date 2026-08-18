"""通用存储服务单测：内存/sqlite 后端切换、checkpoint 版本链 + 乐观锁、
事件日志 append-only + 截断、structured records。"""
from __future__ import annotations

import os

import pytest

from ink_engine.core.events import EngineEvent
from ink_engine.core.exceptions import CheckpointConflictError, StorageError
from ink_engine.core.security import SENSITIVE_KEYS, strip_sensitive
from ink_engine.core.storage import CheckpointRecord, create_storage


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
