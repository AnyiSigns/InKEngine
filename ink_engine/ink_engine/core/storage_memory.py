"""内存存储实现（测试/单进程默认后端，异步锁保证并发安全）。

与 sqlite/postgres 后端同口径：checkpoint/records 落库前走 JSON 序列化
契约（CheckpointRecord.to_dict 内联敏感键剥离 + PatchChain/Message 标记，
from_dict 精确还原类型），事件负载走 strip + JSON 往返——杜绝「内存
后端存活引用/非 JSON 形态，切库即错」的三后端漂移。读取返回深拷贝，
防消费方修改污染存储内快照。
"""
from __future__ import annotations

import asyncio
import copy
import json

from .events import EngineEvent
from .exceptions import CheckpointConflictError, StorageError
from .security import strip_sensitive
from .storage import ChainLink, CheckpointRecord


def _normalize_record(record: CheckpointRecord) -> CheckpointRecord:
    """序列化契约规范化（与 SQL 后端同口径）：JSON 形态 + 深拷贝 + 敏感剥离。

    不可 JSON 序列化的状态（非标记类型对象）抛 StorageError，与 sqlite
    json.dumps 失败行为对齐——含任意对象的状态在生产第一条 checkpoint
    就失败，而非内存后端静默通过、切库即错。
    """
    data = record.to_dict()
    try:
        json.dumps(data, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise StorageError(f"checkpoint 状态不可 JSON 序列化: {exc}") from exc
    return CheckpointRecord.from_dict(data)


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
        record = self._checkpoints.get(checkpoint_id)
        return CheckpointRecord.from_dict(record.to_dict()) if record else None

    async def get_latest_checkpoint(self, thread_id: str) -> CheckpointRecord | None:
        async with self._lock:
            latest_id = self._latest_checkpoint_by_thread.get(thread_id)
            if latest_id is None:
                return None
            record = self._checkpoints.get(latest_id)
            return CheckpointRecord.from_dict(record.to_dict()) if record else None

    async def put_checkpoint(
        self, record: CheckpointRecord, *, expected_version: int | None = None, fork: bool = False
    ) -> CheckpointRecord:
        async with self._lock:
            # 序列化契约：JSON 形态 + 深拷贝 + 敏感剥离（与 sqlite/postgres 同口径）
            record = _normalize_record(record)
            if record.checkpoint_id == 0:
                if not fork and record.parent_id is not None:
                    # 链一致性不变量（与 sqlite/postgres 同语义，锁内原子判定）：
                    # 父指针必须存在且属于同一 thread、event_seq 不高于新节点
                    # （悬挂/跨线程父指针与 event_seq 回退在写入期暴露）。
                    parent = self._checkpoints.get(record.parent_id)
                    if (
                        parent is None
                        or parent.thread_id != record.thread_id
                        or parent.event_seq > record.event_seq
                    ):
                        raise CheckpointConflictError(
                            f"checkpoint 写入被拒绝（父指针不存在/跨线程/event_seq 回退）: "
                            f"thread={record.thread_id} parent=#{record.parent_id}"
                        )
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
                    version=1,  # 与 sqlite/postgres 同口径：新节点 version 恒 1
                    event_seq=record.event_seq,
                    error=record.error,
                    interrupt=record.interrupt,
                    graph_version=record.graph_version,
                    plan=record.plan,
                )
                self._next_checkpoint_id += 1
                self._checkpoints[record.checkpoint_id] = record
                current = self._latest_checkpoint_by_thread.get(record.thread_id)
                if current is None or record.checkpoint_id > current:
                    self._latest_checkpoint_by_thread[record.thread_id] = record.checkpoint_id
                # 返回深拷贝副本（与 sqlite 返回对象与存储解耦的语义一致：
                # 调用方修改返回记录不得污染存储内快照）
                return CheckpointRecord.from_dict(record.to_dict())
            # 显式更新路径（checkpoint_id != 0）：与 sqlite/postgres 同口径，
            # 更新不存在的 checkpoint 抛错（内存端静默插入任意 id 会让
            # 并发校验与自增 id 错乱）
            existing = self._checkpoints.get(record.checkpoint_id)
            if existing is None:
                raise StorageError(f"checkpoint 不存在: {record.checkpoint_id}")
            # 与 sqlite/postgres 同口径：expected_version=None = 自动读当前版本
            if expected_version is None:
                expected_version = existing.version
            if existing.version != expected_version:
                raise CheckpointConflictError(
                    f"checkpoint {record.checkpoint_id} 并发写冲突: "
                    f"expected version={expected_version}, actual={existing.version}"
                )
            # 更新经 to_dict/from_dict 规范化（禁止 to_dict 回灌构造器：
            # graph_path 变 list / interrupt 变 dict 会污染记录类型，
            # 恢复路径按 tuple 哈希定位锚点时直接崩溃）
            # 父指针不可变（与 sqlite/postgres 的 UPDATE 不含 parent_id
            # 同口径）：更新路径忽略传入值，保留链上原有父指针——父指针
            # 改写是链级 rebase 的专属操作（set_checkpoint_parent）。
            record = CheckpointRecord.from_dict(
                {
                    **record.to_dict(),
                    "version": existing.version + 1,
                    "parent_id": existing.parent_id,
                }
            )
            self._checkpoints[record.checkpoint_id] = record
            # 链尾指针只前进（与 sqlite/postgres 的 MAX(checkpoint_id)
            # 语义一致）：更新历史 checkpoint 不得回退链尾，否则并发续链
            # 保护与恢复锚点定位失效
            current = self._latest_checkpoint_by_thread.get(record.thread_id)
            if current is None or record.checkpoint_id > current:
                self._latest_checkpoint_by_thread[record.thread_id] = record.checkpoint_id
            # 返回深拷贝副本（调用方修改返回记录不得污染存储内快照）
            return CheckpointRecord.from_dict(record.to_dict())

    async def list_checkpoints(self, thread_id: str, *, limit: int = 100) -> list[CheckpointRecord]:
        async with self._lock:
            candidates = [
                c for c in self._checkpoints.values() if c.thread_id == thread_id
            ]
            candidates.sort(key=lambda c: c.checkpoint_id, reverse=True)
            # 深拷贝副本（与 get_checkpoint 同口径：调用方修改返回记录
            # 不得污染存储内快照）
            return [
                CheckpointRecord.from_dict(c.to_dict()) for c in candidates[:limit]
            ]

    async def chain_index(self, thread_id: str) -> list[ChainLink]:
        async with self._lock:
            links = [
                ChainLink(
                    checkpoint_id=c.checkpoint_id,
                    parent_id=c.parent_id,
                    event_seq=c.event_seq,
                    graph_path=c.graph_path,
                    reason=c.reason,
                )
                for c in self._checkpoints.values()
                if c.thread_id == thread_id
            ]
            links.sort(key=lambda link: link.checkpoint_id, reverse=True)
            return links

    async def delete_checkpoints(self, thread_id: str, ids: list[int]) -> int:
        async with self._lock:
            target = set(ids)
            removed = 0
            for cid in target:
                record = self._checkpoints.pop(cid, None)
                if record is None or record.thread_id != thread_id:
                    continue
                removed += 1
                # 链尾指针防退：删除行恰为链尾时重算为剩余最大 id
                # （压缩规划恒保留叶行，此为误用兜底）
                if self._latest_checkpoint_by_thread.get(thread_id) == cid:
                    remaining = [
                        c.checkpoint_id
                        for c in self._checkpoints.values()
                        if c.thread_id == thread_id
                    ]
                    self._latest_checkpoint_by_thread[thread_id] = (
                        max(remaining) if remaining else None
                    )
            return removed

    async def set_checkpoint_parent(
        self, thread_id: str, checkpoint_id: int, parent_id: int | None
    ) -> None:
        async with self._lock:
            existing = self._checkpoints.get(checkpoint_id)
            if existing is None or existing.thread_id != thread_id:
                return  # 与 SQL 后端同口径：无匹配行静默无操作（幂等）
            self._checkpoints[checkpoint_id] = CheckpointRecord.from_dict(
                {**existing.to_dict(), "parent_id": parent_id}
            )

    # ── 执行事件日志（append-only）──
    async def append_event(self, thread_id: str, event: EngineEvent) -> int:
        from dataclasses import replace

        async with self._lock:
            seq = self._next_event_seq
            self._next_event_seq += 1
            # 安全 + 序列化契约：敏感键剥离后 JSON 往返（与 sqlite 的
            # strip → to_json(default=str) 同口径：非 JSON 对象静默字符串化）
            payload = json.loads(
                json.dumps(strip_sensitive(event.payload), ensure_ascii=False, default=str)
            )
            # seq 写回事件副本（重放/续流拿得到序号）
            event = replace(event, seq=seq, payload=payload)
            self._events.setdefault(thread_id, []).append(event)
            return seq

    async def events_after(self, thread_id: str, seq: int) -> list[EngineEvent]:
        async with self._lock:
            events = self._events.get(thread_id, [])
            # 深拷贝：重放消费方修改事件不得污染存储内日志
            return [copy.deepcopy(e) for e in events if (e.seq or 0) > seq]

    async def latest_event_seq(self, thread_id: str) -> int:
        async with self._lock:
            events = self._events.get(thread_id, [])
            return events[-1].seq if events else 0

    async def truncate_events(self, thread_id: str, after_seq: int) -> None:
        async with self._lock:
            events = self._events.get(thread_id, [])
            self._events[thread_id] = [e for e in events if (e.seq or 0) <= after_seq]

    async def trim_events(self, thread_id: str, before_seq: int) -> int:
        async with self._lock:
            events = self._events.get(thread_id, [])
            kept = [e for e in events if (e.seq or 0) > before_seq]
            self._events[thread_id] = kept
            return len(events) - len(kept)

    # ── structured records ──
    async def put_record(self, collection: str, key: str, data: dict) -> None:
        async with self._lock:
            try:
                # 安全 + 序列化契约：敏感键剥离后 JSON 往返（与 sqlite 同口径，
                # 非 JSON 对象抛错而非静默降级）
                normalized = json.loads(
                    json.dumps(strip_sensitive(data), ensure_ascii=False)
                )
            except (TypeError, ValueError) as exc:
                raise StorageError(f"records 写入失败: {exc}") from exc
            self._records.setdefault(collection, {})[key] = normalized

    async def get_record(self, collection: str, key: str) -> dict | None:
        record = self._records.get(collection, {}).get(key)
        return copy.deepcopy(record) if record is not None else None

    async def list_records(self, collection: str) -> list[dict]:
        return [copy.deepcopy(r) for r in self._records.get(collection, {}).values()]

    async def close(self) -> None:
        pass


__all__ = ["MemoryStorage"]
