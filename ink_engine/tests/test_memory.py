"""记忆策略原语单测：条目时效/召回排序/默认存储后端。"""
from __future__ import annotations

import time

from ink_engine.core.memory import (
    MemoryEntry,
    MemoryQuery,
    PriorityRecallPolicy,
    StorageBackedMemoryStore,
)
from ink_engine.core.storage import create_storage


def _entry(
    namespace="book:1", kind="plot", content="c", priority=5, created_at=None, **kw
) -> MemoryEntry:
    if created_at is None:
        created_at = time.time()
    return MemoryEntry(
        namespace=namespace,
        kind=kind,
        content=content,
        priority=priority,
        created_at=created_at,
        **kw,
    )


def test_entry_is_expired():
    now = time.time()
    fresh = MemoryEntry(namespace="u", kind="k", content="x", expires_at=None)
    dead = MemoryEntry(namespace="u", kind="k", content="x", expires_at=now - 1)
    soon = MemoryEntry(namespace="u", kind="k", content="x", expires_at=now + 100)
    assert not fresh.is_expired(now)
    assert dead.is_expired(now)
    assert not soon.is_expired(now)


def test_recall_priority_then_recency():
    base = time.time()
    low_old = _entry(priority=1, created_at=base - 100)
    high_new = _entry(priority=9, created_at=base - 10)
    high_old = _entry(priority=9, created_at=base - 200)
    result = PriorityRecallPolicy().recall([low_old, high_new, high_old])
    assert [e.priority for e in result] == [9, 9, 1]
    # 同优先级按时间线降序（新在前）
    assert result[0] is high_new
    assert result[1] is high_old


def test_recall_excludes_expired_and_limits():
    base = time.time()
    alive = [_entry(priority=i, created_at=base - i) for i in range(5)]
    dead = _entry(priority=99, expires_at=base - 1)
    result = PriorityRecallPolicy().recall([*alive, dead], limit=2)
    assert len(result) == 2
    assert dead not in result
    assert all(not e.is_expired(base) for e in result)


async def test_storage_backed_save_get_update():
    store = StorageBackedMemoryStore(create_storage("memory://"))
    eid = await store.save(_entry(namespace="book:7", kind="plot", content="摘要", priority=4))
    got = await store.get(eid)
    assert got is not None
    assert got.content == "摘要" and got.namespace == "book:7"

    ok = await store.update(eid, {"content": "新摘要", "priority": 8})
    assert ok
    updated = await store.get(eid)
    assert updated.content == "新摘要" and updated.priority == 8
    # 身份字段不可变
    assert updated.namespace == "book:7" and updated.created_at == got.created_at


async def test_storage_backed_delete_soft():
    store = StorageBackedMemoryStore(create_storage("memory://"))
    eid = await store.save(_entry(kind="style", content="偏好"))
    assert await store.delete(eid)
    assert await store.get(eid) is None
    # 查询不再返回失效条目
    assert await store.query(MemoryQuery(kind="style")) == []


async def test_storage_backed_query_filters():
    store = StorageBackedMemoryStore(create_storage("memory://"))
    await store.save(_entry(namespace="book:1", kind="plot", source="a", priority=3))
    await store.save(_entry(namespace="book:1", kind="plot", source="b", priority=7))
    await store.save(_entry(namespace="book:2", kind="style", source="a", priority=5))

    by_source = await store.query(MemoryQuery(namespace="book:1", source="a"))
    assert len(by_source) == 1 and by_source[0].source == "a"

    by_kind = await store.query(MemoryQuery(kind="plot", limit=1))
    assert len(by_kind) == 1
    # 默认按优先级降序，limit 取头部
    assert by_kind[0].priority == 7


async def test_delete_removes_lock_entry():
    """ENG3-6 回归：删除后 per-key 锁移除（锁字典不随失效条目无限增长）。"""
    store = StorageBackedMemoryStore(create_storage("memory://"))
    eid = await store.save(_entry())
    await store.update(eid, {"content": "x"})  # 读改写路径创建锁
    assert eid in store._locks
    await store.delete(eid)
    assert eid not in store._locks
    # 重建同 id 条目走新锁（锁表无状态残留）
    await store.update(eid, {"content": "y"})
    assert eid in store._locks


async def test_query_recall_applied_at_store_boundary():
    """ENG3-7 回归：过滤 + 召回排序统一在存储边界（取回即终态）。"""
    store = StorageBackedMemoryStore(create_storage("memory://"))
    await store.save(_entry(namespace="book:1", kind="plot", source="a", priority=3))
    await store.save(_entry(namespace="book:1", kind="plot", source="b", priority=7))
    await store.save(_entry(namespace="book:2", kind="style", source="a", priority=5))

    by_source = await store.query(MemoryQuery(namespace="book:1", source="a"))
    assert len(by_source) == 1 and by_source[0].source == "a"
    by_kind = await store.query(MemoryQuery(kind="plot", limit=1))
    assert len(by_kind) == 1
    assert by_kind[0].priority == 7  # 默认按优先级降序（store 内已排序）
    # 注入自定义召回策略：策略判据单点生效
    class Reversed:
        def recall(self, entries, *, limit=None):
            out = sorted(entries, key=lambda e: e.priority)
            return out[:limit] if limit is not None else out

    store2 = StorageBackedMemoryStore(
        create_storage("memory://"), recall_policy=Reversed()  # type: ignore[arg-type]
    )
    await store2.save(_entry(priority=3))
    await store2.save(_entry(priority=9))
    got = await store2.query(MemoryQuery())
    assert [e.priority for e in got] == [3, 9]


def test_memory_source_weight_uses_grading_table():
    """ENG3-19 回归：来源落在分级词汇表内 → 默认权重 = 该级可信度。"""
    web = MemoryEntry(namespace="u", kind="k", content="x", source="web")
    user = MemoryEntry(namespace="u", kind="k", content="x", source="user")
    manual = MemoryEntry(namespace="u", kind="k", content="x", source="custom")
    assert web.weight == 0.3
    assert user.weight == 0.9
    assert manual.weight == 1.0  # 词汇表外来源保持中性
    # 显式非默认权重优先（显式 1.0 与默认不可区分，按分级基准覆盖——
    # 见 MemoryEntry.__post_init__ 语义说明）
    explicit = MemoryEntry(namespace="u", kind="k", content="x", source="web", weight=0.8)
    assert explicit.weight == 0.8
