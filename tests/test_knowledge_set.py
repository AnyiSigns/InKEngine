"""知识集封装层单测：种子注入/补丁链演化/精准修正/晋升/可移植/检索/注入。

语义检查点：
- 知识条目 = 补丁链数据（演化 append-only，回退可取旧版本）；
- 种子注入幂等（重复初始化不覆盖演化）；
- 精准修正（update 只改对应字段，不重写整条）；
- 晋升 = namespace 迁移（工作→项目→用户，不跳级，id 跨层级稳定）；
- 导出/导入 round-trip（可移植 = 内容永远可带走）；
- 复用检索命中排序（可信度优先）；
- 知识条目 → ContextSource 适配（type=层级、weight=可信度）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.context import ContextSource
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.knowledge_set import (
    KIND_RULE,
    LEVEL_PROJECT,
    LEVEL_USER,
    LEVEL_WORK,
    KnowledgeEntry,
    KnowledgeSet,
    build_knowledge_sources,
    seed_knowledge_set,
)


def _entry(entry_id: str = "k-1", level: str = LEVEL_WORK, **kw) -> KnowledgeEntry:
    defaults = {
        "kind": KIND_RULE,
        "data": {"rule": {"message": f"规则 {entry_id}"}},
        "source": "model",
        "credibility": 0.7,
        "title": f"条目 {entry_id}",
        "tags": ("测试",),
    }
    defaults.update(kw)
    return KnowledgeEntry(id=entry_id, level=level, **defaults)


def test_add_and_get_entry():
    """新增条目落链，get 可取回（补丁链组装）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry())
    entry = ks.get("k-1")
    assert entry is not None
    assert entry.id == "k-1"
    assert entry.level == LEVEL_WORK
    assert entry.credibility == 0.7


def test_duplicate_add_rejected():
    """同 id 重复添加拒绝（防静默覆盖既有知识）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry())
    with pytest.raises(GraphDefinitionError, match="已存在"):
        ks.add(_entry())


def test_update_precise_patch_keeps_rest():
    """精准修正：只改对应字段，其余字段保持（不重写整条知识）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry())
    updated = ks.update("k-1", data={"rule": {"message": "新规则"}})
    assert updated.data["rule"]["message"] == "新规则"
    assert updated.credibility == 0.7  # 未变更字段保持
    assert updated.title == "条目 k-1"


def test_update_identity_fields_rejected():
    """身份字段（id/created_at）不可修正。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry())
    with pytest.raises(GraphDefinitionError, match="身份字段"):
        ks.update("k-1", id="k-other")


def test_remove_entry_idempotent():
    """删除幂等（不存在返回 False）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry())
    assert ks.remove("k-1") is True
    assert ks.remove("k-1") is False
    assert ks.get("k-1") is None


def test_chain_is_append_only_reversible():
    """演化 = 补丁链（append-only）：修正/删除后链历史仍在，可回退。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry())
    ks.update("k-1", data={"rule": {"message": "修正版"}})
    chain_data = ks.export()
    assert len(chain_data["patches"]) == 2  # 新增 + 修正各一补丁
    # 回退 = 组装前段补丁：仅新增补丁时 = 原始版本
    snapshot = __import__("ink_engine.core.patch_chain", fromlist=["PatchChain"]).PatchChain.from_dict(
        {"base": chain_data["base"], "patches": chain_data["patches"][:1]}
    )
    raw = snapshot.assemble()["entries"]["k-1"]
    assert raw["data"]["rule"]["message"] == "规则 k-1"


def test_record_usage_tracks_failures():
    """调用留痕：usage/fail 计数累积（进化与调参依据）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry())
    ks.record_usage("k-1")
    ks.record_usage("k-1", failed=True)
    entry = ks.get("k-1")
    assert entry.usage_count == 2
    assert entry.fail_count == 1


