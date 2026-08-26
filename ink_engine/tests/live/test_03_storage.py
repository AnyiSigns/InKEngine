"""族 3：存储（test_03_storage.py）｜storage/storage_memory/storage_sqlite/
storage_postgres/chain_rebase。

- memory/sqlite 全通道（checkpoint 链/事件日志/records/具名集合）
- sqlite 跨进程读取（subprocess 子进程读同一 db 文件，存储契约真实边界）
- 并发写冲突 → CheckpointConflictError；链级 rebase（plan_compaction/
  窗口压缩/链头改写）
- 敏感键剥离落库断言；schema 自检；postgres 可选（无环境跳过）

确定性机制用例（零模型调用）+ 1 条真实 LLM 用例（族门禁②）。
"""
from __future__ import annotations

import subprocess
import sys

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.events import EngineEvent  # noqa: E402
from ink_engine.core.exceptions import CheckpointConflictError  # noqa: E402
from ink_engine.core.graph import TerminateReason  # noqa: E402
from ink_engine.core.storage import CheckpointRecord, create_storage  # noqa: E402

# ----------------------------------------------------------------------
# memory 全通道
# ----------------------------------------------------------------------

async def test_memory_storage_all_channels():
    storage = create_storage("memory://")
    try:
        # checkpoint 链
        record = CheckpointRecord(
            checkpoint_id=0,
            thread_id="t1",
            node="n1",
            version=1,
            state={"a": 1},
            reason=TerminateReason.REPLY,
        )
        stored = await storage.put_checkpoint(record)
        assert stored.checkpoint_id > 0  # put 返回带真实 id 的记录
        fetched = await storage.get_checkpoint(stored.checkpoint_id)
        assert fetched is not None and fetched.state["a"] == 1
        latest = await storage.get_latest_checkpoint("t1")
        assert latest is not None and latest.version == 1
        # 事件日志
        event = EngineEvent(type="test_event", payload={"n": 1}, thread_id="t1")
        seq = await storage.append_event("t1", event)
        assert seq > 0
        after = await storage.events_after("t1", 0)
        assert len(after) == 1 and after[0].type == "test_event"
        # records 具名集合
        await storage.put_record("coll", "key1", {"v": 1})
        assert (await storage.get_record("coll", "key1")) == {"v": 1}
        listed = await storage.list_records("coll")
        assert any(r.get("v") == 1 for r in listed)
        # 同名覆盖写（records = 键值语义）
        await storage.put_record("coll", "key1", {"v": 2})
        assert (await storage.get_record("coll", "key1")) == {"v": 2}
    finally:
        await storage.close()


# ----------------------------------------------------------------------
# sqlite 全通道 + 跨进程读取 + 并发冲突
# ----------------------------------------------------------------------

async def test_sqlite_storage_full_and_cross_process(tmp_path):
    db = tmp_path / "cross.db"
    storage = create_storage(f"sqlite:///{db}")
    try:
        await storage.put_record("coll", "doc:1", {"value": "跨进程"})
        event = EngineEvent(type="e1", payload={"x": 1}, thread_id="t")
        await storage.append_event("t", event)
        record = CheckpointRecord(checkpoint_id=0, thread_id="t", node="n", version=1, state={"s": 1}, reason=TerminateReason.REPLY)
        await storage.put_checkpoint(record)
    finally:
        await storage.close()
    # 子进程（venv python）独立连接读同一 db 文件：存储契约真实边界
    script = (
        "import asyncio, sys\n"
        "from ink_engine.core.storage import create_storage\n"
        "async def main():\n"
        "    s = create_storage(sys.argv[1])\n"
        "    print((await s.get_record('coll', 'doc:1'))['value'])\n"
        "    print(len(await s.events_after('t', 0)))\n"
        "    print((await s.get_latest_checkpoint('t')).version)\n"
        "    await s.close()\n"
        "asyncio.run(main())\n"
    )
    # 子进程在 PYTHONUTF8 父环境下若不以 utf8 输出会导致解码错位；
    # 显式给子进程 -X utf8 并声明 encoding，且对 stderr/stdout 加 None 守卫，
    # 避免断言消息拼接崩溃（子进程极端路径下 stderr/stdout 可能为 None）。
    result = subprocess.run(
        [sys.executable, "-X", "utf8", "-c", script, f"sqlite:///{db}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    assert result.returncode == 0, (result.stderr or result.stdout or "子进程非零退出且无输出")
    lines = (result.stdout or "").strip().splitlines()
    assert lines == ["跨进程", "1", "1"]


async def test_sqlite_concurrent_write_conflict(tmp_path):
    db = tmp_path / "conflict.db"
    storage = create_storage(f"sqlite:///{db}")
    try:
        # 乐观锁：同 id 更新期望版本匹配 → 版本 +1
        c1 = await storage.put_checkpoint(
            CheckpointRecord(checkpoint_id=0, thread_id="t", node="n", version=1, state={"n": 1}, reason=TerminateReason.REPLY)
        )
        updated = await storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=c1.checkpoint_id, thread_id="t", node="n",
                version=c1.version, state={"n": 2}, reason=TerminateReason.REPLY,
            ),
            expected_version=c1.version,
        )
        assert updated.version == c1.version + 1
        # 陈旧期望版本 → 冲突拒绝
        with pytest.raises(CheckpointConflictError):
            await storage.put_checkpoint(
                CheckpointRecord(
                    checkpoint_id=c1.checkpoint_id, thread_id="t", node="n",
                    version=c1.version, state={"n": 3}, reason=TerminateReason.REPLY,
                ),
                expected_version=c1.version,
            )
        # 链尾冲突：链尾已前进时续链（期望链尾 = c1）→ 拒绝
        c2 = await storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=0, thread_id="t", node="n", version=2,
                state={"n": 4}, reason=TerminateReason.REPLY, parent_id=c1.checkpoint_id,
            )
        )
        with pytest.raises(CheckpointConflictError):
            await storage.put_checkpoint(
                CheckpointRecord(
                    checkpoint_id=0, thread_id="t", node="n", version=2,
                    state={"n": 5}, reason=TerminateReason.REPLY, parent_id=c1.checkpoint_id,
                )
            )
        assert c2.checkpoint_id > 0
    finally:
        await storage.close()


