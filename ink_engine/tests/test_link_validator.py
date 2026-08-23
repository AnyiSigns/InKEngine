"""链接校验器单测：规则矩阵（字段覆盖/多源汇聚/reducer/安全档/版本/确定性）。

两级语义分断言：前缀可达性（弱校验，组装/路径校验用）不误杀多源汇聚
合法路径；相邻覆盖（强校验，显式边/手绘图用）只认直接覆盖。其余规则
按矩阵逐条断言，理由顺序稳定可断言。
"""
from __future__ import annotations

import pytest

from ink_engine.core.contracts import NodeContract
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.link_validator import (
    produced_field_names,
    required_field_names,
    validate_link,
    validate_prefix_reachability,
)
from ink_engine.core.schema_validator import (
    FIELD_ARRAY,
    FIELD_NUMBER,
    FIELD_OBJECT,
    FIELD_STRING,
    SchemaField,
    SchemaSpec,
)
from ink_engine.core.state import StateSchema


def _field(name: str, required: bool = False, kind: str = FIELD_STRING) -> SchemaField:
    return SchemaField(name=name, required=required, kind=kind)


def _spec(name: str, *fields: SchemaField) -> SchemaSpec:
    return SchemaSpec(name=name, fields=tuple(fields))


def _contract(
    input_schema: SchemaSpec | None = None,
    output_schema: SchemaSpec | None = None,
    safety_tier: int = 0,
    version: int = 1,
) -> NodeContract:
    return NodeContract(
        input_schema=input_schema,
        output_schema=output_schema,
        safety_tier=safety_tier,
        version=version,
    )


# ── 相邻覆盖（强校验）──


def test_adjacent_coverage_pass():
    src = _contract(output_schema=_spec("out", _field("x"), _field("y")))
    dst = _contract(input_schema=_spec("in", _field("x", required=True)))
    ok, reasons = validate_link(src, dst)
    assert ok is True
    assert reasons == []


def test_adjacent_coverage_missing_required_rejected():
    """必填输入缺覆盖 → 拒绝；理由含全部缺字段且排序稳定。"""
    src = _contract(output_schema=_spec("out", _field("x")))
    dst = _contract(
        input_schema=_spec("in", _field("y", required=True), _field("x", required=True))
    )
    ok, reasons = validate_link(src, dst)
    assert ok is False
    assert any("目标必填输入字段未被起点产出覆盖" in r and "y" in r for r in reasons)
    assert "x" not in "".join(reasons)  # x 已覆盖，不误报


def test_optional_input_not_covered_is_fine():
    """可选输入字段不要求覆盖（宽容：未声明产出不阻断链接）。"""
    src = _contract(output_schema=_spec("out", _field("x")))
    dst = _contract(input_schema=_spec("in", _field("z")))
    assert validate_link(src, dst)[0] is True


def test_adjacent_coverage_ignores_extra_outputs():
    """起点多余产出不阻断链接（宽容演进：加字段不破坏旧链接）。"""
    src = _contract(output_schema=_spec("out", _field("x"), _field("extra")))
    dst = _contract(input_schema=_spec("in", _field("x", required=True)))
    assert validate_link(src, dst)[0] is True


# ── 前缀可达性（弱校验）+ 两级语义分断言 ──


def test_multi_source_path_not_killed_by_adjacent_coverage():
    """多输入结点合法路径：前缀可达性放行，相邻覆盖会误杀——两级分断言。

    qa 结点同时消费 code 与 tests，由两个前置结点分别产出——这是多源
    汇聚的合法形态；单源链接校验必然拒绝，组装/路径校验必须用弱校验。
    """
    producer_a = _contract(output_schema=_spec("a", _field("code")))
    producer_b = _contract(output_schema=_spec("b", _field("tests")))
    qa = _contract(
        input_schema=_spec(
            "qa",
            _field("code", required=True),
            _field("tests", required=True),
        )
    )
    ok, reasons = validate_prefix_reachability([producer_a, producer_b, qa])
    assert ok is True, reasons
    # 对照：相邻覆盖只认直接覆盖——单源链接校验必失败（多源路径不被误杀的证据）
    assert validate_link(producer_a, qa)[0] is False
    assert validate_link(producer_b, qa)[0] is False


def test_prefix_reachability_uses_entry_fields():
    """入口字段注入：首个结点输入 ⊆ 入口字段即可达。"""
    entry = _contract(input_schema=_spec("in", _field("goal", required=True)))
    assert validate_prefix_reachability([entry], entry_fields={"goal"})[0] is True
    ok, reasons = validate_prefix_reachability([entry])
    assert ok is False
    assert any("输入字段不可达" in r and "goal" in r for r in reasons)


