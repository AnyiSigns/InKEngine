"""MCP 集成层 conformance 基线：种子工具声明 ↔ MCP 工具清单形态对账。

跨语言契约文本对齐：``seeds/inkling/seed_data/tools.json`` 是工具声明
的单一事实源（宿主侧清单）；外部 MCP server 列出的工具清单以
``inputSchema``（SDK 1.x 字段）或 ``input_schema``（SDK 2.x 字段）
任一形态呈现——引擎转换后参数 schema 必须逐字保留声明，不得归一为
空壳（参数定义是 LLM 选工具与宿主参数级校验的依据）。

本基线钉住两层契约：
1. 两种字段形态对同一声明产出完全等价的引擎定义（SDK 字段改名不
   能改变契约文本）；
2. 声明的参数 schema 经清单往返逐字保留（跨语言实现的文本对齐）。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from ink_engine.core.mcp_client import convert_mcp_tool

# 种子工具声明（仓库布局：ink_engine/ 与 seeds/ 同级的单一事实源）
_SEED_TOOLS_JSON = (
    Path(__file__).resolve().parents[2] / "seeds" / "inkling" / "seed_data" / "tools.json"
)


def _declared_tools() -> list[dict]:
    """读取种子工具声明（缺失/空清单 = 契约基线失守，直接失败）。"""
    data = json.loads(_SEED_TOOLS_JSON.read_text(encoding="utf-8"))
    tools = data.get("tools")
    assert isinstance(tools, list) and tools, (
        f"种子工具清单 {_SEED_TOOLS_JSON} 为空或形态非法（契约对账基线失守）"
    )
    return tools


def _mcp_listing(tool: dict, *, snake_case: bool) -> dict:
    """声明 → MCP server 清单条目（字段形态由 SDK 版本决定）。"""
    key = "input_schema" if snake_case else "inputSchema"
    return {
        "name": tool["name"],
        "description": tool.get("description") or "",
        key: tool["parameters"],
    }


@pytest.mark.parametrize("snake_case", [False, True], ids=["inputSchema", "input_schema"])
def test_seed_tool_declarations_survive_mcp_listing_roundtrip(snake_case):
    """tools.json 全部声明的参数 schema 经 MCP 清单往返逐字保留。

    回归（SDK 2.x 兼容缺陷）：input_schema 形态的清单在修复前被归一
    为空壳——本断言让「参数定义可见」成为跨语言契约的硬性基线。
    """
    for tool in _declared_tools():
        server_id = tool.get("endpoint_config", {}).get("server_id", "conformance")
        spec = convert_mcp_tool(server_id, _mcp_listing(tool, snake_case=snake_case))
        assert spec.parameters == tool["parameters"], (
            f"工具 {tool['name']} 参数 schema 经 MCP 清单"
            f"（{'input_schema' if snake_case else 'inputSchema'} 形态）"
            f"往返后漂移: {spec.parameters} != {tool['parameters']}"
        )
        assert spec.name == tool["name"]
        assert spec.description == (tool.get("description") or "")


def test_seed_tool_mcp_listing_shapes_are_equivalent():
    """两种字段形态对同一声明产出完全等价的定义（契约文本对齐）。"""
    for tool in _declared_tools():
        server_id = tool.get("endpoint_config", {}).get("server_id", "conformance")
        camel = convert_mcp_tool(server_id, _mcp_listing(tool, snake_case=False))
        snake = convert_mcp_tool(server_id, _mcp_listing(tool, snake_case=True))
        assert camel == snake, f"工具 {tool['name']} 两种清单形态转换结果不等价"
        assert camel.parameters == tool["parameters"]


def test_seed_tool_declarations_are_well_formed_schemas():
    """声明基线形态自检：参数 schema 均为非空对象形态（防对账空转）。

    空壳参数（properties 为空）的声明即使往返不漂移也无契约可言——
    对账测试必须建立在意料中的非空契约文本之上。
    """
    for tool in _declared_tools():
        params = tool["parameters"]
        assert isinstance(params, dict) and params.get("type") == "object"
        assert isinstance(params.get("properties"), dict) and params["properties"], (
            f"工具 {tool['name']} 参数 schema 为空壳（契约基线须为非空参数定义）"
        )