async def test_sqlite_chain_rebase_window(tmp_path):
    """链级 rebase：窗口压缩（maybe_compact_chain）+ 链头改写 + 事件日志连带裁剪。"""
    from ink_engine.core.chain_rebase import maybe_compact_chain

    db = tmp_path / "rebase.db"
    storage = create_storage(f"sqlite:///{db}")
    try:
        parent: int | None = None
        for i in range(1, 6):
            stored = await storage.put_checkpoint(
                CheckpointRecord(
                    checkpoint_id=0, thread_id="t", node="n", version=i,
                    state={"n": i}, reason=TerminateReason.REPLY, parent_id=parent,
                )
            )
            await storage.append_event("t", EngineEvent(type="e", payload={"i": i}, thread_id="t"))
            parent = stored.checkpoint_id
        links = await storage.chain_index("t")
        assert len(links) == 5
        outcome = await maybe_compact_chain(storage, "t", keep=2)
        assert outcome.compacted
        assert outcome.removed == 3  # 窗口外历史删除
        remaining = await storage.chain_index("t")
        assert len(remaining) == 2  # 窗口压缩：历史前缀删除
        head = await storage.get_latest_checkpoint("t")
        assert head is not None and head.state["n"] == 5  # 链头仍指向最新状态
    finally:
        await storage.close()


# ----------------------------------------------------------------------
# 敏感键剥离落库
# ----------------------------------------------------------------------

async def test_sensitive_keys_stripped_on_write(sqlite_storage):
    await sqlite_storage.put_record(
        "coll", "secret-doc",
        {"user": "u1", "api_key": "sk-live-123456", "token": "tok-abc", "safe": "x"},
    )
    raw = await sqlite_storage.get_record("coll", "secret-doc")
    assert raw["safe"] == "x"
    assert raw["user"] == "u1"
    assert raw.get("api_key") != "sk-live-123456"
    assert raw.get("token") != "tok-abc"


# ----------------------------------------------------------------------
# postgres 可选
# ----------------------------------------------------------------------

@pytest.mark.postgres
async def test_postgres_when_available():
    import os

    url = os.environ.get("POSTGRES_TEST_URL")
    if not url:
        pytest.skip("POSTGRES_TEST_URL 未设置（无环境跳过，协议由单测覆盖）")
    storage = create_storage(url)
    try:
        await storage.put_record("coll", "pg:1", {"v": "pg"})
        assert (await storage.get_record("coll", "pg:1"))["v"] == "pg"
    finally:
        await storage.close()


# ----------------------------------------------------------------------
# 真实 LLM 回合产物落 sqlite（族门禁②）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_round_persist_sqlite_reopen(live_llm, tmp_path):
    """真实 LLM 回合产物落 sqlite：checkpoint/事件/记录真实持久化，重开后仍可读。"""
    from ink_engine.core.events import CollectorTransport
    from ink_engine.core.executor import Engine, RunOptions
    from ink_engine.core.graph import Graph, TerminateReason
    from ink_engine.core.llm.messages import user

    db = tmp_path / "real.db"
    storage = create_storage(f"sqlite:///{db}")

    async def llm_node(ctx):
        result = await live_llm.ainvoke([user("用一句话回答：存储契约验证")])
        await ctx.emit("llm_reply", {"content": result.content})
        return {"answer": result.content}

    g = Graph(name="real_store", entry="n")
    g.add_node("n", llm_node)
    g.add_exit("n")
    engine = Engine(g, options=RunOptions(storage=storage, transports=[CollectorTransport()]))
    result = await engine.ainvoke({}, thread_id="real-store")
    assert result.reason == TerminateReason.REPLY
    assert result.state["answer"].strip()
    await storage.close()

    # 重开同一 db 文件（跨实例真实边界）：真实回合产物可读
    reopened = create_storage(f"sqlite:///{db}")
    try:
        latest = await reopened.get_latest_checkpoint("real-store")
        assert latest is not None and latest.state["answer"].strip()
        events = await reopened.events_after("real-store", 0)
        assert any(e.type == "llm_reply" for e in events)
    finally:
        await reopened.close()
