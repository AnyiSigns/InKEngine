"""e2e MCP fixture server：最小可离线的 MCP server（三传输共用）。

覆盖形态（mcp SDK 2.x 官方 Server API）：
- stdio：``python mcp_fixture_server.py --stdio`` 子进程运行；
- in_memory：``build_server()`` 实例 + 宿主 ``in_memory_server_factory``；
- http：``build_server().streamable_http_app``（uvicorn 承载）。

工具集：echo/add（通用传输闭环）+ 七个研究工具（与 tools.json 领域
工具名同源，挂载为 ``inkling_exec`` 时回合计划可全绿执行；输出为
确定性 canned 结果，离线可复现）。
"""
from __future__ import annotations

import asyncio
from typing import Any

from mcp.server import Server, ServerRequestContext
from mcp.server.stdio import stdio_server
from mcp.types import (
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool,
)

SERVER_NAME = "inkling_fixture"

_TOOL_DEFS: tuple[dict[str, Any], ...] = (
    {
        "name": "echo",
        "description": "回声工具：原样返回消息（传输闭环冒烟）",
        "inputSchema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
    },
    {
        "name": "add",
        "description": "加法工具：返回两数之和（参数校验冒烟）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "a": {"type": "number"},
                "b": {"type": "number"},
            },
            "required": ["a", "b"],
        },
    },
    {
        "name": "collect_material",
        "description": "采集研究材料（文本/URL 取回）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "text": {"type": "string"},
            },
            "required": [],
        },
    },
    {
        "name": "parse_material",
        "description": "解析材料：结构化抽取",
        "inputSchema": {
            "type": "object",
            "properties": {"material": {"type": "object"}},
            "required": ["material"],
        },
    },
    {
        "name": "validate_material",
        "description": "校验材料/知识条目：按规则谓词评估",
        "inputSchema": {
            "type": "object",
            "properties": {"data": {"type": "object"}},
            "required": ["data"],
        },
    },
    {
        "name": "score_material",
        "description": "评分：引用质量/交叉验证维度打分",
        "inputSchema": {
            "type": "object",
            "properties": {"material": {"type": "object"}},
            "required": ["material"],
        },
    },
    {
        "name": "review_material",
        "description": "评审：按维度/阈值打分与改进意见",
        "inputSchema": {
            "type": "object",
            "properties": {"candidates": {"type": "array"}},
            "required": ["candidates"],
        },
    },
    {
        "name": "distill_knowledge",
        "description": "蒸馏：信号序列 → 结构化知识数据",
        "inputSchema": {
            "type": "object",
            "properties": {"signals": {"type": "array"}},
            "required": ["signals"],
        },
    },
    {
        "name": "mutate_knowledge",
        "description": "变异：按失败日志生成知识条目变体",
        "inputSchema": {
            "type": "object",
            "properties": {
                "entry": {"type": "object"},
                "failure_logs": {"type": "array"},
            },
            "required": ["entry", "failure_logs"],
        },
    },
)


def build_server() -> Server:
    """构建 fixture server（in_memory/http 形态复用同一实例构造）。"""
    tools = [Tool(**definition) for definition in _TOOL_DEFS]

    async def list_tools(
        ctx: ServerRequestContext[Any], params: PaginatedRequestParams | None
    ) -> ListToolsResult:
        return ListToolsResult(tools=tools)

    async def call_tool(
        ctx: ServerRequestContext[Any], params: CallToolRequestParams
    ) -> CallToolResult:
        return _handle_call(params.name, params.arguments or {})

    return Server(
        SERVER_NAME,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


def build_echo_server() -> Server:
    """单工具 fixture server（挂载/回退成对用例的最小形态）。"""
    tools = [Tool(**_TOOL_DEFS[0])]

    async def list_tools(
        ctx: ServerRequestContext[Any], params: PaginatedRequestParams | None
    ) -> ListToolsResult:
        return ListToolsResult(tools=tools)

    async def call_tool(
        ctx: ServerRequestContext[Any], params: CallToolRequestParams
    ) -> CallToolResult:
        return _handle_call(params.name, params.arguments or {})

    return Server(
        "inkling_fixture_echo",
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


def _text(message: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=message)])


def _error(message: str) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=message)], isError=True
    )


def _handle_call(name: str, args: dict[str, Any]) -> CallToolResult:
    """确定性工具实现（离线可复现；参数缺失 = 明确错误，不崩溃）。"""
    if name == "echo":
        return _text(f"echo: {args.get('message', '')}")
    if name == "add":
        try:
            total = float(args["a"]) + float(args["b"])
        except (KeyError, TypeError, ValueError) as exc:
            return _error(f"add 参数非法: {exc}")
        return _text(str(total))
    if name == "collect_material":
        text = str(args.get("text") or args.get("url") or "默认材料")
        return _text(
            f'{{"title": "材料标题", "text": "{text}", "source": "web"}}'
        )
    if name == "parse_material":
        return _text('{"title": "解析标题", "points": ["要点一", "要点二"]}')
    if name == "validate_material":
        return _text('{"violations": [], "passed": true}')
    if name == "score_material":
        return _text(
            '{"citation_quality": 0.8, "cross_validation": 0.8,'
            ' "consistency": 0.8, "readability": 0.8}'
        )
    if name == "review_material":
        return _text('{"score": 0.85, "passed": true, "feedback": "通过"}')
    if name == "distill_knowledge":
        return _text(
            '{"kind": "rule", "data": {"rule": {"message": "蒸馏产物规则"}}}'
        )
    if name == "mutate_knowledge":
        return _text('{"variants": [{"id": "v1"}]}')
    return _error(f"未知工具: {name}")


async def _run_stdio() -> None:
    """stdio 传输运行（子进程形态；引擎 stdio_client 直连）。"""
    server = build_server()
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(_run_stdio())
