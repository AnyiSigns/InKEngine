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

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .evolution_writer import DefaultEvolutionWriter, memory_writer
from .logging import get_logger
from .source_grading import (  # 来源分级单源（ENG3-19：与知识/检索统一分级类型）
    _SOURCE_CREDIBILITY,
)
from .storage import Storage

logger = get_logger(__name__)

# 来源分级 → 默认召回权重（复用 source_grading 分级基准；ENG3-19）
# 记忆来源取值宿主语义，但当来源落在统一分级词汇表（web/dialog/
# model/user）内时，默认权重 = 该级可信度基准——与知识条目
# credibility、检索 chunk level 同源同口径；词汇表外来源回落中性
# 1.0（非可信度语义的来源不套用分级）
SOURCE_WEIGHT_BY_SOURCE: dict[str, float] = dict(_SOURCE_CREDIBILITY)

# per-key 锁表上限（ENG3-6：锁字典随 entry_id 无限增长的内存泄漏防护——
# 超限时先驱逐空闲锁（未持有者），仍超限则放弃缓存直接新建）
_MAX_LOCK_ENTRIES = 4096


@dataclass(frozen=True, slots=True)
class MemoryEntry:
    """单条记忆条目（带元数据的累积单元）。

    Attributes:
        namespace: 记忆域（用户级 "user:<id>" 或 对象级 "object:<id>"），
            区分工作/长程/风格记忆的作用边界。
        content: 记忆内容。
        id: 条目唯一 id（存储实现分配，新建时为 None）。
        title: 可选标题（列表可读）。
        source: 来源（宿主语义，如 "decision"/"domain_window"/"self_reflection"）。
        priority: 优先级（数值大优先，召回排序用）。
        weight: 召回权重（相关度维度，确定性召回外的调酒师融合用）。
            来源落在统一分级词汇表（source_grading.SOURCE_*）内时，
            未显式声明的权重默认 = 该级可信度基准（ENG3-19：来源/权重
            概念与知识集、检索同一套分级类型）。
        meta: 业务元数据（宿主语义，如 domain/related_entity_id/...）。
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

    def __post_init__(self) -> None:
        # 来源权重统一（ENG3-19）：来源落在统一分级词汇表内且权重未
        # 显式声明（= 中性默认 1.0）时，按该级可信度基准定默认权重。
        # 显式声明的权重优先（显式 1.0 与默认不可区分，同按分级基准
        # 覆盖——需要中性权重的分级来源可显式用词汇表外来源名）
        if self.weight == 1.0 and self.source in SOURCE_WEIGHT_BY_SOURCE:
            object.__setattr__(self, "weight", SOURCE_WEIGHT_BY_SOURCE[self.source])

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

    并发：update/delete 为读-改-写两段操作，本实现以进程内 per-key 锁
    串行化（asyncio 单进程内安全）；跨进程并发写仍需宿主在业务层
    串行化（存储抽象不提供跨进程事务级合并）。

    查询语义（ENG3-7）：过滤（namespace/kind/source/时效）与召回排序
    （priority 降序 + created_at 降序 + limit 截断）统一在存储边界完成
    ——调用方取回即终态，不再二次 recall 排序；召回策略可注入
    （``recall_policy``，默认 :class:`PriorityRecallPolicy`），策略判据
    单点维护（存储层与协议层不重复实现同一排序）。
    """

    def __init__(
        self,
        storage: Storage,
        collection: str = "memory",
        *,
        recall_policy: MemoryRecallPolicy | None = None,
    ) -> None:
        self._storage = storage
        self._collection = collection
        self._locks: dict[str, asyncio.Lock] = {}
        self._recall = recall_policy or PriorityRecallPolicy()
        self._writer = DefaultEvolutionWriter(storage)

    def _lock_for(self, entry_id: str) -> asyncio.Lock:
        lock = self._locks.get(entry_id)
        if lock is None:
            if len(self._locks) >= _MAX_LOCK_ENTRIES:
                # 有界防护（ENG3-6）：超限先驱逐空闲锁（未持有者）——
                # 持有中的锁驱逐会破坏并发串行化，不驱逐
                idle = [
                    eid
                    for eid, existing in self._locks.items()
                    if not existing.locked()
                ]
                for eid in idle[:_MAX_LOCK_ENTRIES // 2]:
                    self._locks.pop(eid, None)
            lock = self._locks[entry_id] = asyncio.Lock()
        return lock

    async def save(self, entry: MemoryEntry) -> str:
        entry_id = entry.id or _make_id(entry)
        await memory_writer(
            self._writer,
            self._collection,
            entry_id,
            _entry_to_record(entry, entry_id),
            note="save",
        )
        return entry_id

    async def get(self, entry_id: str) -> MemoryEntry | None:
        rec = await self._storage.get_record(self._collection, entry_id)
        if not rec or rec.get("_deleted"):
            return None
        return _record_to_entry(rec)

    async def update(self, entry_id: str, data: dict) -> bool:
        # 读-改-写整体持锁：并发 update 同 key 不互相覆盖（丢更新）
        async with self._lock_for(entry_id):
            rec = await self._storage.get_record(self._collection, entry_id)
            if not rec or rec.get("_deleted"):
                return False
            # id/namespace/created_at 为不可变身份字段，更新忽略
            protected = {"id", "namespace", "created_at", "_deleted"}
            new_rec = {**rec, **{k: v for k, v in data.items() if k not in protected}}
            await memory_writer(
                self._writer, self._collection, entry_id, new_rec, note="update"
            )
            return True

    async def delete(self, entry_id: str) -> bool:
        async with self._lock_for(entry_id):
            rec = await self._storage.get_record(self._collection, entry_id)
            if not rec:
                return False
            # 非破坏性删除：标记失效而非物理擦除（与 Event Sourcing 哲学一致）
            new_rec = {**rec, "_deleted": True}
            await memory_writer(
                self._writer, self._collection, entry_id, new_rec, note="delete"
            )
            self._locks.pop(entry_id, None)
            return True

    async def query(self, q: MemoryQuery) -> list[MemoryEntry]:
        # 过滤（namespace/kind/source/时效）+ 召回排序统一在存储边界
        # 完成（ENG3-7 by-design）：取回即终态，调用方不再二次 recall
        # 排序——排序判据单点维护在 recall_policy（与协议层同判据不重
        # 复）。过滤（namespace/kind/source/时效）仍在内存执行，by-design：
        # 存储协议 ``Storage.list_records`` 只有全量原语，无字段级下推
        # （sqlite/postgres WHERE 子句属存储层演进，本抽象层零侵入）
        # ——下推会引入跨后端差异（内存/sqlite/postgres 三套实现不同
        # 字段类型/scheme/索引），反而让「调用方取回即终态」契约漂
        # 移；当前实现保证：所有后端返回前都经过统一过滤 + 排序
        # （recall_policy 注入点），调用方零关心。
        recs = await self._storage.list_records(self._collection)
        now = time.time()
        alive: list[MemoryEntry] = []
        for rec in recs:
            if rec.get("_deleted"):
                continue
            entry = _record_to_entry(rec)
            if q.namespace is not None and entry.namespace != q.namespace:
                continue
            if q.kind is not None and entry.kind != q.kind:
                continue
            if q.source is not None and entry.source != q.source:
                continue
            if not entry.is_expired(now):
                alive.append(entry)
        return self._recall.recall(alive, limit=q.limit)


__all__ = [
    "SOURCE_WEIGHT_BY_SOURCE",
    "MemoryEntry",
    "MemoryQuery",
    "MemoryRecallPolicy",
    "MemoryStore",
    "PriorityRecallPolicy",
    "StorageBackedMemoryStore",
]
