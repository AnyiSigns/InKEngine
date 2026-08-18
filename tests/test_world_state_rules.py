"""世界状态规则集迁移测试：声明式规则集回归 + 样例库闸门 + 补丁链数据。

校验语义已规则化（世界状态写时校验的唯一入口 = check_world_state_rules），
原代码校验器的测试场景在此收敛为：入口级回归断言（同场景产出同类别/
同严重度/同实体锚点）+ 样例库闸门（fixture 全绿非谈判项）+ 规则集 =
补丁链数据（版本演进可回退）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import FixtureGateError
from ink_engine.core.patch_chain import Patch, PatchChain, PatchOp
from ink_engine.core.rules import (
    SEVERITY_ERROR,
    Rule,
    RuleEngine,
    RuleSet,
    assert_fixtures_pass,
    fixtures_all_green,
    run_fixtures,
)
from ink_engine.novel_harness.narrative_state import (
    STATUS_RESOLVED,
    STATUS_SET,
)
from ink_engine.novel_harness.world_state import (
    CausalEvent,
    CausalLink,
    CharacterFingerprint,
    CharacterState,
    ForeshadowingNode,
    KnowledgeEntry,
    WorldState,
    build_world_state_fixtures,
    build_world_state_registry,
    build_world_state_rule_set,
    check_world_state_rules,
)
from ink_engine.novel_harness.world_state.issues import (
    ISSUE_CAUSAL,
    ISSUE_FINGERPRINT,
    ISSUE_FORESHADOWING,
    ISSUE_KNOWLEDGE_GAP,
)


def _char(**kw) -> CharacterState:
    base = {
        "character_id": "c1",
        "name": "林晚",
        "location": "藏剑阁",
        "health": "完好",
    }
    base.update(kw)
    return CharacterState(**base)


def _world() -> WorldState:
    world = WorldState()
    world.set_character(_char())
    world.add_knowledge(
        KnowledgeEntry(character_id="c1", fact_id="f1", known_at_chapter=3)
    )
    world.add_event(CausalEvent(event_id="e1", chapter_id=3, summary="主角发现信物"))
    world.add_event(CausalEvent(event_id="e2", chapter_id=23, summary="真相大白"))
    world.link_causality("e1", "e2", note="信物引出真相")
    return world


def _engine() -> RuleEngine:
    return RuleEngine(build_world_state_registry())


def _issue_kinds(issues) -> set[str]:
    return {issue.kind for issue in issues}


async def _rules_check(world: WorldState, **kw):
    return await check_world_state_rules(
        world, rule_set=build_world_state_rule_set(), registry=build_world_state_registry(), **kw
    )


# -- 入口级回归（写时校验语义：类别/严重度/实体锚点/消息关键短语） --------------


async def test_knowledge_gap_leak_detected():
    """信息差：角色泄漏未知事实 → knowledge_gap error，锚点 = 角色。"""
    world = _world()
    result = await _rules_check(
        world, character_id="c1", fact_ids=["f1", "f_secret"], at_chapter=5
    )
    assert len(result.issues) == 1  # f1 已知，f_secret 泄漏
    assert _issue_kinds(result.issues) == {ISSUE_KNOWLEDGE_GAP}
    assert result.issues[0].severity == SEVERITY_ERROR
    assert "f_secret" in result.issues[0].message
    assert result.issues[0].entity_id == "c1"
    # 无目标角色/事实 = 无检查项
    empty = await _rules_check(world)
    assert empty.issues == ()


async def test_causal_dangling_detected():
    """因果悬空：引用不存在的事件 → causal_chain error。"""
    world = _world()
    world.causal_links.append(CausalLink("e1", "ghost"))
    result = await _rules_check(world)
    assert _issue_kinds(result.issues) == {ISSUE_CAUSAL}
    assert any("不存在的事件" in i.message for i in result.issues)
    assert all(i.severity == SEVERITY_ERROR for i in result.issues)


async def test_causal_reverse_order_detected():
    """后果早于原因：逻辑倒置 → causal_chain error，锚点 = effect 事件。"""
    world = _world()
    world.causal_links.append(CausalLink("e2", "e1"))  # 第 23 章 → 第 3 章
    result = await _rules_check(world)
    assert _issue_kinds(result.issues) == {ISSUE_CAUSAL}
    assert any("后果早于原因" in i.message for i in result.issues)
    assert result.issues[0].entity_id == "e1"


async def test_causal_duplicate_pair_detected():
    """因果重复登记：warning 级 causal_chain，锚点 = effect 事件。"""
    world = _world()
    world.causal_links.append(CausalLink("e1", "e2"))
    result = await _rules_check(world)
    assert _issue_kinds(result.issues) == {ISSUE_CAUSAL}
    duplicate = next(i for i in result.issues if i.severity == "warning")
    assert duplicate.entity_id == "e2"


async def test_causal_empty_event_id_detected():
    """空事件 id 与不存在事件同判（对空 id 同样产出悬空引用）。"""
    world = _world()
    world.causal_links.append(CausalLink("", "e1"))
    result = await _rules_check(world)
    assert _issue_kinds(result.issues) == {ISSUE_CAUSAL}
    assert any("不存在的事件" in i.message for i in result.issues)


async def test_foreshadowing_unplanted_detected():
    """未埋设即回收：foreshadowing_chain error。"""
    world = WorldState()
    world.upsert_foreshadowing(
        ForeshadowingNode(
            foreshadowing_id="a", status=STATUS_RESOLVED, resolved_at_chapter=10
        )
    )
    result = await _rules_check(world)
    assert _issue_kinds(result.issues) == {ISSUE_FORESHADOWING}
    assert any("未埋设即回收" in i.message for i in result.issues)
    assert all(i.severity == SEVERITY_ERROR for i in result.issues)


async def test_foreshadowing_reverse_plant_detected():
    """回收早于埋设：foreshadowing_chain error。"""
    world = WorldState()
    world.upsert_foreshadowing(
        ForeshadowingNode(
            foreshadowing_id="a",
            status=STATUS_RESOLVED,
            planted_at_chapter=5,
            resolved_at_chapter=3,
        )
    )
    result = await _rules_check(world)
    assert _issue_kinds(result.issues) == {ISSUE_FORESHADOWING}
    assert any("早于埋设" in i.message for i in result.issues)


async def test_foreshadowing_reference_unplanted_detected():
    """依赖伏笔未埋设：foreshadowing_chain error。"""
    world = WorldState()
    world.upsert_foreshadowing(
        ForeshadowingNode(
            foreshadowing_id="a",
            status=STATUS_RESOLVED,
            planted_at_chapter=2,
            resolved_at_chapter=8,
            references=("b",),
        )
    )
    world.upsert_foreshadowing(ForeshadowingNode(foreshadowing_id="b", status=STATUS_SET))
    result = await _rules_check(world)
    assert _issue_kinds(result.issues) == {ISSUE_FORESHADOWING}
    assert any("尚未埋设" in i.message for i in result.issues)


async def test_foreshadowing_reference_missing_detected():
    """互引悬空：foreshadowing_chain error。"""
    world = WorldState()
    world.upsert_foreshadowing(
        ForeshadowingNode(
            foreshadowing_id="a", status=STATUS_SET, planted_at_chapter=2, references=("ghost",)
        )
    )
    result = await _rules_check(world)
    assert _issue_kinds(result.issues) == {ISSUE_FORESHADOWING}
    assert any("互引了不存在的伏笔" in i.message for i in result.issues)


async def test_reference_checks_skip_invalid_status_nodes():
    """非法状态节点不检查引用（仅状态违规一条，不叠加误报）。"""
    world = WorldState()
    world.upsert_foreshadowing(
        ForeshadowingNode(
            foreshadowing_id="a", status="bogus", planted_at_chapter=2, references=("ghost",)
        )
    )
    result = await _rules_check(world)
    assert len(result.issues) == 1
    assert _issue_kinds(result.issues) == {ISSUE_FORESHADOWING}
    assert "不在合法集内" in result.issues[0].message


async def test_resolved_without_resolve_chapter_skips_ref_check():
    """已回收但无回收章的节点不检查依赖埋设（无「回收前」基准）。"""
    world = WorldState()
    world.upsert_foreshadowing(
        ForeshadowingNode(
            foreshadowing_id="a",
            status=STATUS_RESOLVED,
            planted_at_chapter=2,
            references=("b",),
        )
    )
    world.upsert_foreshadowing(ForeshadowingNode(foreshadowing_id="b", status=STATUS_SET))
    result = await _rules_check(world)
    assert result.issues == ()


async def test_foreshadowing_invalid_status_detected():
    """非法状态：foreshadowing_chain error。"""
    world = WorldState()
    world.upsert_foreshadowing(ForeshadowingNode(foreshadowing_id="a", status="bogus"))
    result = await _rules_check(world)
    assert _issue_kinds(result.issues) == {ISSUE_FORESHADOWING}
    assert any(i.severity == SEVERITY_ERROR for i in result.issues)


async def test_fingerprint_taboo_detected():
    """指纹禁忌：正文命中禁忌词 → fingerprint warning。"""
    world = _world()
    world.set_character(
        _char(fingerprint=CharacterFingerprint(taboos=("不可饶恕",)))
    )
    result = await _rules_check(world, text="他说出「不可饶恕」四个字", character_id="c1")
    assert _issue_kinds(result.issues) == {ISSUE_FINGERPRINT}
    assert all(i.severity == "warning" for i in result.issues)
    assert "正文出现禁忌表述" in result.issues[0].message
    # 无正文 = 无检查项
    empty = await _rules_check(world, character_id="c1")
    assert empty.issues == ()


async def test_composed_leaks_detected():
    """组合泄漏场景：信息差 + 因果倒置 + 指纹禁忌同现（原组合预检场景）。"""
    world = _world()
    world.set_character(
        _char(fingerprint=CharacterFingerprint(taboos=("不可饶恕",)))
    )
    world.causal_links.append(CausalLink("e2", "e1"))
    result = await _rules_check(
        world,
        text="他说出「不可饶恕」",
        character_id="c1",
        fact_ids=["f_secret"],
        at_chapter=5,
    )
    kinds = _issue_kinds(result.issues)
    assert {ISSUE_KNOWLEDGE_GAP, ISSUE_CAUSAL, ISSUE_FINGERPRINT} <= kinds


async def test_clean_world_zero_violations():
    """全绿世界：全部适用检查零违规。"""
    world = _world()
    world.upsert_foreshadowing(
        ForeshadowingNode(
            foreshadowing_id="a",
            status=STATUS_RESOLVED,
            planted_at_chapter=2,
            resolved_at_chapter=8,
        )
    )
    result = await _rules_check(
        world, text="正文无误", character_id="c1", fact_ids=["f1"], at_chapter=5
    )
    assert result.issues == ()


async def test_llm_hook_merges_into_rules():
    """混合判定：规则结果 + LLM 钩子深度判定并集（失败 fail-open）。"""
    async def hook(data, context, issues):
        return [{"message": "言行偏离严重", "kind": "fingerprint", "severity": "error"}]

    world = _world()
    world.set_character(_char(fingerprint=CharacterFingerprint(taboos=("不可饶恕",))))
    result = await check_world_state_rules(
        world,
        text="他说出「不可饶恕」",
        character_id="c1",
        rule_set=build_world_state_rule_set(),
        registry=build_world_state_registry(),
        llm_hook=hook,
    )
    assert any(i.message == "言行偏离严重" for i in result.issues)

    async def bad_hook(data, context, issues):
        raise RuntimeError("钩子故障")

    failed = await check_world_state_rules(
        world,
        text="他说出「不可饶恕」",
        character_id="c1",
        rule_set=build_world_state_rule_set(),
        registry=build_world_state_registry(),
        llm_hook=bad_hook,
    )
    assert ("__llm_hook__", "钩子异常: 钩子故障") in failed.skipped
    assert any(i.kind == ISSUE_FINGERPRINT for i in failed.issues)  # 确定性结果不受影响


# -- 样例闸门（迁移验收：样例库全绿 + 回归拦截） --------------------------------


def test_fixture_suite_all_green():
    """迁移验收：世界状态规则集对样例库全绿（回归基线）。"""
    rule_set = build_world_state_rule_set()
    fixtures = build_world_state_fixtures()
    results = run_fixtures(rule_set, fixtures, engine=_engine())
    failures = [r.case_id for r in results if not r.passed]
    assert failures == [], "样例失败: " + "; ".join(f"{r.case_id}: {r.reason}" for r in results if not r.passed)
    assert fixtures_all_green(rule_set, fixtures, engine=_engine()) is True
    assert_fixtures_pass(rule_set, fixtures, engine=_engine())


def test_fixture_gate_blocks_rule_regression():
    """闸门拦截回归：削弱后果不早于原因规则立即被样例库拒绝（非谈判项）。"""
    rule_set = build_world_state_rule_set()
    weakened = RuleSet(
        name=rule_set.name,
        rules=tuple(
            rule
            for rule in rule_set.rules
            if rule.id != "causal.effect_not_before_cause"
        ),
    )
    with pytest.raises(FixtureGateError, match="causal_effect_before_cause"):
        assert_fixtures_pass(weakened, build_world_state_fixtures(), engine=_engine())


def test_rule_set_is_patch_chain_data():
    """规则集 = 补丁链数据：版本演进 append 替换补丁，回退组装旧版本。"""
    rule_set = build_world_state_rule_set()
    chain = PatchChain(base={"ruleset": rule_set.to_dict()})
    v1 = chain.assemble()
    # 新版本：收紧一条规则（追加替换补丁）
    evolved = RuleSet(
        name=rule_set.name,
        rules=tuple(
            Rule(
                id=rule.id,
                predicate=rule.predicate,
                config={**rule.config, "message": "收紧后的消息"} if rule.id == "causal.link_exists.cause" else rule.config,
                type=rule.type,
                target_path=rule.target_path,
                severity=rule.severity,
                kind=rule.kind,
                entity_type=rule.entity_type,
                description=rule.description,
            )
            if rule.id == "causal.link_exists.cause"
            else rule
            for rule in rule_set.rules
        ),
    )
    chain.apply(
        Patch(
            op=PatchOp.REPLACE,
            path=("ruleset",),
            value=evolved.to_dict(),
        )
    )
    v2 = chain.assemble()
    assert v2["ruleset"]["rules"][0]["config"].get("message") == "收紧后的消息"
    # 回退 = 组装到 base（版本 1），旧定义完整还原
    rolled_back = RuleSet.from_dict(v1["ruleset"])
    assert rolled_back.rules[0].config.get("message") is None
    assert rolled_back.name == rule_set.name