def test_seed_idempotent():
    """种子注入幂等：重复注入不覆盖演化。"""
    ks = KnowledgeSet("u1")
    assert seed_knowledge_set(ks, [_entry()]) == 1
    ks.update("k-1", data={"rule": {"message": "使用中修正"}})
    assert seed_knowledge_set(ks, [_entry()]) == 0  # 已存在，跳过
    assert ks.get("k-1").data["rule"]["message"] == "使用中修正"


def test_promote_chain_work_to_user():
    """晋升链路：工作 → 项目 → 用户（不跳级，id 稳定）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry())
    promoted = ks.promote("k-1")  # work → project
    assert promoted.level == LEVEL_PROJECT
    promoted = ks.promote("k-1")  # project → user
    assert promoted.level == LEVEL_USER
    assert ks.get("k-1").id == "k-1"  # 身份跨层级稳定
    with pytest.raises(GraphDefinitionError, match="最高层级"):
        ks.promote("k-1")


def test_promote_skip_level_rejected():
    """跳级晋升拒绝（先沉淀后压缩，顺序固定）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry())
    with pytest.raises(GraphDefinitionError, match="逐级向上"):
        ks.promote("k-1", to_level=LEVEL_USER)


def test_export_import_roundtrip(memory_storage):
    """导出/导入 round-trip：补丁链无损还原（可移植 = 内容可带走）。"""
    ks = KnowledgeSet("u1", storage=memory_storage)
    ks.add(_entry("k-1"))
    ks.add(_entry("k-2", level=LEVEL_PROJECT))
    ks.update("k-1", data={"rule": {"message": "修正"}})
    exported = ks.export()

    rebuilt = KnowledgeSet.from_export("u2", exported)
    assert rebuilt.entries() == ks.entries()
    rebuilt_entry = rebuilt.get("k-1")
    assert rebuilt_entry.data["rule"]["message"] == "修正"
    assert rebuilt_entry.credibility == 0.7
    # 链条数一致（演化历史完整迁移）
    assert len(rebuilt.export()["patches"]) == 3


def test_export_invalid_rejected():
    """非法导出数据显式拒绝（不静默建空集）。"""
    with pytest.raises(GraphDefinitionError, match="导出数据非法"):
        KnowledgeSet.from_export("u1", {"nonsense": True})


async def test_save_load_persist(memory_storage):
    """落库/读回：存储三后端共用 knowledge:<user> 集合。"""
    ks = KnowledgeSet("u1", storage=memory_storage)
    ks.add(_entry())
    await ks.save()

    loaded = await KnowledgeSet.load("u1", storage=memory_storage)
    assert loaded.get("k-1") is not None
    assert loaded.user_id == "u1"


async def test_load_empty_set(memory_storage):
    """无记录 = 空集（种子注入由使用方初始化时执行）。"""
    loaded = await KnowledgeSet.load("nobody", storage=memory_storage)
    assert loaded.entries() == []


def test_search_hits_by_tags_and_title():
    """复用检索：标题/标签/数据文本命中 + 可信度排序。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry("k-1", credibility=0.5, tags=("伏笔",)))
    ks.add(
        _entry(
            "k-2",
            credibility=0.9,
            tags=("角色",),
            data={"rule": {"message": "角色一致性"}},
        )
    )
    hits = ks.search("角色")
    assert [h.id for h in hits] == ["k-2"]
    # 多关键词 = 全部命中（AND 语义）
    assert ks.search("角色 一致性")[0].id == "k-2"
    assert ks.search("不存在词") == []


# ── 归档/淘汰（生命周期 = 归档不删除，可恢复）──


def test_archive_moves_out_of_active_index():
    """归档 = 移出活跃索引（entries/search 不再命中），不删除。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry("k-1", tags=("x",)))
    ks.add(_entry("k-2", tags=("x",)))
    archived = ks.archive("k-1")
    assert archived.archived is True
    assert [e.id for e in ks.entries()] == ["k-2"]  # 活跃索引不含 k-1
    assert [e.id for e in ks.archived_entries()] == ["k-1"]
    assert ks.search("x")[0].id == "k-2"  # 检索不命中归档条目
    assert ks.get("k-1") is not None  # 数据与演化历史完整保留