def test_prefix_reachability_gap_rejected():
    """字段缺口拒绝：下游必填字段无任何前置产出。"""
    a = _contract(output_schema=_spec("a", _field("code")))
    c = _contract(
        input_schema=_spec("c", _field("code", required=True), _field("tests", required=True))
    )
    ok, reasons = validate_prefix_reachability([a, c])
    assert ok is False
    assert any("tests" in r for r in reasons)


def test_prefix_reachability_no_contract_rejected():
    """无契约结点不可参与组装（仅可被手绘图引用，旧行为零破坏）。"""
    with_contract = _contract(output_schema=_spec("o", _field("x")))
    ok, reasons = validate_prefix_reachability([None, with_contract])
    assert ok is False
    assert any("无契约" in r for r in reasons)


# ── 安全档 ──


def test_safety_tier_pruning_link():
    """目标安全档超过组装请求档位 → 剪枝拒绝。"""
    src = _contract(output_schema=_spec("out", _field("x")))
    high = _contract(
        input_schema=_spec("in", _field("x", required=True)), safety_tier=2
    )
    ok, reasons = validate_link(src, high, max_safety_tier=1)
    assert ok is False
    assert any("安全档" in r and "2" in r for r in reasons)
    # 同档放行
    assert validate_link(src, high, max_safety_tier=2)[0] is True


def test_safety_tier_default_strictest():
    """请求档位缺省 = 0 最严：任何高安全结点默认不可进路径。"""
    src = _contract(output_schema=_spec("out", _field("x")))
    mid = _contract(
        input_schema=_spec("in", _field("x", required=True)), safety_tier=1
    )
    assert validate_link(src, mid)[0] is False


def test_safety_tier_pruning_sequence():
    """路径校验逐结点剪枝（含入口结点）。"""
    node = _contract(safety_tier=2)
    assert validate_prefix_reachability([node], max_safety_tier=1)[0] is False
    assert validate_prefix_reachability([node], max_safety_tier=2)[0] is True


def test_request_tier_out_of_range_rejected():
    """请求档位越界 = 声明错误（fail-fast，不等比较期静默放行）。"""
    with pytest.raises(GraphDefinitionError, match="档位越界"):
        validate_link(None, None, max_safety_tier=3)
    with pytest.raises(GraphDefinitionError, match="档位越界"):
        validate_prefix_reachability([], max_safety_tier=-1)


# ── 契约版本存在性 ──


def test_version_registered_passes():
    src = _contract(output_schema=_spec("out", _field("x")), version=1)
    dst = _contract(
        input_schema=_spec("in", _field("x", required=True)), version=1
    )
    known = {"producer": {1}, "consumer": {1}}
    ok, reasons = validate_link(
        src, dst,
        src_type="producer", dst_type="consumer", known_versions=known,
    )
    assert ok is True, reasons


def test_version_unregistered_rejected():
    """引用的契约版本未登记 → 拒绝（旧图定义可解析的红线）。"""
    src = _contract(output_schema=_spec("out", _field("x")), version=1)
    dst = _contract(
        input_schema=_spec("in", _field("x", required=True)), version=2
    )
    known = {"producer": {1}, "consumer": {1}}
    ok, reasons = validate_link(
        src, dst,
        src_type="producer", dst_type="consumer", known_versions=known,
    )
    assert ok is False
    assert any("版本未登记" in r and "2" in r for r in reasons)


def test_version_unknown_type_rejected():
    """类型名未登记 → 拒绝（版本存在性无从判定，fail-closed）。"""
    src = _contract(output_schema=_spec("out", _field("x")))
    dst = _contract(input_schema=_spec("in", _field("x", required=True)))
    known = {"producer": {1}}
    ok, reasons = validate_link(
        src, dst,
        src_type="producer", dst_type="ghost", known_versions=known,
    )
    assert ok is False
    assert any("版本未登记" in r and "ghost" in r for r in reasons)


def test_version_check_skipped_without_known_versions():
    """未提供登记表 = 规则跳过（纯增量：旧调用形态不感知版本规则）。"""
    src = _contract(output_schema=_spec("out", _field("x")), version=9)
    dst = _contract(input_schema=_spec("in", _field("x", required=True)), version=9)
    assert validate_link(src, dst, src_type="a", dst_type="b")[0] is True


# ── reducer 兼容（通道写入遵循 StateSchema.apply 语义）──


