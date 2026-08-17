"""内存存储实现（测试/单进程默认后端，异步锁保证并发安全）。"""
from __future__ import annotations

import asyncio

from .events import EngineEvent
from .exceptions import CheckpointConflictError
from .security import strip_sensitive
from .storage import CheckpointRecord


class MemoryStorage:
    """内存后端：checkpoint 版本链 + 事件日志 + structured records。

    并发安全：全部写操作经 asyncio.Lock 串行化；checkpoint 乐观锁按
    version 字段校验（冲突抛 CheckpointConflictError）。
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._checkpoints: dict[int, CheckpointRecord] = {}
        self._events: dict[str, list[EngineEvent]] = {}
        self._records: dict[str, dict[str, dict]] = {}
        self._next_checkpoint_id = 1
        self._next_event_seq = 1
        # per-thread 最新锚点指针（链尾校验/恢复定位 O(1)，避免全量扫描）
        self._latest_checkpoint_by_thread: dict[str, int] = {}

    # ── checkpoint 版本链 ──
    async def get_checkpoint(self, checkpoint_id: int) -> CheckpointRecord | None:
        return self._checkpoints.get(checkpoint_id)

    async def get_latest_checkpoint(self, thread_id: str) -> CheckpointRecord | None:
        async with self._lock:
            latest_id = self._latest_checkpoint_by_thread.get(thread_id)
            if latest_id is None:
                return None
            return self._checkpoints.get(latest_id)

    async def put_checkpoint(
        self, record: CheckpointRecord, *, expected_version: int | None = None, fork: bool = False
    ) -> CheckpointRecord:
        from dataclasses import replace

        async with self._lock:
            # 安全：落库前剥离敏感键（与 sqlite/postgres 走 to_dict 同口径）
            record = replace(record, state=strip_sensitive(record.state))
            if record.checkpoint_id == 0:
                if not fork and record.parent_id is not None:
                    # 并发写保护（与 sqlite/postgres 同语义，锁内校验原子）：
                    # 链尾仍是 parent_id 才插入；链已前进（并发写）→ 冲突。
                    latest_id = self._latest_checkpoint_by_thread.get(record.thread_id)
                    if latest_id is not None and latest_id > record.parent_id:
                        raise CheckpointConflictError(
                            f"checkpoint 并发写冲突（链尾已前进）: thread={record.thread_id}"
                        )
                record = CheckpointRecord(
                    checkpoint_id=self._next_checkpoint_id,
                    thread_id=record.thread_id,
                    node=record.node,
                    graph_path=record.graph_path,
                    state=record.state,
                    parent_id=record.parent_id,
                    reason=record.reason,
                    created_at=record.created_at,
                    version=record.version,
                    event_seq=record.event_seq,
                    error=record.error,
                )
                self._next_checkpoint_id += 1
            existing = self._checkpoints.get(record.checkpoint_id)
            if existing is not None:
                # 与 sqlite/postgres 同口径：expected_version=None = 自动读当前版本
                if expected_version is None:
                    expected_version = existing.version
                if existing.version != expected_version:
                    raise CheckpointConflictError(
                        f"checkpoint {record.checkpoint_id} 并发写冲突: "
                        f"expected version={expected_version}, actual={existing.version}"
                    )
                record = CheckpointRecord(
                    **{**record.to_dict(), "version": existing.version + 1}
                )
            self._checkpoints[record.checkpoint_id] = record
            self._latest_checkpoint_by_thread[record.thread_id] = record.checkpoint_id
            return record

    async def list_checkpoints(self, thread_id: str, *, limit: int = 100) -> list[CheckpointRecord]:
        async with self._lock:
            candidates = [
                c for c in self._checkpoints.values() if c.thread_id == thread_id
            ]
            candidates.sort(key=lambda c: c.checkpoint_id, reverse=True)
            return candidates[:limit]

    # ── 执行事件日志（append-only）──
    async def append_event(self, thread_id: str, event: EngineEvent) -> int:
        from dataclasses import replace

        async with self._lock:
            seq = self._next_event_seq
            self._next_event_seq += 1
            # 安全：事件负载落库前剥离敏感键（与 sqlite/postgres 同口径）
            event = replace(event, seq=seq, payload=strip_sensitive(event.payload))
            # seq 写回事件副本（重放/续流拿得到序号）
            self._events.setdefault(thread_id, []).append(event)
            return seq

    async def events_after(self, thread_id: str, seq: int) -> list[EngineEvent]:
        async with self._lock:
            events = self._events.get(thread_id, [])
            return [e for e in events if (e.seq or 0) > seq]

    async def latest_event_seq(self, thread_id: str) -> int:
        async with self._lock:
            events = self._events.get(thread_id, [])
            return events[-1].seq if events else 0

    async def truncate_events(self, thread_id: str, after_seq: int) -> None:
        async with self._lock:
            events = self._events.get(thread_id, [])
            self._events[thread_id] = [e for e in events if (e.seq or 0) <= after_seq]

    # ── structured records ──
    async def put_record(self, collection: str, key: str, data: dict) -> None:
        async with self._lock:
            # 安全：records（记忆/世界状态）落库前剥离敏感键
            self._records.setdefault(collection, {})[key] = strip_sensitive(data)

    async def get_record(self, collection: str, key: str) -> dict | None:
        return self._records.get(collection, {}).get(key)

    async def list_records(self, collection: str) -> list[dict]:
        return list(self._records.get(collection, {}).values())

    async def close(self) -> None:
        pass


__all__ = ["MemoryStorage"]