def test_unarchive_restores_entry():
    """恢复归档条目：重新进入活跃索引，内容原样保留。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry("k-1", tags=("x",)))
    ks.archive("k-1")
    restored = ks.unarchive("k-1")
    assert restored.archived is False
    assert ks.get("k-1").data == {"rule": {"message": "规则 k-1"}}
    assert ks.search("x")[0].id == "k-1"


def test_archive_idempotent_and_missing_rejected():
    """归档幂等；不存在的条目归档/恢复显式拒绝。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry("k-1"))
    ks.archive("k-1")
    assert ks.archive("k-1").archived is True  # 重复归档幂等
    with pytest.raises(GraphDefinitionError, match="不存在"):
        ks.archive("ghost")
    with pytest.raises(GraphDefinitionError, match="不存在"):
        ks.unarchive("ghost")


def test_archive_roundtrip_through_export():
    """归档标记随补丁链导出/导入（可移植性覆盖归档状态）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry("k-1"))
    ks.archive("k-1")
    rebuilt = KnowledgeSet.from_export("u2", ks.export())
    assert rebuilt.archived_entries()[0].id == "k-1"
    assert rebuilt.entries() == []


def test_archive_keeps_evolution_history():
    """归档是状态迁移非删除：链历史完整（回退仍可取旧版本）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry("k-1"))
    ks.archive("k-1")
    chain_data = ks.export()
    assert len(chain_data["patches"]) == 2  # 新增 + 归档各一补丁
    snapshot = __import__(
        "ink_engine.core.patch_chain", fromlist=["PatchChain"]
    ).PatchChain.from_dict(
        {"base": chain_data["base"], "patches": chain_data["patches"][:1]}
    )
    raw = snapshot.assemble()["entries"]["k-1"]
    assert raw.get("archived", False) is False  # 回退到归档前 = 活跃状态


def test_archived_entry_excluded_from_search_by_default():
    """检索默认只扫活跃索引；include_archived 可显式检索归档条目。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry("k-1", tags=("伏笔",)))
    ks.archive("k-1")
    assert ks.search("伏笔") == []
    assert ks.search("伏笔", include_archived=True)[0].id == "k-1"


def test_search_level_and_kind_filters():
    """检索按层级/类别过滤。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry("k-1", level=LEVEL_WORK, tags=("x",)))
    ks.add(_entry("k-2", level=LEVEL_USER, tags=("x",)))
    hits = ks.search("x", level=LEVEL_USER)
    assert [h.id for h in hits] == ["k-2"]


def test_entry_as_context_source():
    """知识条目 → ContextSource 适配（type=层级、weight=可信度）。"""
    entry = _entry(credibility=0.8, tags=("t",))
    source = entry.as_context_source(relevance=0.6)
    assert isinstance(source, ContextSource)
    assert source.type == LEVEL_WORK
    assert source.weight == 0.8
    assert source.relevance == 0.6
    assert source.dedup_key == "knowledge:k-1"
    assert source.meta["entry_id"] == "k-1"
    assert source.meta["source"] == "model"


def test_build_knowledge_sources_sorted():
    """注入组装：按可信度降序（高可信优先进入预算分配）。"""
    ks = KnowledgeSet("u1")
    ks.add(_entry("k-1", credibility=0.4, tags=("t",)))
    ks.add(_entry("k-2", credibility=0.9, tags=("t",)))
    sources = build_knowledge_sources(ks.search("t"), relevance=0.5)
    assert [s.meta["entry_id"] for s in sources] == ["k-2", "k-1"]
    assert all(s.relevance == 0.5 for s in sources)


def test_invalid_credibility_rejected():
    """可信度越界拒绝（构造期暴露）。"""
    with pytest.raises(GraphDefinitionError, match="可信度"):
        _entry(credibility=1.5)


def test_invalid_level_rejected():
    """未知层级拒绝。"""
    with pytest.raises(GraphDefinitionError, match="层级非法"):
        _entry(level="archive")
