"""记忆策略原语（领域复用：各类 agent 通用）。

记忆 = 带元数据的条目累积（来源/权重/时效），取用 = 召回策略按时间线
与权重筛选。引擎只定义存储接口与召回/失效策略契约，不绑定具体持久化
与业务语义——任意宿主记忆（结构化记忆/文件记忆/向量记忆）实现同一
MemoryStore 协议即可互换。

分层语义（业务层职责，引擎不约束）：工作记忆（回合内域窗口/消息）、
长程记忆（每对象）、风格记忆（用户偏好）都是 MemoryEntry 的
namespace/kind 区分；召回策略按 namespace + kind + 权重排序取用。

删除对非破坏性开放：forget = 标记失效而非物理擦除，与引擎 Event
Sourcing 哲学一致，失效记录仍可追溯。
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .logging import get_logger
from .storage import Storage

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class MemoryEntry:
    """单条记忆条目（带元数据的累积单元）。

    Attributes:
        namespace: 记忆域（用户级 "user:<id>" 或 对象级 "object:<id>"），
            区分工作/长程/风格记忆的作用边界。
        content: 记忆内容。
        id: 条目唯一 id（存储实现分配，新建时为 None）。
        title: 可选标题（列表可读）。
        source: 来源（chapter_decision/domain_window/agent_self_reflection/...）。
        priority: 优先级（数值大优先，召回排序用）。
        weight: 召回权重（相关度维度，确定性召回外的调酒师融合用）。
        meta: 业务元数据（domain/related_chapter_id/...）。
        created_at: 创建时间戳（epoch 秒）。
        expires_at: 失效时间戳（None = 不过期；时效失效策略用）。
    """

    namespace: str
    kind: str
    content: str
    id: str | None = None
    title: str | None = None
    source: str = "manual"
    priority: int = 5
    weight: float = 1.0
    meta: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    expires_at: float | None = None

    def is_expired(self, now: float | None = None) -> bool:
        if self.expires_at is None:
            return False
        return (now or time.time()) >= self.expires_at


@dataclass(frozen=True, slots=True)
class MemoryQuery:
    """记忆查询条件（存储实现按字段过滤）。"""

    namespace: str | None = None
    kind: str | None = None
    source: str | None = None
    limit: int | None = None


@runtime_checkable
class MemoryStore(Protocol):
    """记忆存储接口（可换后端）。

    实现要求：
    - save 幂等安全（同 namespace+source+meta 去重由实现决定）；
    - query 按 namespace/kind/source 过滤（默认按 priority 降序）；
    - delete 语义为「遗忘」，物理删除或标记失效均可，召回不再返回即可。
    """

    async def save(self, entry: MemoryEntry) -> str: ...
    async def get(self, entry_id: str) -> MemoryEntry | None: ...
    async def update(self, entry_id: str, data: dict) -> bool: ...
    async def delete(self, entry_id: str) -> bool: ...
    async def query(self, q: MemoryQuery) -> list[MemoryEntry]: ...


@runtime_checkable
class MemoryRecallPolicy(Protocol):
    """记忆召回策略（取用 = 召回 + 排序 + 截断）。

    确定性召回（默认）：过滤未过期条目，按 priority 降序、created_at
    降序排序，截断 top-k。相关度/权重维度由业务扩展实现（如语义检索
    结果注入 weight）后复用同一契约。
    """

    def recall(self, entries: list[MemoryEntry], *, limit: int | None = None) -> list[MemoryEntry]: ...


class PriorityRecallPolicy:
    """默认召回策略：优先级 + 时效 + 时间线排序的确定性召回。"""

    def recall(self, entries: list[MemoryEntry], *, limit: int | None = None) -> list[MemoryEntry]:
        now = time.time()
        alive = [e for e in entries if not e.is_expired(now)]
        alive.sort(key=lambda e: (e.priority, e.created_at), reverse=True)
        if limit is not None:
            return alive[:limit]
        return alive


def _make_id(entry: MemoryEntry) -> str:
    """新建条目 id 生成（namespace 域内唯一即可，复用者无需关系型主键）。"""
    return f"{entry.namespace}:{uuid.uuid4().hex}"


def _entry_to_record(entry: MemoryEntry, entry_id: str) -> dict[str, Any]:
    """MemoryEntry → 存储记录（结构化 JSON，通用存储服务直接落库）。"""
    return {
        "id": entry_id,
        "namespace": entry.namespace,
        "kind": entry.kind,
        "content": entry.content,
        "title": entry.title,
        "source": entry.source,
        "priority": entry.priority,
        "weight": entry.weight,
        "meta": entry.meta,
        "created_at": entry.created_at,
        "expires_at": entry.expires_at,
    }


def _record_to_entry(rec: dict[str, Any]) -> MemoryEntry:
    """存储记录 → MemoryEntry（字段缺失走默认值，兼容旧记录）。"""
    return MemoryEntry(
        id=rec.get("id"),
        namespace=rec.get("namespace", ""),
        kind=rec.get("kind", ""),
        content=rec.get("content", ""),
        title=rec.get("title"),
        source=rec.get("source", "manual"),
        priority=int(rec.get("priority", 5)),
        weight=float(rec.get("weight", 1.0)),
        meta=rec.get("meta") or {},
        created_at=float(rec.get("created_at", time.time())),
        expires_at=rec.get("expires_at"),
    )


class StorageBackedMemoryStore:
    """引擎默认记忆存储：基于通用存储服务（memory/sqlite/postgres 共用）。

    引擎零反向依赖：复用者无需关系型数据库即可获得可换后端、可持久化的
    记忆能力。删除走非破坏性语义（标记失效而非物理擦除），与引擎
    Event Sourcing 哲学一致——forget = 失效，记录仍可追溯。
    """

    def __init__(self, storage: Storage, collection: str = "memory") -> None:
        self._storage = storage
        self._collection = collection

    async def save(self, entry: MemoryEntry) -> str:
        entry_id = entry.id or _make_id(entry)
        await self._storage.put_record(self._collection, entry_id, _entry_to_record(entry, entry_id))
        return entry_id

    async def get(self, entry_id: str) -> MemoryEntry | None:
        rec = await self._storage.get_record(self._collection, entry_id)
        if not rec or rec.get("_deleted"):
            return None
        return _record_to_entry(rec)

    async def update(self, entry_id: str, data: dict) -> bool:
        rec = await self._storage.get_record(self._collection, entry_id)
        if not rec or rec.get("_deleted"):
            return False
        # id/namespace/created_at 为不可变身份字段，更新忽略
        protected = {"id", "namespace", "created_at", "_deleted"}
        rec.update({k: v for k, v in data.items() if k not in protected})
        await self._storage.put_record(self._collection, entry_id, rec)
        return True

    async def delete(self, entry_id: str) -> bool:
        rec = await self._storage.get_record(self._collection, entry_id)
        if not rec:
            return False
        rec = {**rec, "_deleted": True}
        await self._storage.put_record(self._collection, entry_id, rec)
        return True

    async def query(self, q: MemoryQuery) -> list[MemoryEntry]:
        recs = await self._storage.list_records(self._collection)
        entries = [_record_to_entry(r) for r in recs if not r.get("_deleted")]
        if q.namespace is not None:
            entries = [e for e in entries if e.namespace == q.namespace]
        if q.kind is not None:
            entries = [e for e in entries if e.kind == q.kind]
        if q.source is not None:
            entries = [e for e in entries if e.source == q.source]
        entries.sort(key=lambda e: (e.priority, e.created_at), reverse=True)
        if q.limit is not None:
            entries = entries[: q.limit]
        return entries


__all__ = [
    "MemoryEntry",
    "MemoryQuery",
    "MemoryRecallPolicy",
    "MemoryStore",
    "PriorityRecallPolicy",
    "StorageBackedMemoryStore",
]
