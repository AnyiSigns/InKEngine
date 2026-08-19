"""Schema 校验器单测：声明数据形态 / 字段约束 / 违规清单可审计。

语义检查点：SchemaSpec 可序列化 round-trip（随补丁链版本化）；必填/
类型/枚举/范围/正则逐类拒绝非法声明；未知字段忽略（演进宽容）；违规
清单含字段名与原因（L1 闸门失败原因直接可展示）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.schema_validator import (
    SchemaField,
    SchemaSpec,
    SchemaValidator,
)


def _entry_schema() -> SchemaSpec:
    return SchemaSpec.from_dict(
        {
            "name": "knowledge_entry",
            "fields": [
                {"name": "id", "required": True, "kind": "string"},
                {"name": "level", "required": True, "kind": "string",
                 "enum": ["work", "project", "user"]},
                {"name": "kind", "required": True, "kind": "string"},
                {"name": "credibility", "kind": "number", "min": 0.0, "max": 1.0},
                {"name": "data.message", "kind": "string", "required": True},
            ],
        }
    )


def test_schema_spec_roundtrip():
    """SchemaSpec 序列化 round-trip（补丁链版本化契约）。"""
    spec = _entry_schema()
    rebuilt = SchemaSpec.from_dict(spec.to_dict())
    assert rebuilt.name == spec.name
    assert [f.name for f in rebuilt.fields] == [
        "id", "level", "kind", "credibility", "data.message"
    ]
    assert rebuilt.fields[1].enum == ("work", "project", "user")
    assert rebuilt.fields[3].min == 0.0
    assert rebuilt.fields[3].max == 1.0


def test_schema_spec_duplicate_field_rejected():
    """字段名重复拒绝（声明歧义）。"""
    with pytest.raises(GraphDefinitionError, match="重复"):
        SchemaSpec.from_dict(
            {
                "name": "s",
                "fields": [
                    {"name": "x", "kind": "string"},
                    {"name": "x", "kind": "number"},
                ],
            }
        )


def test_schema_field_invalid_kind_rejected():
    """未知字段类型拒绝。"""
    with pytest.raises(GraphDefinitionError, match="类型非法"):
        SchemaField.from_dict({"name": "x", "kind": "datetime"})


def test_schema_field_invalid_range_rejected():
    """范围声明自相矛盾拒绝。"""
    with pytest.raises(GraphDefinitionError, match="自相矛盾"):
        SchemaField.from_dict({"name": "x", "kind": "number", "min": 5, "max": 1})


def test_schema_field_invalid_pattern_rejected():
    """非法正则拒绝（构造期暴露，不延后到执行期）。"""
    with pytest.raises(GraphDefinitionError, match="正则"):
        SchemaField.from_dict({"name": "x", "kind": "string", "pattern": "("})


def test_validator_required_missing():
    """必填字段缺失 → 违规。"""
    schema = _entry_schema()
    validator = SchemaValidator()
    violations = validator.validate(schema, {"id": "k1"})
    assert any("level" in v and "缺失" in v for v in violations)
    assert any("data.message" in v and "缺失" in v for v in violations)


def test_validator_type_mismatch():
    """类型不匹配 → 违规（number 不接受 bool，防 0/1 误判）。"""
    schema = _entry_schema()
    validator = SchemaValidator()
    data = {
        "id": "k1",
        "level": "work",
        "kind": "rule",
        "credibility": True,  # bool 不是 number
        "data": {"message": "hello"},
    }
    violations = validator.validate(schema, data)
    assert any("credibility" in v and "类型不匹配" in v for v in violations)


def test_validator_enum_violation():
    """枚举取值非法 → 违规。"""
    schema = _entry_schema()
    validator = SchemaValidator()
    violations = validator.validate(
        schema,
        {"id": "k1", "level": "archive", "kind": "rule", "data": {"message": "m"}},
    )
    assert any("level" in v and "取值非法" in v for v in violations)


def test_validator_range_violation():
    """数值范围越界 → 违规。"""
    schema = _entry_schema()
    validator = SchemaValidator()
    violations = validator.validate(
        schema,
        {"id": "k1", "level": "work", "kind": "rule",
         "credibility": 1.5, "data": {"message": "m"}},
    )
    assert any("credibility" in v and "超过上限" in v for v in violations)


def test_validator_pattern_violation():
    """正则不匹配 → 违规。"""
    schema = SchemaSpec.from_dict(
        {
            "name": "s",
            "fields": [
                {"name": "id", "kind": "string", "pattern": "^k-[a-z0-9]+$"}
            ],
        }
    )
    validator = SchemaValidator()
    assert validator.validate(schema, {"id": "BAD_ID"})
    assert not validator.validate(schema, {"id": "k-abc123"})


def test_validator_nested_path():
    """点分路径嵌套校验（data.message）。"""
    schema = _entry_schema()
    validator = SchemaValidator()
    assert not validator.validate(
        schema,
        {"id": "k1", "level": "work", "kind": "rule", "data": {"message": "m"}},
    )
    violations = validator.validate(
        schema, {"id": "k1", "level": "work", "kind": "rule", "data": {}}
    )
    assert any("data.message" in v for v in violations)


def test_validator_unknown_field_ignored():
    """未知字段忽略（schema 演进宽容：加字段不破坏旧数据校验）。"""
    schema = _entry_schema()
    validator = SchemaValidator()
    assert not validator.validate(
        schema,
        {
            "id": "k1", "level": "work", "kind": "rule",
            "data": {"message": "m"},
            "future_field": "anything",
        },
    )


def test_validator_validate_ok_helper():
    """validate_ok 布尔判定（零违规 = True）。"""
    schema = _entry_schema()
    validator = SchemaValidator()
    assert validator.validate_ok(
        schema, {"id": "k1", "level": "work", "kind": "rule", "data": {"message": "m"}}
    )
    assert not validator.validate_ok(schema, {"id": "k1"})


def test_validator_all_kinds():
    """全部字段类型各自匹配/拒绝。"""
    schema = SchemaSpec.from_dict(
        {
            "name": "s",
            "fields": [
                {"name": "a", "kind": "string"},
                {"name": "b", "kind": "number"},
                {"name": "c", "kind": "boolean"},
                {"name": "d", "kind": "object"},
                {"name": "e", "kind": "array"},
            ],
        }
    )
    validator = SchemaValidator()
    assert not validator.validate(
        schema, {"a": "s", "b": 1.5, "c": True, "d": {}, "e": []}
    )
    assert validator.validate(schema, {"a": 1, "b": "x", "c": 1, "d": [], "e": {}})
