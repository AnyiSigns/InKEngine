"""MCP 客户端适配器单测：工具转换 / 端点推导 / 连接管理 / vetting 闸门 / 惰性引入。

覆盖：MCP 工具 → 声明式定义（权限/端点/路由密钥）、输入 schema 规范化、
缺 name 拒绝；endpoint_operation 对 MCP 返回 (call, server_id) 且缺失
路由密钥 fail-closed；McpServerConfig 序列化往返与非法拒绝；管理器
导入/分发/断开（含未连接与会话缺失的拒绝路径）；vetting 闸门过滤被拒
工具；``mcp`` SDK 缺失时连接路径显式报错（模块导入与纯函数不受影响）。
"""
from __future__ import annotations

import sys

import pytest

from ink_engine.core.declarative_tools import (
    DeclarativeToolExecutors,
    DeclarativeToolSpec,
    EndpointType,
    endpoint_operation,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.mcp_client import (
    McpClientManager,
    McpServerConfig,
    McpToolImportError,
    McpTransport,
    build_mcp_manifest,
    convert_mcp_tool,
    register_mcp_executor,
)
from ink_engine.core.tool_vetting import ToolSource, VettingResult, VettingVerdict


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


class _RejectVetting:
    """假 vetting：按工具名集合拒绝，其余 verified（验证过滤语义）。"""

    def __init__(self, reject_names=()) -> None:
        self.reject_names = set(reject_names)

    async def vet(self, manifest):
        ok = manifest.name not in self.reject_names
        verdict = VettingVerdict.VERIFIED if ok else VettingVerdict.REJECTED
        return VettingResult(
            ok=ok,
            verdict=verdict,
            reason="" if ok else "被测试桩拒绝",
        )


def _mcp_tool(name="search", schema=None):
    return {
        "name": name,
        "description": "搜索工具",
        "inputSchema": schema
        or {"type": "object", "properties": {"q": {"type": "string"}}},
    }


def test_convert_mcp_tool_maps_fields():
    """MCP 工具 → 声明式定义：端点 MCP、路由密钥 server_id、按 server 权限。"""
    spec = convert_mcp_tool("s1", _mcp_tool())
    assert spec.name == "search"
    assert spec.endpoint is EndpointType.MCP
    assert spec.endpoint_config == {"server_id": "s1"}
    assert spec.permissions == ("mcp:call:s1",)
    assert spec.parameters["properties"] == {"q": {"type": "string"}}


def test_convert_mcp_tool_accepts_object_form():
    """鸭子类型：MCP SDK Tool 对象（非 dict）同样可转。"""

    class _Tool:
        name = "t"
        description = "d"
        inputSchema = None

    spec = convert_mcp_tool("s2", _Tool())
    assert spec.name == "t"
    assert spec.endpoint_config == {"server_id": "s2"}


def test_convert_mcp_tool_missing_name_rejected():
    """缺 name（协议违规）→ 定义期拒绝。"""
    with pytest.raises(GraphDefinitionError, match="缺 name"):
        convert_mcp_tool("s1", {"description": "无名字工具"})


def test_convert_normalizes_broken_schema():
    """非对象 schema 归一为空对象 schema（不重写语义、不死）。"""
    spec = convert_mcp_tool("s1", _mcp_tool(schema={"type": "string"}))
    assert spec.parameters == {"type": "object", "properties": {}}
    spec2 = convert_mcp_tool("s1", {"name": "x", "description": "d", "inputSchema": None})
    assert spec2.parameters == {"type": "object", "properties": {}}


def test_endpoint_operation_mcp_routes_by_server_id():
    """endpoint_operation 对 MCP 返回 (call, server_id)。"""
    assert endpoint_operation(
        EndpointType.MCP, {}, config={"server_id": "s9"}
    ) == ("call", "s9")


def test_endpoint_operation_mcp_missing_server_id_fails_closed():
    """MCP 缺路由密钥 → None（无法路由，流水线 fail-closed 拒绝）。"""
    assert endpoint_operation(EndpointType.MCP, {}, config={}) is None
    assert endpoint_operation(EndpointType.MCP, {}, config=None) is None


def test_server_config_roundtrip_and_validation():
    """McpServerConfig 序列化往返；缺 id / 非法传输 / 非法来源拒绝。"""
    cfg = McpServerConfig(
        id="svc",
        transport=McpTransport.STDIO,
        command="node",
        args=("srv.js",),
        source=ToolSource.GITHUB,
    )
    restored = McpServerConfig.from_dict(cfg.to_dict())
    assert restored == cfg
    assert restored.transport is McpTransport.STDIO
    with pytest.raises(GraphDefinitionError, match="缺 id"):
        McpServerConfig.from_dict({"transport": "http"})
    with pytest.raises(GraphDefinitionError, match="传输形态非法"):
        McpServerConfig.from_dict({"id": "x", "transport": "ftp"})
    with pytest.raises(GraphDefinitionError, match="来源分类非法"):
        McpServerConfig.from_dict({"id": "x", "source": "mars"})


def test_build_mcp_manifest_derives_signature():
    """清单签名由 server 身份派生（证明工具出自已审批连接）。"""
    manifest = build_mcp_manifest("s1", _mcp_tool(), source=ToolSource.MARKET)
    assert manifest.name == "search"
    assert manifest.source is ToolSource.MARKET
    assert manifest.signature == "mcp:s1:search"
    assert manifest.permissions == ("mcp:call:s1",)


async def test_manager_import_without_vetting():
    """未提供 vetting：导入全部工具为声明式定义。"""
    manager = McpClientManager()
    manager.register_session("s1", _FakeSession([_mcp_tool("a"), _mcp_tool("b")]))
    specs = await manager.import_tools("s1")
    assert {s.name for s in specs} == {"a", "b"}
    assert all(s.endpoint is EndpointType.MCP for s in specs)


async def test_manager_import_filters_rejected_by_vetting():
    """提供 vetting：被拒工具不进入工具表（fail-closed 不静默放行）。"""
    manager = McpClientManager()
    manager.register_session("s1", _FakeSession([_mcp_tool("a"), _mcp_tool("b")]))
    specs = await manager.import_tools("s1", vetting=_RejectVetting(reject_names={"b"}))
    assert {s.name for s in specs} == {"a"}


async def test_manager_dispatch_routes_to_session():
    """分发执行器按 server_id 反查会话转发调用。"""
    calls: list = []
    manager = McpClientManager()
    manager.register_session("s1", _FakeSession([], calls=calls))
    spec = convert_mcp_tool("s1", _mcp_tool("search"))
    result = await manager.dispatch(None, spec, {"q": "hi"})
    assert result == "result-of-search"
    assert calls == [("search", {"q": "hi"})]


async def test_manager_dispatch_unknown_server_fails_closed():
    """未挂载 server 的调用 → fail-closed 拒绝。"""
    manager = McpClientManager()
    spec = convert_mcp_tool("ghost", _mcp_tool("search"))
    with pytest.raises(GraphDefinitionError, match="未连接"):
        await manager.dispatch(None, spec, {})


async def test_manager_import_unconnected_raises():
    """未连接 server 的导入 → McpToolImportError。"""
    manager = McpClientManager()
    with pytest.raises(McpToolImportError, match="未连接"):
        await manager.import_tools("nope")


async def test_manager_disconnect_missing_returns_false():
    """断开不存在的 server 返回 False（不抛错）。"""
    manager = McpClientManager()
    assert await manager.disconnect("absent") is False


def test_endpoint_config_requirement_enforced_at_definition():
    """MCP 端点缺 server_id 在定义期被拒绝（_ENDPOINT_CONFIG_REQUIREMENTS）。"""
    with pytest.raises(GraphDefinitionError, match="server_id"):
        DeclarativeToolSpec(
            name="t",
            description="d",
            parameters={"type": "object", "properties": {}},
            permissions=("mcp:call:s1",),
            endpoint=EndpointType.MCP,
            endpoint_config={},
        )


def test_register_mcp_executor_plugs_into_declarative():
    """register_mcp_executor 把 MCP 分发器注册进声明式执行体注册表。"""
    executors = DeclarativeToolExecutors()
    manager = McpClientManager()
    register_mcp_executor(executors, manager)
    assert executors.has(EndpointType.MCP)


def test_require_mcp_missing_reports_install_hint(monkeypatch):
    """mcp SDK 不可引入时连接路径显式报错并给安装提示。

    以 ``sys.modules["mcp"] = None`` 模拟缺失（解释器对 None 槽位直接
    ImportError），无论真实环境是否安装 SDK 测试语义一致。
    """
    monkeypatch.setitem(sys.modules, "mcp", None)
    from ink_engine.core import mcp_client

    with pytest.raises(RuntimeError, match="pip install mcp"):
        mcp_client._require_mcp()


async def test_manager_disconnect_existing_session_returns_true_and_closes():
    """断开已登记会话：返回 True 且句柄被关闭（生命周期闭环）。"""
    closed: list = []

    class _TrackingSession(_FakeSession):
        async def aclose(self) -> None:
            closed.append(True)

    manager = McpClientManager()
    manager.register_session("s1", _TrackingSession([]))
    assert await manager.disconnect("s1") is True
    assert closed == [True]
    assert "s1" not in manager._sessions


async def test_manager_import_skips_malformed_tools():
    """协议违规工具（缺 name）逐项跳过并保留合法项，不击穿整次导入。"""
    manager = McpClientManager()
    manager.register_session(
        "s1",
        _FakeSession(
            [_mcp_tool("ok"), {"description": "无名工具"}, _mcp_tool("ok2")]
        ),
    )
    specs = await manager.import_tools("s1")
    assert {s.name for s in specs} == {"ok", "ok2"}


async def test_manager_import_review_verdict_fails_closed():
    """vetting 返回 REVIEW（静态审查待人工确认）同样不进入工具表。"""

    class _ReviewVetting:
        async def vet(self, manifest):
            return VettingResult(
                ok=True, verdict=VettingVerdict.REVIEW, reason="静态审查命中"
            )

    manager = McpClientManager()
    manager.register_session("s1", _FakeSession([_mcp_tool("a")]))
    specs = await manager.import_tools("s1", vetting=_ReviewVetting())
    assert specs == []


async def test_manager_dispatch_propagates_session_error():
    """会话执行异常透传为失败（不伪装成成功文本）。"""

    class _BrokenSession:
        async def list_tools(self):
            return []

        async def call_tool(self, name, args):
            raise RuntimeError("远端炸了")

        async def aclose(self) -> None:
            return None

    manager = McpClientManager()
    manager.register_session("s1", _BrokenSession())
    spec = convert_mcp_tool("s1", _mcp_tool("search"))
    with pytest.raises(RuntimeError, match="远端炸了"):
        await manager.dispatch(None, spec, {})


def test_server_config_from_dict_rejects_non_dict():
    """非 dict 配置形态在反序列化处显式拒绝。"""
    with pytest.raises(GraphDefinitionError, match="期望 dict"):
        McpServerConfig.from_dict(["id", "x"])


def test_server_config_env_malformed_rejected():
    """env 非 dict 形态显式拒绝（不落入子进程环境构造）。"""
    with pytest.raises(GraphDefinitionError, match="env 须为 dict"):
        McpServerConfig.from_dict({"id": "x", "env": "PATH=abc"})


def test_server_config_headers_roundtrip():
    """http 请求头（鉴权场景）序列化往返完整。"""
    cfg = McpServerConfig(
        id="svc",
        transport=McpTransport.HTTP,
        url="https://mcp.example",
        headers={"Authorization": "Bearer t"},
        source=ToolSource.MARKET,
        signature="signed-by-market",
    )
    restored = McpServerConfig.from_dict(cfg.to_dict())
    assert restored == cfg


def test_server_config_env_repr_masked():
    """env 遮蔽自 repr：日志/调试输出不泄漏子进程凭据。"""
    cfg = McpServerConfig(
        id="svc", transport=McpTransport.STDIO, command="node", env={"TOKEN": "secret"}
    )
    assert "TOKEN" not in repr(cfg)
    assert "secret" not in repr(cfg)


async def test_manager_register_session_duplicate_rejected():
    """已有活动会话时再次登记显式拒绝（防覆盖不关闭的泄漏）。"""
    manager = McpClientManager()
    manager.register_session("s1", _FakeSession([]))
    with pytest.raises(McpToolImportError, match="已有活动会话"):
        manager.register_session("s1", _FakeSession([]))


async def test_manager_close_all_releases_sessions():
    """close_all 幂等释放全部会话（单个关闭失败不阻断其余）。"""
    closed: list[str] = []

    class _NamedSession(_FakeSession):
        def __init__(self, label):
            super().__init__([])
            self.label = label

        async def aclose(self) -> None:
            closed.append(self.label)

    manager = McpClientManager()
    manager.register_session("a", _NamedSession("a"))
    manager.register_session("b", _NamedSession("b"))
    await manager.close_all()
    assert sorted(closed) == ["a", "b"]
    assert manager._sessions == {}
    await manager.close_all()  # 幂等：空表再关不报错


def test_extract_text_handles_dict_content_items():
    """内容项 dict 形态（JSON 往返的代理/桩）文本仍被提取。"""
    from ink_engine.core.mcp_client import _extract_text

    class _Result:
        def __init__(self, content) -> None:
            self.content = content

    assert (
        _extract_text(
            _Result([{"type": "text", "text": "你好"}, {"type": "text", "text": 42}])
        )
        == "你好\n42"
    )
