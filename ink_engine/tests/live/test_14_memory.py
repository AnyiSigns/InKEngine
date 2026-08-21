"""族 14：记忆（test_14_memory.py）｜memory。

- StorageBackedMemoryStore 真实落库/查询；MemoryQuery 全过滤维度
  （namespace/kind/source/limit）
- PriorityRecallPolicy 排序；非破坏性失效（forget 标记）；跨实例读取
- 记忆 → 上下文调配注入联动（与族 7 组合）

确定性机制用例（零模型调用）+ 1 条真实 LLM 用例（族门禁②）。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.memory import (  # noqa: E402
    MemoryEntry,
    MemoryQuery,
    PriorityRecallPolicy,
    StorageBackedMemoryStore,
)


@pytest.fixture
def mem_store(sqlite_storage):
    return StorageBackedMemoryStore(sqlite_storage)


async def test_memory_save_get_query(mem_store, sqlite_storage):
    entry = MemoryEntry(
        namespace="user:u1",
        kind="decision",
        content="用户偏好简洁回答",
        source="domain_window",
        priority=9,
    )
    entry_id = await mem_store.save(entry)
    assert entry_id.startswith("user:u1:")
    fetched = await mem_store.get(entry_id)
    assert fetched is not None and fetched.content == "用户偏好简洁回答"
    assert fetched.priority == 9
    # 查询过滤：namespace/kind/source/limit
    await mem_store.save(
        MemoryEntry(namespace="user:u1", kind="fact", content="A", source="self_reflection", priority=1)
    )
    await mem_store.save(
        MemoryEntry(namespace="user:u1", kind="fact", content="B", source="manual", priority=3)
    )
    await mem_store.save(
        MemoryEntry(namespace="object:o1", kind="fact", content="C", source="manual", priority=2)
    )
    facts = await mem_store.query(MemoryQuery(namespace="user:u1", kind="fact"))
    assert {e.content for e in facts} == {"A", "B"}
    manual = await mem_store.query(MemoryQuery(namespace="user:u1", source="manual"))
    assert [e.content for e in manual] == ["B"]
    limited = await mem_store.query(MemoryQuery(namespace="user:u1", limit=2))
    assert len(limited) == 2


async def test_memory_update_and_non_destructive_forget(mem_store):
    entry_id = await mem_store.save(
        MemoryEntry(namespace="user:u1", kind="fact", content="旧内容", priority=5)
    )
    updated = await mem_store.update(entry_id, {"content": "新内容"})
    assert updated is True
    assert (await mem_store.get(entry_id)).content == "新内容"
    # 非破坏性失效（forget = 标记失效，记录仍可追溯）
    deleted = await mem_store.delete(entry_id)
    assert deleted is True
    assert await mem_store.get(entry_id) is None
    # 底层记录仍可读（Event Sourcing 哲学：不物理擦除）
    record = await mem_store._storage.get_record("memory", entry_id)
    assert record is not None and record["content"] == "新内容"


async def test_memory_cross_instance_read(mem_store, sqlite_storage):
    entry_id = await mem_store.save(
        MemoryEntry(namespace="user:u1", kind="fact", content="跨实例", priority=7)
    )
    # 新 store 实例（同存储后端）：真实落库读取
    other = StorageBackedMemoryStore(sqlite_storage)
    fetched = await other.get(entry_id)
    assert fetched is not None and fetched.content == "跨实例"


def test_priority_recall_policy():
    entries = [
        MemoryEntry(namespace="n", kind="k", content="低", priority=1, created_at=1),
        MemoryEntry(namespace="n", kind="k", content="高", priority=9, created_at=2),
        MemoryEntry(namespace="n", kind="k", content="过期", priority=10, expires_at=1),
    ]
    recalled = PriorityRecallPolicy().recall(entries, limit=2)
    assert [e.content for e in recalled] == ["高", "低"]  # 优先级降序 + 过期剔除
    assert PriorityRecallPolicy().recall(entries, limit=1)[0].content == "高"


async def test_memory_into_context_assembly(mem_store):
    """记忆 → 上下文调配注入联动：召回记忆作为 memory 源进入组装产物。"""
    from ink_engine.core.assembly import (
        SOURCE_MEMORY,
        AssemblyConfig,
        InputAssembler,
    )
    from ink_engine.core.context import ContextSource

    await mem_store.save(
        MemoryEntry(namespace="user:u1", kind="style", content="回答保持简洁", priority=9)
    )
    recalls = await mem_store.query(MemoryQuery(namespace="user:u1", kind="style"))
    assert recalls
    sources = [
        ContextSource(
            type=SOURCE_MEMORY,
            content=f"[记忆:{recalls[0].content}]",
            title="style",
            priority=8,
        )
    ]
    assembler = InputAssembler(AssemblyConfig(enabled=True, total_budget=4000))
    assembled = assembler.assemble(sources)  # 同步装配（纯函数组装）
    assert recalls[0].content in assembled.text  # 记忆内容进入组装产物
    # 激活留痕：memory 源进入激活记录（模型可见皆记录）
    activated_types = {s.source_type for s in assembled.record.sources}
    assert SOURCE_MEMORY in activated_types


# ----------------------------------------------------------------------
# 真实 LLM 回合：记忆召回注入上下文（族门禁②）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_round_memory_injection(live_llm, mem_store, memory_storage):
    """记忆召回注入回合上下文 → 真实 LLM 消费（行为契约：回复非空）。"""
    from ink_engine.core.events import CollectorTransport
    from ink_engine.core.executor import Engine, RunOptions
    from ink_engine.core.graph import Graph, TerminateReason
    from ink_engine.core.llm.messages import user

    await mem_store.save(
        MemoryEntry(namespace="user:live", kind="style", content="回答保持简洁", priority=9)
    )
    recalls = await mem_store.query(MemoryQuery(namespace="user:live", kind="style"))
    assert recalls
    memory_text = recalls[0].content

    async def llm_node(ctx):
        result = await live_llm.ainvoke(
            [user(f"请用一句话回应，注意风格要求：{memory_text}")]
        )
        await ctx.emit("reply_token", {"content": result.content})
        return {"answer": result.content}

    g = Graph(name="real_memory", entry="n")
    g.add_node("n", llm_node)
    g.add_exit("n")
    engine = Engine(g, options=RunOptions(storage=memory_storage, transports=[CollectorTransport()]))
    result = await engine.ainvoke({}, thread_id="real-memory")
    assert result.reason == TerminateReason.REPLY
    assert result.state["answer"].strip()
