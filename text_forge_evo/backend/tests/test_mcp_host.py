"""MCP 宿主接线单测：挂载把外部工具注册进引擎工具表并可经统一流水线分发。

不依赖 mcp SDK：以假会话注入模拟 server 连接，验证宿主装配的
``register_mcp_executor`` + 声明式注册表接线（``connect`` 路径 mocked，
真实 SDK 连接属集成测试，未安装 SDK 时不阻塞单测）。
"""
from __future__ import annotations

import pytest
from ink_engine.core.mcp_client import (
    McpServerConfig,
    McpToolImportError,
    McpTransport,
)
from ink_engine.core.tool_vetting import ToolSource

from app import boot


class _FakeSession:
    """测试桩会话：实现 list_tools / call_tool，记录调用便于断言。"""

    def __init__(self, tools, calls=None) -> None:
        self._tools = tools
        self.calls = calls if calls is not None else []

    async def list_tools(self):
        return list(self._tools)

    async def call_tool(self, name, args):
        self.calls.append((name, args))
        return f"result-of-{name}"

    async def aclose(self) -> None:
        return None


def _mcp_tool(name="a"):
    return {
        "name": name,
        "description": "外部工具",
        "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}},
    }


def _fake_connect(app, tool_names):
    """注入假会话（旁路真实 SDK 连接），返回新登记的会话句柄。

    与真实 connect 同语义：已登记同 id 会话时先关闭旧会话再建新，
    （重挂载场景的会话替换）。"""
    from ink_engine.core.mcp_client import McpClientManager

    manager: McpClientManager = app.mcp_manager

    async def connect(config):
        manager._sessions.pop(config.id, None)
        session = _FakeSession([_mcp_tool(tool_name) for tool_name in tool_names])
        manager.register_session(config.id, session)
        return session

    return connect


async def test_mount_registers_tools_and_dispatches(monkeypatch) -> None:
    app = await boot.init_app()

    # 旁路 connect（需 SDK）：直接注入假会话模拟已连接 server
    monkeypatch.setattr(
        app.mcp_manager, "connect", _fake_connect(app, ["a", "b"])
    )

    config = McpServerConfig(
        id="s1", transport=McpTransport.HTTP, url="http://x", source=ToolSource.MARKET
    )
    tools = await app.mount_mcp_server(config)
    assert set(tools) == {"a", "b"}
    # 注册进动态工具表（inspect_tools 可见、回合可调用）
    assert "a" in app.tool_registry
    assert "b" in app.tool_registry
    # 挂载后回合引擎重建（模型工具清单随挂载刷新）
    assert app.engine is not None

    # 经宿主统一声明式执行体分发（MCP executor 已注册）
    spec = app.harness_registry.declarative.definitions["a"]
    calls: list = []
    app.mcp_manager._sessions["s1"].calls = calls
    result = await app.harness_registry.declarative.dispatch(None, spec, {"q": "hi"})
    assert result == "result-of-a"
    assert calls == [("a", {"q": "hi"})]

    # 卸载：会话注销 + 工具定义撤出动态表（防失效工具滞留给模型）
    assert await app.unmount_mcp_server("s1") is True
    assert "s1" not in app.mcp_manager._sessions
    assert "a" not in app.tool_registry
    assert "b" not in app.tool_registry
    assert "a" not in app.harness_registry.declarative.definitions


async def test_remount_same_server_refreshes_stale_tools(monkeypatch) -> None:
    """同 server 重挂载：工具集变化时陈旧工具撤出，新工具生效。"""
    app = await boot.init_app()
    monkeypatch.setattr(
        app.mcp_manager, "connect", _fake_connect(app, ["a", "b"])
    )
    config = McpServerConfig(id="s1", url="http://x", source=ToolSource.MARKET)
    await app.mount_mcp_server(config)
    assert {"a", "b"} <= set(app.tool_registry)

    # 重挂载（工具集变为 a/c）：b 撤出、c 进入、a 覆写自同 server
    monkeypatch.setattr(
        app.mcp_manager, "connect", _fake_connect(app, ["a", "c"])
    )
    tools = await app.mount_mcp_server(config)
    assert set(tools) == {"a", "c"}
    assert "b" not in app.tool_registry
    assert "b" not in app.harness_registry.declarative.definitions
    assert "a" in app.tool_registry
    assert "c" in app.tool_registry


async def test_mount_cross_server_name_collision_rejected(monkeypatch) -> None:
    """跨 server 同名工具挂载拒绝（fail-closed）：静默覆盖会把调用
    路由到错误的 server，连接同步回滚断开。"""
    app = await boot.init_app()
    monkeypatch.setattr(
        app.mcp_manager, "connect", _fake_connect(app, ["shared"])
    )
    first = McpServerConfig(id="s1", url="http://x", source=ToolSource.MARKET)
    await app.mount_mcp_server(first)

    monkeypatch.setattr(
        app.mcp_manager, "connect", _fake_connect(app, ["shared"])
    )
    second = McpServerConfig(id="s2", url="http://y", source=ToolSource.MARKET)
    with pytest.raises(McpToolImportError, match="工具名冲突"):
        await app.mount_mcp_server(second)
    # 冲突挂载回滚：s2 连接被断开，s1 的工具定义保持原样
    assert "s2" not in app.mcp_manager._sessions
    assert app.harness_registry.declarative.definitions["shared"].endpoint_config[
        "server_id"
    ] == "s1"


async def test_mount_import_failure_rolls_back_connection(monkeypatch) -> None:
    """导入失败时已建立的连接回滚断开（不泄漏悬会话）。"""
    app = await boot.init_app()

    async def connect_then_fail(config):
        app.mcp_manager.register_session(
            config.id, _FakeSession([_mcp_tool("x")])
        )

    async def failing_import(server_id, *, source=None, vetting=None):
        raise McpToolImportError("导入失败")

    monkeypatch.setattr(app.mcp_manager, "connect", connect_then_fail)
    monkeypatch.setattr(app.mcp_manager, "import_tools", failing_import)
    config = McpServerConfig(id="s1", url="http://x")
    with pytest.raises(McpToolImportError, match="导入失败"):
        await app.mount_mcp_server(config)
    assert "s1" not in app.mcp_manager._sessions
    assert "x" not in app.tool_registry
