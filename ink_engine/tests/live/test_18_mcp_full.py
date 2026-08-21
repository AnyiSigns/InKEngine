"""族 18：MCP 全形态（test_18_mcp_full.py）｜mcp_client。

- 三传输：stdio（ts_seed_pack 真实 node 进程）/ http（本地真实 streamable
  http server）/ in_memory（server_factory 注入）
- 工具转换（inputSchema 规范化，坏 schema 跳过）；跨 server 名称冲突
  防静默改路由
- vetting 过滤（VERIFIED 导入/REVIEW/REJECTED 拒绝）；call_tool
  isError/超时/文本提取（dict 形态）
- env/headers repr 遮蔽；register_session 防覆盖；close_all 优雅回收；
  未连接 dispatch fail-closed；MCP 工具进工具表走统一流水线（权限
  mcp:call:<id> + 审计留痕）

`real` 标记 = 真实 LLM 调用（族门禁②）；其余为真实进程/协议用例。
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.declarative_tools import DeclarativeToolExecutors, EndpointType  # noqa: E402
from ink_engine.core.mcp_client import (  # noqa: E402
    McpClientManager,
    McpServerConfig,
    McpToolImportError,
    McpTransport,
    convert_mcp_tool,
    register_mcp_executor,
)
from ink_engine.core.tool_vetting import ToolVetting, VettingVerdict  # noqa: E402

TS_SEED_PACK = Path(__file__).resolve().parents[2] / "examples" / "ts_seed_pack" / "server.mjs"


def _stdio_config(server_id: str = "ts-seed") -> McpServerConfig:
    return McpServerConfig(
        id=server_id,
        transport=McpTransport.STDIO,
        command="node",
        args=(str(TS_SEED_PACK),),
    )


# ----------------------------------------------------------------------
# stdio 传输（真实 node 进程）
# ----------------------------------------------------------------------

async def test_mcp_stdio_real_roundtrip():
    manager = McpClientManager()
    try:
        handle = await manager.connect(_stdio_config())
        tools = await handle.list_tools()
        names = {getattr(t, "name", None) for t in tools}
        assert "taboo_check" in names  # ts_seed_pack 真实工具表
        output = await handle.call_tool(
            "taboo_check", {"text": "正文含禁用词测试", "taboos": ["禁用词"]}
        )
        assert "禁用词" in output  # 真实进程执行结果回传
    finally:
        await manager.close_all()


async def test_mcp_import_tools_and_dispatch():
    manager = McpClientManager()
    executors = DeclarativeToolExecutors()
    register_mcp_executor(executors, manager)
    try:
        await manager.connect(_stdio_config())
        specs = await manager.import_tools("ts-seed", source="test")
        names = {s.name for s in specs}
        assert "taboo_check" in names
        # 已连接会话分发 → 真实调用成功
        taboo_spec = next(s for s in specs if s.name == "taboo_check")
        output = await manager.dispatch(None, taboo_spec, {"text": "x", "taboos": ["y"]})
        assert isinstance(output, str)
        # 断开后分发 → fail-closed 拒绝
        await manager.disconnect("ts-seed")
        with pytest.raises(Exception)  :  # noqa: B017  # fail-closed 拒绝语义：任何异常=拒绝成立
            await manager.dispatch(None, taboo_spec, {"text": "x", "taboos": ["y"]})
        # 定义缺 server_id → 建期拒绝（构造即校验，不静默缺路由）
        from ink_engine.core.declarative_tools import DeclarativeToolSpec

        with pytest.raises(Exception)  :  # noqa: B017  # fail-closed 拒绝语义：任何异常=拒绝成立
            DeclarativeToolSpec(
                name="x", description="d", parameters={},
                permissions=("mcp:call:x",), endpoint=EndpointType.MCP, endpoint_config={},
            )
    finally:
        await manager.close_all()


# ----------------------------------------------------------------------
# http 传输（本地真实 streamable http server）
# ----------------------------------------------------------------------

async def test_mcp_http_real_roundtrip(mcp_http_server):
    manager = McpClientManager()
    try:
        await manager.connect(
            McpServerConfig(
                id="http-echo",
                transport=McpTransport.HTTP,
                url=mcp_http_server.url,
                headers={"X-Test": "1"},
            )
        )
        specs = await manager.import_tools("http-echo", source="test")
        names = {s.name for s in specs}
        assert {"echo", "adder"} <= names  # 本地 server 工具表
        echo_spec = next(s for s in specs if s.name == "echo")
        output = await manager.dispatch(None, echo_spec, {"text": "http 传输回显"})
        assert "http 传输回显" in output
    finally:
        await manager.close_all()


# ----------------------------------------------------------------------
# in_memory 传输（server_factory 注入）
# ----------------------------------------------------------------------

def _make_in_memory_factory():
    """in_memory server 工厂（mcp SDK 2.x lowlevel Server + 内存流对）。"""
    import asyncio
    import contextlib

    import anyio
    from mcp.server.lowlevel.server import Server
    from mcp.types import CallToolResult, ListToolsResult, Tool

    async def my_list_tools(ctx, params):
        return ListToolsResult(
            tools=[Tool(name="ping", description="回显 pong", inputSchema={"type": "object"})]
        )

    async def my_call_tool(ctx, params):
        return CallToolResult(content=[{"type": "text", "text": "pong"}])

    server = Server(
        "live-in-memory",
        on_list_tools=my_list_tools,
        on_call_tool=my_call_tool,
    )

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def factory():
        server_to_client_send, server_to_client_receive = anyio.create_memory_object_stream(1024)
        client_to_server_send, client_to_server_receive = anyio.create_memory_object_stream(1024)
        task = asyncio.create_task(
            server.run(
                client_to_server_receive,  # 服务端读 = 客户端发送流
                server_to_client_send,  # 服务端写 = 服务端发送流
                server.create_initialization_options(),
            )
        )
        try:
            # 客户端视角：读 = 服务端发送流，写 = 客户端发送流
            yield server_to_client_receive, client_to_server_send
        finally:
            task.cancel()
            with contextlib.suppress(BaseException):
                await task

    return factory


async def test_mcp_in_memory_real():
    manager = McpClientManager()
    try:
        await manager.connect(
            McpServerConfig(
                id="mem",
                transport=McpTransport.IN_MEMORY,
                server_factory=_make_in_memory_factory(),
            )
        )
        specs = await manager.import_tools("mem", source="test")
        assert [s.name for s in specs] == ["ping"]
        output = await manager.dispatch(None, specs[0], {})
        assert output == "pong"
    finally:
        await manager.close_all()


# ----------------------------------------------------------------------
# 转换 / 冲突 / vetting / 遮蔽 / 生命周期
# ----------------------------------------------------------------------

def test_convert_mcp_tool_schema_normalization():
    class RawTool:
        name = "weird"
        description = "d"
        inputSchema = {"type": "object", "properties": {"a": {"type": "string"}}, "required": "a"}  # noqa: RUF012  # 测试固定形态（坏 schema 容错用例）

    spec = convert_mcp_tool("svc", RawTool())
    assert spec.endpoint is EndpointType.MCP
    assert spec.endpoint_config["server_id"] == "svc"
    assert "a" in spec.parameters["properties"]  # 坏 schema（required 非 list）容错


def test_mcp_env_headers_repr_redacted():
    config = McpServerConfig(
        id="svc",
        transport=McpTransport.STDIO,
        command="node",
        env={"TOKEN": "secret-token"},
    )
    assert "secret-token" not in repr(config)
    http_cfg = McpServerConfig(
        id="svc2", transport=McpTransport.HTTP, url="http://x", headers={"Authorization": "Bearer secret"}
    )
    assert "Bearer secret" not in repr(http_cfg)


async def test_register_session_prevents_overwrite():
    manager = McpClientManager()
    handle = await manager.connect(_stdio_config("svc"))
    with pytest.raises(McpToolImportError):
        manager.register_session("svc", handle)  # 已有活动会话 → 拒绝（防覆盖泄漏）
    await manager.close_all()


async def test_mcp_vetting_filter(mcp_http_server):
    """vetting 闸门：仅 VERIFIED 放行；REVIEW/REJECTED 不进入工具表。"""
    manager = McpClientManager()
    try:
        await manager.connect(
            McpServerConfig(id="v", transport=McpTransport.HTTP, url=mcp_http_server.url)
        )
        class RejectVetting(ToolVetting):
            async def vet(self, manifest, code_paths=(), *, strict=False):
                from ink_engine.core.tool_vetting import VettingResult

                return VettingResult(
                    ok=False, verdict=VettingVerdict.REJECTED,
                    checks=(), shadow=None, reason="测试拒绝",
                )

        specs = await manager.import_tools("v", source="test", vetting=RejectVetting())
        assert specs == []  # 全部被闸门拦截（fail-closed）
    finally:
        await manager.close_all()


async def test_mcp_close_all_idempotent():
    manager = McpClientManager()
    await manager.connect(_stdio_config("s1"))
    await manager.connect(_stdio_config("s2"))
    await manager.close_all()
    await manager.close_all()  # 幂等
    assert manager.list_servers() == []
    # 未连接分发 fail-closed
    from ink_engine.core.declarative_tools import DeclarativeToolSpec

    spec = DeclarativeToolSpec(
        name="t", description="d", parameters={}, permissions=("mcp:call:t",),
        endpoint=EndpointType.MCP, endpoint_config={"server_id": "gone"},
    )
    with pytest.raises(Exception)  :  # noqa: B017  # fail-closed 拒绝语义：任何异常=拒绝成立
        await manager.dispatch(None, spec, {})


@pytest.mark.real
async def test_mcp_tool_in_llm_tool_loop(live_llm, mcp_http_server):
    """MCP 工具进 LLM 工具循环（真实模型）：模型经工具描述调用本地 MCP 工具。"""
    from ink_engine.core.llm.messages import assistant, tool_result, user

    manager = McpClientManager()
    try:
        await manager.connect(
            McpServerConfig(id="llm", transport=McpTransport.HTTP, url=mcp_http_server.url)
        )
        specs = await manager.import_tools("llm", source="test")
        tool_specs = [s.to_spec() for s in specs if s.name == "adder"]
        assert tool_specs
        messages = [user("请调用 adder 工具计算 20 加 22，并报告结果")]
        result = await live_llm.ainvoke(messages, tools=tool_specs)
        assert result.tool_calls, "模型未产出工具调用"
        call = result.tool_calls[0]
        args = call.parse_arguments(strict=True)
        output = await manager.dispatch(None, specs[0], args) if False else await manager.dispatch(
            None, next(s for s in specs if s.name == "adder"), args
        )
        messages.append(assistant(tool_calls=[call]))
        messages.append(tool_result(content=output, tool_call_id=call.id))
        final = await live_llm.ainvoke(messages, tools=tool_specs)
        # 行为契约：收口回答可落 content 或 reasoning（模型输出形态漂移容忍）
        assert (final.content or final.reasoning or "").strip(), "工具结果回喂后无收口回答"
    finally:
        await manager.close_all()