def _channel_schema() -> StateSchema:
    return StateSchema(
        {
            "metrics": "merge_metrics",
            "notes": None,
            "messages": "add_messages",
        }
    )


def test_reducer_compat_merge_channel_accepts_object():
    """合并累加通道（merge_metrics 族）：对象写入合规。"""
    writer = _contract(output_schema=_spec("o", _field("metrics", kind=FIELD_OBJECT)))
    assert validate_link(writer, _contract(), state_schema=_channel_schema())[0] is True


def test_reducer_compat_merge_channel_rejects_non_object():
    writer = _contract(output_schema=_spec("o", _field("metrics", kind=FIELD_STRING)))
    ok, reasons = validate_link(writer, _contract(), state_schema=_channel_schema())
    assert ok is False
    assert any("合并累加" in r and "metrics" in r for r in reasons)


def test_reducer_compat_additive_channel_accepts_array():
    """累积追加通道（add_messages 族）：序列写入合规。"""
    writer = _contract(output_schema=_spec("o", _field("messages", kind=FIELD_ARRAY)))
    assert validate_link(writer, _contract(), state_schema=_channel_schema())[0] is True


def test_reducer_compat_additive_channel_rejects_non_array():
    writer = _contract(output_schema=_spec("o", _field("messages", kind=FIELD_OBJECT)))
    ok, reasons = validate_link(writer, _contract(), state_schema=_channel_schema())
    assert ok is False
    assert any("累积追加" in r and "messages" in r for r in reasons)


def test_reducer_compat_bare_channel_any_kind():
    """裸通道（无 reducer）：任意字段形态合规（apply 裸覆盖语义）。"""
    writer = _contract(output_schema=_spec("o", _field("notes", kind=FIELD_NUMBER)))
    assert validate_link(writer, _contract(), state_schema=_channel_schema())[0] is True


def test_reducer_compat_skipped_without_state_schema():
    """未提供状态 schema = 规则跳过（纯增量：旧调用形态零感知）。"""
    writer = _contract(output_schema=_spec("o", _field("metrics", kind=FIELD_STRING)))
    assert validate_link(writer, _contract())[0] is True


def test_reducer_compat_in_sequence():
    """路径校验同样检查通道写入（逐结点）。"""
    schema = _channel_schema()
    writer = _contract(output_schema=_spec("o", _field("metrics", kind=FIELD_STRING)))
    ok, reasons = validate_prefix_reachability([writer], state_schema=schema)
    assert ok is False
    assert any("合并累加" in r for r in reasons)


# ── 无契约 ──


def test_no_contract_link_rejected():
    """无契约结点不可参与组装（仅可被手绘图引用）。"""
    with_contract = _contract(output_schema=_spec("o", _field("x")))
    ok, reasons = validate_link(None, with_contract)
    assert ok is False
    assert any("起点结点无契约" in r for r in reasons)
    ok, reasons = validate_link(with_contract, None)
    assert ok is False
    assert any("目标结点无契约" in r for r in reasons)


# ── 确定性 ──


def test_validate_link_deterministic():
    """纯函数同输入同输出（含理由清单逐项相等）。"""
    src = _contract(output_schema=_spec("out", _field("x")), version=9)
    dst = _contract(
        input_schema=_spec("in", _field("y", required=True)),
        safety_tier=2,
        version=9,
    )
    kwargs = {
        "max_safety_tier": 1,
        "src_type": "producer",
        "dst_type": "consumer",
        "known_versions": {"producer": {1}, "consumer": {1}},
        "state_schema": _channel_schema(),
    }
    first = validate_link(src, dst, **kwargs)
    second = validate_link(src, dst, **kwargs)
    assert first == second
    assert first[0] is False
    assert len(first[1]) >= 2  # 覆盖缺字段 + 安全档 至少两条理由


def test_prefix_reachability_deterministic():
    sequence = [
        _contract(output_schema=_spec("a", _field("x"))),
        _contract(
            input_schema=_spec("b", _field("y", required=True)), safety_tier=2
        ),
    ]
    first = validate_prefix_reachability(sequence, max_safety_tier=0)
    second = validate_prefix_reachability(sequence, max_safety_tier=0)
    assert first == second
    assert first[0] is False


# ── 字段名提取助手 ──


def test_field_name_helpers():
    spec = _spec("s", _field("x", required=True), _field("y"))
    assert required_field_names(spec) == frozenset({"x"})
    assert produced_field_names(spec) == frozenset({"x", "y"})
    assert required_field_names(None) == frozenset()
    assert produced_field_names(None) == frozenset()
