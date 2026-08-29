"""技能×知识集合并容器测试：转换 / 适配器 / 检索排除 / 组装技能先例。

覆盖（合并闭环的三处接线）：
- 技能 ↔ 知识集 kind=path 条目双向转换（无损重建）；
- KnowledgeSkillStore 适配器（知识集单一权威容器：增删查列/指纹/计数）；
- 检索侧排除执行类 kind（path/script 不进上下文注入——知识集检索只注入声明类）；
- 组装器先例层消费技能（skill_provider → 候选链，来源 = CANDIDATE_SOURCE_SKILL）。

纯算法、零 LLM、零网络。
"""
from __future__ import annotations

import pytest

from ink_engine.core.contracts import NodeContract, PathAssemblyConfig
from ink_engine.core.graph import Graph
from ink_engine.core.knowledge_set import (
    KIND_PATH,
    KnowledgeEntry,
    KnowledgeSet,
)
from ink_engine.core.path_assembler import (
    CANDIDATE_SOURCE_SKILL,
    AssemblyRequest,
    PathAssembler,
)
from ink_engine.core.registry import NodeTypeRegistry
from ink_engine.core.schema_validator import FIELD_STRING, SchemaField, SchemaSpec
from ink_engine.core.skill_crystal import (
    KnowledgeSkillStore,
    SkillEntry,
    knowledge_entry_to_skill,
    skill_to_knowledge_entry,
)


def _make_entry(**overrides) -> SkillEntry:
    base = {
        "name": "path.code.abc1234567",
        "version": 1,
        "domain": "default",
        "fingerprint": "fp.abc",
        "kind": "path",
        "path": {"nodes": {}},
        "contract_snapshot": (("a", "1"),),
        "evidence_snapshot": (
            {"src_type": "a", "dst_type": "b", "success_count": 3, "fail_count": 0},
        ),
        "model_id": "m1",
        "hit_count": 10,
        "fail_count": 0,
        "test_report": {"success_rate": 1.0},
        "source_path": "fp.abc",
        "created_at": 1.0,
        "updated_at": 1.0,
    }
    base.update(overrides)
    return SkillEntry(**base)


def _ks() -> KnowledgeSet:
    return KnowledgeSet("u1")


# ── ① 转换 ──


def test_skill_knowledge_roundtrip():
    skill = _make_entry()
    entry = skill_to_knowledge_entry(skill, now=2.0)
    assert entry.kind == KIND_PATH
    assert entry.id == "skill:path.code.abc1234567@v1"
    assert entry.credibility == 1.0  # 成功率背书
    restored = knowledge_entry_to_skill(entry)
    assert restored.name == skill.name
    assert restored.fingerprint == skill.fingerprint
    assert restored.hit_count == 10
    assert restored.created_at == 1.0
    assert restored.updated_at == 2.0


# ── ② KnowledgeSkillStore 适配器 ──


async def test_knowledge_skill_store_upsert_get_list_delete():
    store = KnowledgeSkillStore(_ks())
    await store.upsert(_make_entry())
    got = await store.get("path.code.abc1234567")
    assert got is not None
    assert got.hit_count == 10
    assert await store.count() == 1
    # 版本递增写入（同名新版本共存）
    await store.upsert(_make_entry(version=2))
    assert await store.count() == 2
    latest = await store.get("path.code.abc1234567")
    assert latest.version == 2
    old = await store.get("path.code.abc1234567", version=1)
    assert old.version == 1
    by_fp = await store.get_by_fingerprint("fp.abc")
    assert by_fp.version == 2
    listed = await store.list()
    assert [s.version for s in listed] == [1, 2]
    assert await store.delete("path.code.abc1234567") is True
    assert await store.count() == 0


async def test_knowledge_skill_store_unbound_fails_closed():
    from ink_engine.core.exceptions import StorageError

    store = KnowledgeSkillStore()
    with pytest.raises(StorageError):
        await store.upsert(_make_entry())


# ── ③ 检索侧排除执行类 kind ──


