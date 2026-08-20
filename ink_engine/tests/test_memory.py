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
