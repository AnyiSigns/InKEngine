"""契约映射单测：工具声明 → 结点契约自动生成（input=parameters，output=端点操作结果形态）。

覆盖（映射断言段）：
- input 映射：parameters 的 JSON Schema 属性 → SchemaField（必填/类型/枚举/边界透传）；
- output 映射：按端点类型给出操作结果形态（process_exec/file_ops/mcp/http_fetch/web_search）；
- 安全档映射：审批档同阶（allow=0 / review=1 / deny=2）；
- 版本映射：meta.contract_version 缺省回落 1；
- 结点池同源：node_type == tool_name 映射表 + 结点池条目与工具表一致性校验。
"""
from __future__ import annotations

import pytest

from ink_engine.core.declarative_tools import (
    DeclarativeToolSpec,
    EndpointType,
    node_contracts_from_tools,
    tool_contract_from_declaration,
    tool_node_mapping,
    validate_tool_node_consistency,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.schema_validator import (
    FIELD_ARRAY,
    FIELD_NUMBER,
    FIELD_OBJECT,
    FIELD_STRING,
)


def _process_tool() -> DeclarativeToolSpec:
    return DeclarativeToolSpec(
        name="propose_patch",
        description="行为意图：自指演化提案。\n\n使用时机：…。\n\n取舍与替代选项：…。\n\n参数语义：…。\n\n边界与协作：…。",
        parameters={
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["ui", "theme", "tool"]},
                "payload": {"type": "object"},
                "base_version": {"type": "integer"},
            },
            "required": ["kind", "payload"],
        },
        permissions=("process:exec:propose_patch",),
        endpoint=EndpointType.PROCESS_EXEC,
        endpoint_config={"allowlist": ["propose_patch"]},
        meta={"approval": "review", "contract_version": 3},
    )


def test_contract_input_maps_parameters():
    """input = parameters：属性 → 字段（必填/类型/枚举透传）。"""
    contract = tool_contract_from_declaration(_process_tool())
    fields = {f.name: f for f in contract.input_schema.fields}
    assert contract.input_schema.name == "propose_patch.input"
    assert fields["kind"].required is True
    assert fields["kind"].kind == FIELD_STRING
    assert fields["kind"].enum == ("ui", "theme", "tool")
    assert fields["payload"].required is True
    assert fields["payload"].kind == FIELD_OBJECT
    assert fields["base_version"].required is False
    assert fields["base_version"].kind == FIELD_NUMBER  # integer 归一 number


def test_contract_output_shape_per_endpoint():
    """output = 端点操作结果形态：process_exec → stdout/exit_code。"""
    contract = tool_contract_from_declaration(_process_tool())
    out = {f.name: f for f in contract.output_schema.fields}
    assert contract.output_schema.name == "propose_patch.output"
    assert out["stdout"].kind == FIELD_STRING
    assert out["exit_code"].kind == FIELD_NUMBER

    mcp = DeclarativeToolSpec(
        name="m",
        description="mcp 工具声明",
        parameters={"type": "object", "properties": {}},
        permissions=("mcp:call:s",),
        endpoint=EndpointType.MCP,
        endpoint_config={"server_id": "s"},
    )
    out_mcp = {f.name: f for f in tool_contract_from_declaration(mcp).output_schema.fields}
    assert out_mcp["result"].kind == FIELD_OBJECT

    web = DeclarativeToolSpec(
        name="w",
        description="检索工具声明",
        parameters={"type": "object", "properties": {"query": {"type": "string"}}},
        permissions=("network:connect:web",),
        endpoint=EndpointType.WEB_SEARCH,
    )
    out_web = {f.name: f for f in tool_contract_from_declaration(web).output_schema.fields}
    assert out_web["results"].kind == FIELD_ARRAY


def test_contract_safety_tier_and_version():
    """安全档 = 审批档同阶；版本 = meta.contract_version 缺省回落 1。"""
    review = tool_contract_from_declaration(_process_tool())
    assert review.safety_tier == 1
    assert review.version == 3  # meta.contract_version

    allow = DeclarativeToolSpec(
        name="a",
        description="allow 档工具",
        parameters={"type": "object", "properties": {}},
        permissions=("process:exec:a",),
        endpoint=EndpointType.PROCESS_EXEC,
        endpoint_config={"allowlist": ["a"]},
        meta={"approval": "allow"},
    )
    assert tool_contract_from_declaration(allow).safety_tier == 0
    assert tool_contract_from_declaration(allow).version == 1  # 无声明回落 1

    deny = DeclarativeToolSpec(
        name="d",
        description="deny 档工具",
        parameters={"type": "object", "properties": {}},
        permissions=("process:exec:d",),
        endpoint=EndpointType.PROCESS_EXEC,
        endpoint_config={"allowlist": ["d"]},
        meta={"approval": "deny"},
    )
    assert tool_contract_from_declaration(deny).safety_tier == 2


def test_node_mapping_same_source():
    """结点池与工具表同源：node_type == tool_name，重复登记显式拒绝。"""
    tools = [_process_tool(), _process_tool()]
    with pytest.raises(GraphDefinitionError, match="同源冲突"):
        tool_node_mapping(tools)
    mapping = tool_node_mapping(tools[:1])
    assert mapping == {"propose_patch": "propose_patch"}


def test_node_contracts_pool_and_consistency():
    """结点池条目 = 工具表同源生成；篡改后一致性校验报出漂移。"""
    tools = [_process_tool()]
    pool = node_contracts_from_tools(tools)
    assert list(pool) == ["propose_patch"]
    assert pool["propose_patch"].input_schema.name == "propose_patch.input"
    assert validate_tool_node_consistency(pool, tools) == []

    # 篡改结点池：多一个工具表外类型 + 改坏一个契约形态
    from ink_engine.core.contracts import NodeContract
    from ink_engine.core.schema_validator import SchemaSpec

    tampered = dict(pool)
    tampered["ghost"] = pool["propose_patch"]
    broken = NodeContract(
        input_schema=SchemaSpec(name="propose_patch.input", fields=()),
        output_schema=pool["propose_patch"].output_schema,
        safety_tier=0,
        version=1,
    )
    tampered["propose_patch"] = broken
    issues = validate_tool_node_consistency(tampered, tools)
    assert any("ghost" in i for i in issues)
    assert any("输入契约" in i for i in issues)
