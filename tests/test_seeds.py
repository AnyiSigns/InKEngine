"""内置种子知识集封装单测：通用种子/领域种子/幂等注入/完整性自检。

语义检查点：
- 通用种子 = 最小可用空壳（默认编排模板 + 默认权重阈值），不含领域成品；
- novel 领域种子（seeds/novel/ 发布物）= 领域规则集封装为规则条目清单
  （data.rule 可加载），导入即自注册（插拔形态）；
- 注入幂等（重复初始化不覆盖使用中演化——种子只读基线语义）；
- 领域种子配套发布（谓词注册表 + 样例库）随种子一起接线；
- 出厂完整性自检：规则条目可加载 + 样例全绿（回归防线）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.knowledge_set import (
    KIND_RULE,
    KIND_TEMPLATE,
    KIND_WEIGHT,
    KnowledgeSet,
)
from ink_engine.core.rules import RuleSet
from ink_engine.seeds import (
    GENERAL_TEMPLATE_SEED_ID,
    GENERAL_WEIGHTS_SEED_ID,
    build_general_seed_entries,
    seed_domains,
    seed_general,
    seed_user_set,
)
from ink_engine.seeds.novel import (
    build_novel_seed_entries,
    check_novel_seed_integrity,
    novel_default_template,
    novel_schema_base,
    novel_seed_fixtures,
    novel_seed_registry,
    seed_novel,
)

# ── 通用种子 ──


def test_general_seed_is_minimal_shell():
    """通用种子 = 最小可用空壳：模板 + 权重阈值，不含领域成品。"""
    entries = build_general_seed_entries()
    by_id = {e.id: e for e in entries}
    assert set(by_id) == {GENERAL_TEMPLATE_SEED_ID, GENERAL_WEIGHTS_SEED_ID}
    assert by_id[GENERAL_TEMPLATE_SEED_ID].kind == KIND_TEMPLATE
    assert by_id[GENERAL_TEMPLATE_SEED_ID].data["template"]["plan"]["steps"]
    assert by_id[GENERAL_WEIGHTS_SEED_ID].kind == KIND_WEIGHT
    assert by_id[GENERAL_WEIGHTS_SEED_ID].data["weights"]
    assert by_id[GENERAL_WEIGHTS_SEED_ID].data["thresholds"]
    assert all(e.id.startswith("seed.general.") for e in entries)


def test_seed_general_injects_and_idempotent():
    """通用种子注入幂等（种子只读基线：重复初始化不覆盖演化）。"""
    ks = KnowledgeSet("u1")
    assert seed_general(ks) == 2
    # 使用中演化种子条目（模拟用户打磨模板）
    ks.update(GENERAL_TEMPLATE_SEED_ID, data={"template": {"name": "打磨后"}})
    assert seed_general(ks) == 0  # 幂等：已存在跳过
    assert ks.get(GENERAL_TEMPLATE_SEED_ID).data["template"]["name"] == "打磨后"


def test_general_seed_serialization_roundtrip():
    """通用种子条目可序列化（补丁链落库/导出的数据契约）。"""
    for entry in build_general_seed_entries():
        rebuilt = type(entry).from_dict(entry.to_dict())
        assert rebuilt == entry


# ── novel 领域种子 ──


def test_novel_seed_wraps_world_state_rules():
    """领域种子 = 世界状态规则集封装为规则条目（kind=rule，可加载）。"""
    entries = build_novel_seed_entries()
    assert len(entries) == 10  # 规则集 10 条声明式规则
    assert all(e.kind == KIND_RULE for e in entries)
    assert all(e.id.startswith("seed.novel.") for e in entries)
    # 每条规则声明可被规则 DSL 解析器加载（核不用写：校验语义 = 规则数据）
    registry = novel_seed_registry()
    for entry in entries:
        rule_set = RuleSet.parse(
            {"name": f"seed-{entry.id}", "rules": [entry.data["rule"]]},
            registry=registry,
        )
        assert rule_set.rules[0].id  # 谓词已注册 + 声明形态合法


def test_seed_novel_injects_and_idempotent():
    """领域种子注入幂等（按需注入用户集，重复初始化不覆盖）。"""
    ks = KnowledgeSet("u1")
    assert seed_novel(ks) == 10
    assert seed_novel(ks) == 0
    assert len(ks.entries()) == 10


def test_seed_user_set_combines_general_and_domain():
    """用户集初始化：通用种子恒注入 + 领域种子按需注入。"""
    ks = KnowledgeSet("u1")
    injected = seed_user_set(ks, domain="novel")
    assert injected == 12  # 2 通用 + 10 领域
    assert seed_user_set(ks, domain="novel") == 0  # 幂等

    bare = KnowledgeSet("u2")
    assert seed_user_set(bare) == 2  # 不指定领域 = 只注通用种子


def test_seed_user_set_unknown_domain_rejected():
    """未知领域种子显式拒绝（防拼写错误静默建空集）。"""
    ks = KnowledgeSet("u1")
    with pytest.raises(Exception, match="未知领域种子"):
        seed_user_set(ks, domain="code")


def test_seed_provider_registration_mechanism():
    """领域种子注册机制：导入即自注册；重复注册显式拒绝。"""
    from ink_engine.core.seeds import register_seed_provider

    assert "novel" in seed_domains()  # seeds.novel 导入时已自注册
    with pytest.raises(Exception, match="重复注册"):
        register_seed_provider("novel", build_novel_seed_entries)


def test_novel_seed_companions_wired():
    """领域种子配套发布：谓词注册表 + 样例库随种子接线。"""
    registry = novel_seed_registry()
    assert registry.has("causal_event_exists")
    assert registry.has("knowledge_gap")
    fixtures = novel_seed_fixtures()
    assert fixtures.name == "novel.world_state.fixtures"
    assert len(fixtures.cases) >= 10


def test_novel_seed_integrity_all_green():
    """出厂完整性自检：规则条目可加载 + 样例全绿（回归防线）。"""
    rule_count, fixture_count = check_novel_seed_integrity()
    assert rule_count == 10
    assert fixture_count == len(novel_seed_fixtures().cases)


# ── schema 基座与默认编排模板（纯数据资产）──


def test_novel_schema_base_declared():
    """schema 基座：知识条目 + 世界观视图两个口径（可序列化）。"""
    entry_schema, view_schema = novel_schema_base()
    assert entry_schema.name == "novel.knowledge_entry"
    fields = {f.name: f for f in entry_schema.fields}
    assert fields["id"].required is True
    assert fields["credibility"].min == 0.0 and fields["credibility"].max == 1.0
    assert view_schema.name == "novel.world_view"
    assert any(f.name == "causal_links" for f in view_schema.fields)
    rebuilt = type(entry_schema).from_dict(entry_schema.to_dict())
    assert rebuilt == entry_schema


def test_novel_schema_base_validates_view():
    """世界观视图口径可实际校验（字段类型约束生效，缺字段不误报）。"""
    from ink_engine.core.schema_validator import SchemaValidator

    entry_schema, view_schema = novel_schema_base()
    validator = SchemaValidator()
    # 视图对象：只按视图口径校验（缺知识条目必填字段不误报）
    assert validator.validate(view_schema, {"causal_links": []}) == []
    assert any(
        "causal_links" in e
        for e in validator.validate(view_schema, {"causal_links": "坏"})
    )
    # 知识条目口径：必填字段缺失即违规（L1 准入语义）
    assert any("id" in e for e in validator.validate(entry_schema, {}))


def test_novel_default_template_data():
    """默认编排模板 = 图定义数据（提取→校验→生成→评审→收敛 依赖序）。"""
    template = novel_default_template()
    assert template["name"] == "novel_default"
    steps = template["plan"]["steps"]
    assert [step["nodes"][0] for step in steps] == [
        "extract", "validate", "generate", "review", "converge",
    ]


def test_seeded_set_export_import_keeps_seeds():
    """种子注入后的用户集导出/导入：种子条目随补丁链完整迁移。"""
    ks = KnowledgeSet("u1")
    seed_user_set(ks, domain="novel")
    rebuilt = KnowledgeSet.from_export("u2", ks.export())
    assert len(rebuilt.entries()) == 12
    assert rebuilt.get(GENERAL_TEMPLATE_SEED_ID) is not None
    assert rebuilt.get("seed.novel.knowledge.gap") is not None


async def test_seed_entries_usable_by_l2_executor():
    """种子规则条目经 L2 默认执行器可加载执行（规则引擎契约不破坏）。

    单条规则 vs 全量样例不要求全绿（单规则只覆盖一个校验维度）；本用例
    断言「可加载执行」契约：执行器返回结构化评估结果而非抛错/静默跳过。
    """
    from ink_engine.core.knowledge_gate import GateL2FixtureExecutor, GateL2Result

    executor = GateL2FixtureExecutor(registry=novel_seed_registry())
    fixtures = novel_seed_fixtures()
    for entry in build_novel_seed_entries():
        result = await executor.run(entry, fixtures)
        assert isinstance(result, GateL2Result)
        assert isinstance(result.accuracy, float)  # 评估指标结构化留痕


async def test_l2_context_rules_merge_full_set_green():
    """L2 合并评估：样例面向整套规则集设计——单条新规则须与旧集合并
    共同判定（单条恒失败 → 与旧集合并后全绿）。"""
    from ink_engine.core.knowledge_gate import GateL2FixtureExecutor

    entries = build_novel_seed_entries()
    rule_entries = [e for e in entries if e.kind == KIND_RULE and e.data.get("rule")]
    assert len(rule_entries) >= 2
    candidate = rule_entries[0]
    context = {
        "name": "novel.world_state.context",
        "rules": [e.data["rule"] for e in rule_entries[1:]],
    }
    fixtures = novel_seed_fixtures()
    executor = GateL2FixtureExecutor(registry=novel_seed_registry())

    alone = await executor.run(candidate, fixtures)
    assert not alone.passed  # 单条无法独立满足整套样例语义

    merged = await executor.run(candidate, fixtures, context_rules=context)
    assert merged.passed  # 与旧集合并 = 全套规则 → 样例全绿
    assert merged.accuracy == 1.0
