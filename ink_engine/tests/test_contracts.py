"""结点契约与机制装配开关单测：序列化往返/缺省语义/非法声明拒绝。

契约是纯数据（schema 声明复用 SchemaSpec 语言），随图定义数据落库；
缺省契约 = 无契约结点（不参与组装，仅可被手绘图引用——旧形态零破坏）。
"""
from __future__ import annotations

from typing import Protocol

import pytest

from ink_engine.core.contracts import (
    CONTRACT_VERSION_MIN,
    SAFETY_TIER_MAX,
    SAFETY_TIER_MIN,
    NodeContract,
    PathAssemblyConfig,
    QualityGate,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.schema_validator import (
    FIELD_NUMBER,
    FIELD_STRING,
    SchemaField,
    SchemaSpec,
)


def _field(name: str, required: bool = False, kind: str = FIELD_STRING) -> SchemaField:
    return SchemaField(name=name, required=required, kind=kind)


def _spec(name: str, *fields: SchemaField) -> SchemaSpec:
    return SchemaSpec(name=name, fields=tuple(fields))


def test_contract_defaults():
    """缺省契约 = 无输入输出声明 + 最严安全档 + 首版。"""
    contract = NodeContract()
    assert contract.input_schema is None
    assert contract.output_schema is None
    assert contract.safety_tier == SAFETY_TIER_MIN
    assert contract.version == CONTRACT_VERSION_MIN


def test_contract_round_trip_preserves_all_fields():
    """契约序列化 → 反序列化：schema 声明/安全档/版本完整还原。"""
    contract = NodeContract(
        input_schema=_spec(
            "in", _field("x", required=True), _field("y", kind=FIELD_NUMBER)
        ),
        output_schema=_spec("out", _field("z")),
        safety_tier=2,
        version=3,
    )
    rebuilt = NodeContract.from_dict(contract.to_dict())
    assert rebuilt == contract
    assert rebuilt.input_schema == contract.input_schema
    assert rebuilt.output_schema == contract.output_schema


def test_contract_to_dict_emits_all_keys():
    """序列化形态稳定：四个键全量显式（数据自描述，无隐式缺省）。"""
    data = NodeContract().to_dict()
    assert set(data) == {
        "input_schema",
        "output_schema",
        "safety_tier",
        "version",
    }
    assert data["input_schema"] is None
    assert data["output_schema"] is None


def test_contract_from_dict_omitted_keys_default():
    """缺省键反序列化 = 默认值（旧数据兼容）。"""
    assert NodeContract.from_dict({}) == NodeContract()
    assert NodeContract.from_dict({"safety_tier": 1}) == NodeContract(safety_tier=1)


def test_contract_safety_tier_out_of_range_rejected():
    """安全档越界拒绝（档位是声明约束：仅 0/1/2 三档）。"""
    with pytest.raises(GraphDefinitionError, match="安全档"):
        NodeContract(safety_tier=-1)
    with pytest.raises(GraphDefinitionError, match="安全档"):
        NodeContract(safety_tier=3)
    assert NodeContract(safety_tier=SAFETY_TIER_MAX).safety_tier == 2


def test_contract_version_below_min_rejected():
    """契约版本须 ≥ 1（行为变更 = 升版，无零版本）。"""
    with pytest.raises(GraphDefinitionError, match="版本"):
        NodeContract(version=0)


def test_contract_from_dict_invalid_shapes_rejected():
    """反序列化非法声明拒绝（防脏数据静默落库）。"""
    with pytest.raises(GraphDefinitionError, match="契约声明非法"):
        NodeContract.from_dict("nope")  # type: ignore[arg-type]
    with pytest.raises(GraphDefinitionError, match="安全档/版本须为整数"):
        NodeContract.from_dict({"safety_tier": "x"})
    with pytest.raises(GraphDefinitionError, match="不接受布尔值"):
        NodeContract.from_dict({"safety_tier": True})
    with pytest.raises(GraphDefinitionError, match="input_schema 声明非法"):
        NodeContract.from_dict({"input_schema": 3})
    with pytest.raises(GraphDefinitionError, match="版本"):
        NodeContract.from_dict({"version": 0})


def test_contract_schema_must_be_schema_spec():
    """schema 字段只接受 SchemaSpec（数据形态约束）。"""
    with pytest.raises(GraphDefinitionError, match="SchemaSpec"):
        NodeContract(input_schema={"name": "x", "fields": []})  # type: ignore[arg-type]


def test_assembly_config_default_off_and_round_trip():
    """机制装配配置开关默认全关（增量接入），序列化往返一致。"""
    config = PathAssemblyConfig()
    assert config.enabled is False
    assert PathAssemblyConfig.from_dict(config.to_dict()) == config
    assert PathAssemblyConfig.from_dict({"enabled": True}).enabled is True


def test_assembly_config_from_dict_rejects_non_dict():
    with pytest.raises(GraphDefinitionError, match="装配配置声明非法"):
        PathAssemblyConfig.from_dict("nope")  # type: ignore[arg-type]


def test_quality_gate_defines_judge_only():
    """闸门窄协议只定义按域判定接口（实现归使用方，本模块不实现）。"""
    assert issubclass(QualityGate, Protocol)
    assert callable(QualityGate.judge)
