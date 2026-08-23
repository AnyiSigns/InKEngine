"""存储快照单测：snapshot/restore（sqlite backup API + 内存序列化 + 协议）。

覆盖：Storage 协议携带 snapshot/restore 方法；sqlite 后端快照 = 目标
库一致副本（checkpoint/事件/records 全部恢复）；快照后修改再 restore
回到快照时点；内存后端快照/恢复往返；postgres 显式 NotImplementedError；
快照目标与源相同拒绝（防误覆盖）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.events import EngineEvent
from ink_engine.core.storage import (
    CheckpointRecord,
    Storage,
    create_storage,
)
from ink_engine.core.storage_sqlite import SqliteStorage


def _sample_record(checkpoint_id: int, thread_id: str = "t1", count: int = 1) -> CheckpointRecord:
    return CheckpointRecord(
        checkpoint_id=checkpoint_id,
        thread_id=thread_id,
        node="start",
        state={"count": count},
        reason=None,
    )


async def _fill(storage, thread_id="t1") -> None:
    """落一个 checkpoint + 一条事件 + 一条 record（三通道齐全）。"""
    await storage.put_checkpoint(_sample_record(0, thread_id))
    await storage.append_event(
        thread_id,
        EngineEvent(type="reply_token", payload={"token": "x"}, thread_id=thread_id),
    )
    await storage.put_record("notes", "k1", {"title": "hello"})


class TestProtocol:
    def test_storage_protocol_declares_snapshot_methods(self):
        assert isinstance(create_storage("memory://"), Storage)
        assert hasattr(Storage, "snapshot")
        assert hasattr(Storage, "restore")
        assert create_storage("memory://").snapshot is not None
        assert create_storage("memory://").restore is not None


class TestSqliteSnapshot:
    async def test_snapshot_produces_identical_copy(self, tmp_path):
        db_path = str(tmp_path / "engine.db")
        snap_path = str(tmp_path / "snapshot.db")
        storage = SqliteStorage(db_path)
        await _fill(storage)
        await storage.snapshot(snap_path)

        copy = SqliteStorage(snap_path)
        latest = await copy.get_latest_checkpoint("t1")
        assert latest is not None
        assert latest.state == {"count": 1}
        events = await copy.events_after("t1", 0)
        assert len(events) == 1
        assert events[0].type == "reply_token"
        assert await copy.get_record("notes", "k1") == {"title": "hello"}
        await copy.close()
        await storage.close()

    async def test_restore_returns_to_snapshot_point(self, tmp_path):
        db_path = str(tmp_path / "engine.db")
        snap_path = str(tmp_path / "snapshot.db")
        storage = SqliteStorage(db_path)
        await _fill(storage)
        await storage.snapshot(snap_path)
        # 快照后继续修改（新 record + 新 checkpoint）
        await storage.put_record("notes", "k1", {"title": "changed"})
        await storage.put_checkpoint(_sample_record(0, "t1", count=99))
        await storage.restore(snap_path)
        assert await storage.get_record("notes", "k1") == {"title": "hello"}
        latest = await storage.get_latest_checkpoint("t1")
        assert latest is not None and latest.state == {"count": 1}
        await storage.close()

    async def test_snapshot_same_path_rejected(self, tmp_path):
        db_path = str(tmp_path / "engine.db")
        storage = SqliteStorage(db_path)
        await _fill(storage)
        with pytest.raises(Exception, match="不同位置"):
            await storage.snapshot(db_path)
        with pytest.raises(Exception, match="当前库已是"):
            await storage.restore(db_path)
        await storage.close()

    async def test_memory_db_snapshot_to_file(self, tmp_path):
        """内存库（:memory:）同样可快照到文件（backup API 支持）。"""
        snap_path = str(tmp_path / "mem.db")
        storage = SqliteStorage(":memory:")
        await _fill(storage)
        await storage.snapshot(snap_path)
        copy = SqliteStorage(snap_path)
        assert (await copy.get_record("notes", "k1")) == {"title": "hello"}
        await copy.close()
        await storage.close()


class TestMemorySnapshot:
    async def test_snapshot_restore_round_trip(self, tmp_path):
        snap_path = str(tmp_path / "mem-snapshot.json")
        storage = create_storage("memory://")
        await _fill(storage)
        await storage.snapshot(snap_path)
        # 修改后 restore 回快照时点
        await storage.put_record("notes", "k1", {"title": "mutated"})
        await storage.restore(snap_path)
        assert await storage.get_record("notes", "k1") == {"title": "hello"}
        latest = await storage.get_latest_checkpoint("t1")
        assert latest is not None and latest.state == {"count": 1}
        assert len(await storage.events_after("t1", 0)) == 1

    async def test_snapshot_into_fresh_instance(self, tmp_path):
        """快照可被另一个内存实例恢复（迁移引子场景）。"""
        snap_path = str(tmp_path / "mem-snapshot.json")
        storage = create_storage("memory://")
        await _fill(storage)
        await storage.snapshot(snap_path)
        other = create_storage("memory://")
        await other.restore(snap_path)
        assert await other.get_record("notes", "k1") == {"title": "hello"}
        assert (await other.get_latest_checkpoint("t1")).state == {"count": 1}
        await other.put_record("notes", "k2", {"new": True})  # 恢复正常读写

    async def test_restore_rejects_corrupt_file(self, tmp_path):
        bad = tmp_path / "bad.json"
        bad.write_text("{not valid json", encoding="utf-8")
        storage = create_storage("memory://")
        with pytest.raises(Exception, match="恢复失败"):
            await storage.restore(str(bad))


class TestPostgresSnapshot:
    async def test_postgres_raises_not_implemented(self):
        from ink_engine.core.storage_postgres import PostgresStorage

        storage = PostgresStorage("postgresql://u:p@localhost/db")
        with pytest.raises(NotImplementedError, match="pg_dump"):
            await storage.snapshot("x.db")
        with pytest.raises(NotImplementedError, match="pg_restore"):
            await storage.restore("x.db")