def test_build_knowledge_sources_excludes_path(monkeypatch):
    from ink_engine.core.knowledge_set import build_knowledge_sources

    ks = _ks()
    ks.add(
        KnowledgeEntry(
            id="skill:path.a@v1", level="project", kind=KIND_PATH,
            data={"skill": {"name": "path.a"}}, title="path.a",
        )
    )
    ks.add(
        KnowledgeEntry(
            id="k-rule-1", level="project", kind="rule",
            data={"rule": {"message": "规则一"}}, title="规则一",
        )
    )
    sources = build_knowledge_sources(ks.entries())
    assert [s.title for s in sources] == ["规则一"]


# ── ④ 组装先例层消费技能 ──


def _field(name: str, required: bool = False) -> SchemaField:
    return SchemaField(name=name, required=required, kind=FIELD_STRING)


def _spec(name: str, *fields: SchemaField) -> SchemaSpec:
    return SchemaSpec(name=name, fields=tuple(fields))


def _contract(inputs=(), outputs=()):
    return NodeContract(
        input_schema=_spec("in", *(_field(n, required=True) for n in inputs)),
        output_schema=_spec("out", *(_field(n) for n in outputs)),
        safety_tier=0,
        version=1,
    )


_SKILL_PATH = {
    "name": "skill.prior",
    "entry": "n1",
    "nodes": {
        "n1": {"type": "intent_parse"},
        "n2": {"type": "domain_router"},
        "n3": {"type": "web_search"},
        "n4": {"type": "answer_direct"},
    },
    "edges": {
        "n1": [{"target": "n2"}],
        "n2": [{"target": "n3"}],
        "n3": [{"target": "n4"}],
    },
    "exits": ["n4"],
}


def _skill_registry() -> NodeTypeRegistry:
    registry = NodeTypeRegistry()
    specs = (
        ("intent_parse", (), ("intent", "domains")),
        ("domain_router", ("intent",), ("spec", "query")),
        ("web_search", ("query",), ("search_results",)),
        ("answer_direct", ("search_results",), ("answer",)),
    )
    for type_name, inputs, outputs in specs:
        registry.register(
            type_name,
            lambda config, _t=type_name: _stub_node(config),
            contract=_contract(inputs, outputs),
        )
    return registry


def _stub_node(config=None):
    async def node(ctx):
        return {}

    return node


async def test_assembler_consumes_skill_as_prior():
    registry = _skill_registry()
    skill = _make_entry(name="path.code.skillprior", path=_SKILL_PATH)

    async def provider(request):
        return [skill]

    assembler = PathAssembler(
        registry=registry,
        config=PathAssemblyConfig(enabled=True),
        skill_provider=provider,
    )
    result = await assembler.assemble(
        AssemblyRequest(
            goal_schema=_spec("goal", _field("answer", required=True)),
            entry_fields=("user_query",),
            domain="code",
            max_safety_tier=0,
            top_k=2,
        )
    )
    assert result.candidates
    # 技能先例链进入候选，来源标记 = skill
    assert any(c.source == CANDIDATE_SOURCE_SKILL for c in result.candidates)


async def test_assembler_skips_invalid_skill_path():
    registry = _skill_registry()
    bad = _make_entry(name="path.code.bad", path={"nodes": {}})

    async def provider(request):
        return [bad]

    assembler = PathAssembler(
        registry=registry,
        config=PathAssemblyConfig(enabled=True),
        skill_provider=provider,
    )
    # 退化技能重建失败被跳过，不产出残缺候选（算法层仍可出候选）
    result = await assembler.assemble(
        AssemblyRequest(
            goal_schema=_spec("goal", _field("answer", required=True)),
            entry_fields=("user_query",),
            domain="code",
            max_safety_tier=0,
            top_k=2,
        )
    )
    assert not any(c.source == CANDIDATE_SOURCE_SKILL for c in result.candidates)


def test_skill_path_rebuilds_via_graph_from_dict():
    # 技能路径经 Graph.from_dict(validate=True) 可重建（组装先例重建的前提）
    graph = Graph.from_dict(dict(_SKILL_PATH), registry=_skill_registry(), validate=True)
    assert graph.entry == "n1"
