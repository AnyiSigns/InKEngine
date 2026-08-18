"""声明式规则引擎单测：DSL 数据形态/内置谓词/执行引擎/混合判定/样例闸门。

语义检查点：规则 = 数据（谓词名 + 参数，可序列化/校验）；内置通用谓词
（字段存在/比较/枚举/包含/唯一性/状态转换）确定性执行；谓词异常
fail-open 跳过留痕；未知谓词 = 声明错误建图期拒绝；约束检查器 = 确定性
规则 + LLM 钩子（钩子异常 fail-open）；样例闸门 = 新规则必须全绿。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import FixtureGateError, GraphDefinitionError
from ink_engine.core.rules import (
    RULE_CONSTRAINT,
    RULE_TRANSITION,
    SEVERITY_ERROR,
    SEVERITY_WARNING,
    ConstraintChecker,
    FixtureCase,
    FixtureSet,
    Rule,
    RuleEngine,
    RuleSet,
    RuleTypeRegistry,
    RuleViolation,
    assert_fixtures_pass,
    fixtures_all_green,
    run_fixtures,
)


def _order_rule() -> Rule:
    """示例规则：订单状态机 + 金额校验（内置谓词的演示组合）。"""
    return Rule(
        id="order.state_transition",
        predicate="state_transition",
        config={
            "states": ["draft", "paid", "shipped", "done"],
            "terminal_states": ["done"],
            "from_path": "from_state",
            "to_path": "to_state",
            "name": "order",
        },
        type=RULE_TRANSITION,
        kind="order_flow",
        description="订单状态转换必须合法（终态单向）",
    )


def _order_rules() -> RuleSet:
    return RuleSet(
        name="order.demo",
        rules=(
            _order_rule(),
            Rule(
                id="order.amount_positive",
                predicate="compare",
                config={"path": "amount", "op": "gt", "value": 0},
                kind="order_amount",
                description="订单金额必须为正",
            ),
        ),
    )


# -- 规则数据形态 -------------------------------------------------------------


def test_rule_round_trip_preserves_declaration():
    """规则序列化 → 重建：谓词/参数/类型/严重度/描述完整还原。"""
    rule = Rule(
        id="r1",
        predicate="compare",
        config={"path": "count", "op": "lte", "value": 3},
        type=RULE_TRANSITION,
        target_path="sub.orders",
        severity=SEVERITY_WARNING,
        kind="demo",
        entity_type="order",
        description="示例",
    )
    rebuilt = Rule.from_dict(rule.to_dict())
    assert rebuilt == rule
    # 缺省字段不参与序列化（最小数据形态）
    minimal = Rule.from_dict(Rule(id="r2", predicate="truthy").to_dict())
    assert minimal.type == RULE_CONSTRAINT
    assert minimal.severity == SEVERITY_ERROR
    assert minimal.target_path is None


def test_rule_from_dict_rejects_malformed():
    """规则声明类型闸门：缺 id/predicate/config 非 dict/枚举非法 → 拒绝。"""
    with pytest.raises(GraphDefinitionError, match="缺 id"):
        Rule.from_dict({"predicate": "truthy"})
    with pytest.raises(GraphDefinitionError, match="缺 predicate"):
        Rule.from_dict({"id": "r"})
    with pytest.raises(GraphDefinitionError, match="config"):
        Rule.from_dict({"id": "r", "predicate": "truthy", "config": "nope"})
    with pytest.raises(GraphDefinitionError, match="类型非法"):
        Rule.from_dict({"id": "r", "predicate": "truthy", "type": "magic"})
    with pytest.raises(GraphDefinitionError, match="严重度非法"):
        Rule.from_dict({"id": "r", "predicate": "truthy", "severity": "fatal"})
    with pytest.raises(GraphDefinitionError, match="target_path"):
        Rule.from_dict({"id": "r", "predicate": "truthy", "target_path": 5})


def test_rule_set_round_trip_and_parse():
    """规则集序列化重建 + parse 校验（未知谓词/重复 id 建图期拒绝）。"""
    rule_set = _order_rules()
    rebuilt = RuleSet.from_dict(rule_set.to_dict())
    assert rebuilt.name == "order.demo"
    assert len(rebuilt.rules) == 2
    registry = RuleTypeRegistry()
    parsed = RuleSet.parse(rule_set.to_dict(), registry)
    assert parsed.name == rule_set.name
    # 未知谓词 = 声明错误（不延后到执行期静默跳过）
    bad = RuleSet(
        name="bad", rules=(Rule(id="x", predicate="not_a_predicate"),)
    )
    with pytest.raises(GraphDefinitionError, match="未注册的谓词"):
        RuleSet.parse(bad.to_dict(), registry)
    # 重复规则 id
    dup = RuleSet(
        name="dup",
        rules=(Rule(id="x", predicate="truthy"), Rule(id="x", predicate="falsy")),
    )
    with pytest.raises(GraphDefinitionError, match="重复"):
        RuleSet.parse(dup.to_dict(), registry)


# -- 谓词注册表 ---------------------------------------------------------------


def test_registry_rejects_duplicate_and_unknown():
    """谓词重复注册拒绝（含内置谓词不可覆盖）；未知谓词解析即报错。"""
    registry = RuleTypeRegistry()
    with pytest.raises(GraphDefinitionError, match="重复注册"):
        registry.register("present", lambda *args: [])
    assert "present" in registry.names()  # 内置通用谓词已登记
    with pytest.raises(GraphDefinitionError, match="未知谓词"):
        registry.create("ghost")


# -- 内置谓词 -----------------------------------------------------------------


def _run(rule_set: RuleSet, data: dict, registry: RuleTypeRegistry | None = None):
    engine = RuleEngine(registry)
    return engine.evaluate(rule_set, data)


def test_builtin_present_absent():
    rules = RuleSet(
        name="t",
        rules=(
            Rule(id="a", predicate="present", config={"path": "x"}, kind="t"),
            Rule(id="b", predicate="absent", config={"path": "y"}, kind="t"),
        ),
    )
    # x 存在 + y 缺失 = 双规则都通过
    assert _run(rules, {"x": 1}).issues == ()
    # x 缺失 → present 违规；y 存在 → absent 违规
    issues = _run(rules, {"y": 1}).issues
    assert {i.rule_id for i in issues} == {"a", "b"}
    assert issues[0].message == "字段缺失: x"


def test_builtin_equals_compare():
    rules = RuleSet(
        name="t",
        rules=(
            Rule(id="eq", predicate="equals", config={"path": "kind", "value": "a"}),
            Rule(id="gt", predicate="compare", config={"path": "n", "op": "gt", "value": 3}),
        ),
    )
    assert _run(rules, {"kind": "a", "n": 5}).issues == ()
    issues = _run(rules, {"kind": "b", "n": 2}).issues
    assert {i.rule_id for i in issues} == {"eq", "gt"}


def test_builtin_compare_other_path_and_missing_skip():
    """compare 支持对象内字段互比；任一侧缺失 = 规则不适用（跳过不误报）。"""
    rules = RuleSet(
        name="t",
        rules=(
            Rule(
                id="o",
                predicate="compare",
                config={"path": "end", "op": "gte", "other_path": "start"},
            ),
        ),
    )
    assert _run(rules, {"start": 3, "end": 5}).issues == ()
    assert _run(rules, {"start": 9, "end": 5}).issues != ()
    result = _run(rules, {"start": 3})  # end 缺失
    assert result.issues == ()
    assert result.skipped == ()  # 缺字段 = 目标不适用，跳过留痕
    assert result.checked == 1


def test_builtin_compare_invalid_op_rejected():
    """compare 的 op 非法 = 谓词配置错误（fail-open 跳过 + 留痕）。"""
    rules = RuleSet(
        name="t",
        rules=(
            Rule(
                id="bad_op",
                predicate="compare",
                config={"path": "n", "op": "approx", "value": 1},
            ),
        ),
    )
    result = _run(rules, {"n": 2})
    assert result.issues == ()
    assert result.skipped
    assert result.skipped[0][0] == "bad_op"
    assert "op 非法" in result.skipped[0][1]


def test_builtin_in_enum_and_contains():
    rules = RuleSet(
        name="t",
        rules=(
            Rule(id="e", predicate="in_enum", config={"path": "s", "values": ["a", "b"]}),
            Rule(id="c", predicate="contains", config={"path": "text", "value": "禁忌"}),
            Rule(id="nc", predicate="not_contains", config={"path": "text", "value": "干净"}),
        ),
    )
    # s 非法 → e 违规；正文不含「禁忌」→ c 违规；正文不含「干净」→ nc 通过
    issues = _run(rules, {"s": "z", "text": "含禁忌词"}).issues
    assert {i.rule_id for i in issues} == {"e"}
    issues2 = _run(rules, {"s": "a", "text": "正常内容"}).issues
    assert {i.rule_id for i in issues2} == {"c"}
    # 正文同时含「禁忌」与「干净」→ 仅 nc 违规
    issues3 = _run(rules, {"s": "a", "text": "含禁忌词且干净"}).issues
    assert {i.rule_id for i in issues3} == {"nc"}


def test_builtin_unique_pairs_detects_duplicates():
    """unique_pairs：集合内条目组合重复登记 → 违规（实体 = 首键值）。"""
    rules = RuleSet(
        name="t",
        rules=(
            Rule(
                id="u",
                predicate="unique_pairs",
                config={"keys": ["cause", "effect"]},
                target_path="links",
                kind="link",
            ),
        ),
    )
    data = {
        "links": [
            {"cause": "e1", "effect": "e2"},
            {"cause": "e1", "effect": "e2"},
            {"cause": "e3", "effect": "e4"},
        ]
    }
    issues = _run(rules, data).issues
    assert len(issues) == 1
    assert issues[0].entity_id == "e2"  # 实体锚点 = 组合末键（重复引用的目标）
    assert "重复登记" in issues[0].message
    # 实体锚点可经 entity_id_key 覆盖
    anchored = RuleSet(
        name="t",
        rules=(
            Rule(
                id="u",
                predicate="unique_pairs",
                config={"keys": ["cause", "effect"], "entity_id_key": "cause"},
                target_path="links",
            ),
        ),
    )
    assert _run(anchored, data).issues[0].entity_id == "e1"
    # 键字段缺失的条目不参与唯一性（不误报）
    data2 = {"links": [{"cause": "e1"}, {"cause": "e1"}]}
    assert _run(rules, data2).issues == ()


def test_builtin_state_transition_rule():
    """state_transition 谓词：声明式状态机规则（终态单向/白名单约束）。"""
    rules = RuleSet(
        name="t",
        rules=(
            Rule(
                id="t",
                predicate="state_transition",
                config={
                    "states": ["draft", "done"],
                    "terminal_states": ["done"],
                    "from_path": "from_state",
                    "to_path": "to_state",
                },
                type=RULE_TRANSITION,
            ),
        ),
    )
    # 终态转出 = 非法
    issues = _run(rules, {"from_state": "done", "to_state": "draft"}).issues
    assert len(issues) == 1
    assert "非法状态转换" in issues[0].message
    # 合法转换零违规
    assert _run(rules, {"from_state": "draft", "to_state": "done"}).issues == ()
    # 目标状态缺失 = 规则不适用
    assert _run(rules, {"from_state": "draft"}).issues == ()


def test_target_path_extraction():
    """target_path 点分取值：规则作用域定位到数据对象子结构。"""
    rules = RuleSet(
        name="t",
        rules=(
            Rule(
                id="sub",
                predicate="truthy",
                config={"path": "enabled"},
                target_path="settings.sub",
            ),
        ),
    )
    assert _run(rules, {"settings": {"sub": {"enabled": True}}}).issues == ()
    assert _run(rules, {"settings": {"sub": {"enabled": False}}}).issues != ()
    # 目标路径不存在 = 规则跳过（不适用），计入 skipped
    result = _run(rules, {"settings": {}})
    assert result.issues == ()
    assert result.skipped == (("sub", "目标路径不存在: settings.sub"),)


def test_path_denies_private_segments():
    """下划线前缀段拒绝访问（受限数据 DSL：不暴露对象内部属性）。"""
    class Inner:
        secret = "sensitive"

    rules = RuleSet(
        name="t",
        rules=(
            Rule(
                id="p",
                predicate="present",
                config={"path": "obj.__class__"},
                target_path="holder",
            ),
        ),
    )
    # dunder 段视为字段缺失（present 报违规），不返回对象内部属性
    result = _run(rules, {"holder": {"obj": Inner()}})
    assert result.issues
    assert result.issues[0].message == "字段缺失: obj.__class__"
    # 对象自身的公开属性仍可访问
    public = RuleSet(
        name="t",
        rules=(
            Rule(
                id="s",
                predicate="equals",
                config={"path": "obj.secret", "value": "sensitive"},
                target_path="holder",
            ),
        ),
    )
    assert _run(public, {"holder": {"obj": Inner()}}).issues == ()


def test_predicate_error_fail_open_skips_rule():
    """谓词运行时异常 fail-open：跳过该规则并留痕，不阻断其余规则。"""
    def boom(_target, _config, _context):
        raise RuntimeError("内部错误")

    registry = RuleTypeRegistry()
    registry.register("boom", boom)
    rules = RuleSet(
        name="t",
        rules=(
            Rule(id="bad", predicate="boom"),
            Rule(id="ok", predicate="truthy", config={"path": "x"}),
        ),
    )
    result = _run(rules, {"x": 1}, registry)
    assert result.issues == ()
    assert ("bad", "谓词执行异常（fail-open 跳过）: 内部错误") in result.skipped
    assert result.checked == 2


def test_unknown_predicate_raises_at_evaluate():
    """未知谓词在执行期也是声明错误（抛错，不静默跳过）。"""
    rules = RuleSet(name="t", rules=(Rule(id="x", predicate="ghost"),))
    with pytest.raises(GraphDefinitionError, match="未知谓词"):
        _run(rules, {})


def test_violation_carries_rule_metadata():
    """违规携带规则元数据（rule_id/kind/severity/entity_type）+ 序列化往返。"""
    rules = RuleSet(
        name="t",
        rules=(
            Rule(
                id="x",
                predicate="in_enum",
                config={"path": "status", "values": ["ok"]},
                kind="demo",
                entity_type="thing",
            ),
        ),
    )
    issue = _run(rules, {"status": "bad"}).issues[0]
    assert issue.rule_id == "x"
    assert issue.kind == "demo"
    assert issue.severity == SEVERITY_ERROR
    assert issue.entity_type == "thing"
    rebuilt = RuleViolation.from_dict(issue.to_dict())
    assert rebuilt == issue


def test_rule_check_result_has_hard_conflict():
    """has_hard_conflict：任一 error 级违规 = 存在硬冲突（与领域语义对齐）。"""
    rules = RuleSet(
        name="t",
        rules=(
            Rule(id="w", predicate="falsy", config={"path": "a"}, severity=SEVERITY_WARNING),
            Rule(id="e", predicate="falsy", config={"path": "b"}),
        ),
    )
    assert _run(rules, {"a": True, "b": True}).has_hard_conflict() is True
    assert _run(rules, {"a": True, "b": False}).has_hard_conflict() is False


# -- 混合判定（确定性规则 + LLM 钩子） ----------------------------------------


async def test_constraint_checker_llm_hook_merges():
    """LLM 钩子补充判定：确定性违规 + 钩子违规并集返回。"""
    async def hook(data, context, issues):
        return [{"message": "语义深度偏离", "kind": "semantic", "entity_id": "c1"}]

    checker = ConstraintChecker(llm_hook=hook)
    rule_set = RuleSet(name="t", rules=(Rule(id="a", predicate="truthy", config={"path": "x"}),))
    result = await checker.check(rule_set, {"x": 1})
    assert len(result.issues) == 1
    assert result.issues[0].rule_id == "__llm_hook__"
    assert result.issues[0].kind == "semantic"
    assert result.issues[0].message == "语义深度偏离"


async def test_constraint_checker_hook_failure_fail_open():
    """钩子异常 fail-open：跳过钩子并留痕，确定性结果不受影响。"""
    async def bad_hook(data, context, issues):
        raise RuntimeError("钩子故障")

    checker = ConstraintChecker(llm_hook=bad_hook)
    rule_set = RuleSet(name="t", rules=(Rule(id="a", predicate="truthy", config={"path": "x"}),))
    result = await checker.check(rule_set, {"x": 1})
    assert result.issues == ()
    assert ("__llm_hook__", "钩子异常: 钩子故障") in result.skipped


async def test_constraint_checker_hook_malformed_dropped():
    """钩子返回形态非法条目丢弃（缺 message）并留日志，不污染结果。"""
    async def hook(data, context, issues):
        return [{"message": "有效"}, {"no_message": True}, "garbage"]

    checker = ConstraintChecker(llm_hook=hook)
    result = await checker.check(_order_rules(), {"amount": 5, "from_state": "draft", "to_state": "paid"})
    assert len(result.issues) == 1
    assert result.issues[0].message == "有效"


# -- 样例库闸门 ---------------------------------------------------------------


def _fixtures() -> FixtureSet:
    return FixtureSet(
        name="demo",
        cases=(
            FixtureCase(id="pass", data={"x": 1}),
            FixtureCase(
                id="violate",
                data={"x": 0},
                expected_pass=False,
                expected_kinds=("demo",),
            ),
        ),
    )


def test_run_fixtures_and_gate():
    """样例闸门：规则集对全部样例通过才放行（失败明细可审计）。"""
    rule_set = RuleSet(
        name="t",
        rules=(Rule(id="a", predicate="truthy", config={"path": "x"}, kind="demo"),),
    )
    results = run_fixtures(rule_set, _fixtures())
    by_id = {r.case_id: r for r in results}
    assert by_id["pass"].passed is True
    assert by_id["violate"].passed is True
    assert fixtures_all_green(rule_set, _fixtures()) is True
    assert_fixtures_pass(rule_set, _fixtures())

    # 规则过严：violate 用例期望违规，规则却放行 → 闸门拒绝
    lenient = RuleSet(name="t", rules=(Rule(id="a", predicate="falsy", config={"path": "x"}),))
    assert fixtures_all_green(lenient, _fixtures()) is False
    with pytest.raises(FixtureGateError, match=r"violate.*期望至少一条违规"):
        assert_fixtures_pass(lenient, _fixtures())


def test_fixture_expected_kinds_missing_reported():
    """expected_kinds 缺失类别 → 用例失败并报告缺失类别（子集语义）。"""
    rule_set = RuleSet(
        name="t",
        rules=(Rule(id="a", predicate="falsy", config={"path": "x"}, kind="other"),),
    )
    result = run_fixtures(rule_set, _fixtures())[1]
    assert result.passed is False
    assert result.missing_kinds == ("demo",)


def test_fixture_set_round_trip():
    """样例库/用例序列化往返：期望语义（pass/违规类别）完整还原。"""
    rebuilt = FixtureSet.from_dict(_fixtures().to_dict())
    assert rebuilt.name == "demo"
    assert rebuilt.cases[1].expected_pass is False
    assert rebuilt.cases[1].expected_kinds == ("demo",)
    # 全通过样例缺省序列化为最小形态（expected_pass 不落盘）
    assert "expected_pass" not in rebuilt.cases[0].to_dict()


def test_fixture_case_from_dict_rejects_malformed():
    """样例用例类型闸门：缺 id/data、data 非 dict → 建图期拒绝。"""
    with pytest.raises(GraphDefinitionError, match="缺 id"):
        FixtureCase.from_dict({"data": {}})
    with pytest.raises(GraphDefinitionError, match="data"):
        FixtureCase.from_dict({"id": "c", "data": "nope"})
    with pytest.raises(GraphDefinitionError, match="expected_kinds"):
        FixtureCase.from_dict({"id": "c", "data": {}, "expected_kinds": "nope"})


def test_fixture_gate_catches_rule_regression():
    """回归防线：削弱既有规则（删除违规定位）立即被样例闸门拦截。"""
    full = RuleSet(
        name="t",
        rules=(Rule(id="a", predicate="truthy", config={"path": "x"}, kind="demo"),),
    )
    regressed = RuleSet(
        name="t",
        rules=(Rule(id="a", predicate="truthy", config={"path": "unrelated"}),),
    )
    assert fixtures_all_green(full, _fixtures()) is True
    assert fixtures_all_green(regressed, _fixtures()) is False
