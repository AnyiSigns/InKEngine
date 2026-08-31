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
from ink_engine.core.tool_vetting import ToolSource, ToolVetting, VettingResult, VettingVerdict


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


class _AcceptVetting(ToolVetting):
    """假 vetting：全量 verified（观察模式接线测试用；shadow_run 继承真实实现）。"""

    async def vet(self, manifest):
        return VettingResult(ok=True, verdict=VettingVerdict.VERIFIED)


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


def test_convert_mcp_tool_reads_snake_case_schema_field():
    """SDK 2.x 字段形态（input_schema）的参数 schema 完整保留。

    回归：修复前只读 inputSchema——SDK 2.x 的 Tool 实例属性是
    input_schema（inputSchema 只是 pydantic 字段别名），所有工具参数
    被归一为空壳，LLM 看不到参数定义、宿主无法参数级校验。
    """
    schema = {
        "type": "object",
        "properties": {"q": {"type": "string"}},
        "required": ["q"],
    }
    dict_spec = convert_mcp_tool("s1", {"name": "t", "description": "d", "input_schema": schema})
    assert dict_spec.parameters == schema

    class _Sdk2Tool:
        name = "t"
        description = "d"
        input_schema = schema

    object_spec = convert_mcp_tool("s1", _Sdk2Tool())
    assert object_spec.parameters == schema


def test_convert_mcp_tool_both_schema_shapes_equivalent():
    """inputSchema 与 input_schema 两形态转换结果完全等价（契约文本对齐）。"""
    schema = {
        "type": "object",
        "properties": {"q": {"type": "string"}},
        "required": ["q"],
    }
    camel = convert_mcp_tool("s1", {"name": "t", "description": "d", "inputSchema": schema})
    snake = convert_mcp_tool("s1", {"name": "t", "description": "d", "input_schema": schema})
    assert camel == snake
    assert camel.parameters == schema


def test_convert_mcp_tool_input_schema_is_primary():
    """SDK 2.x 字段形态（input_schema）优先：同载两形态时以 2.x 为准。"""
    schema_2x = {"type": "object", "properties": {"a": {"type": "string"}}}
    schema_1x = {"type": "object", "properties": {"b": {"type": "string"}}}
    dict_spec = convert_mcp_tool(
        "s1",
        {"name": "t", "description": "d", "inputSchema": schema_1x, "input_schema": schema_2x},
    )
    assert dict_spec.parameters == schema_2x

    class _Tool:
        name = "t"
        description = "d"
        input_schema = schema_2x
        inputSchema = schema_1x

    object_spec = convert_mcp_tool("s1", _Tool())
    assert object_spec.parameters == schema_2x


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


# ── 观察模式接线（E-P4 / ENG6-3：shadow_run 生产调用）──


async def test_import_tools_runs_shadow_observation():
    """挂载流程并入 shadow_run：VERIFIED 工具经影子探针 + 观察证据累积。

    探针 = 空参（无默认值参数不臆造）经影子工作区执行一次远端调用；
    结果恒标记 untrusted（观察数据不作信任依据，只作行为证据），
    :meth:`McpClientManager.shadow_evidence` 可查。
    """
    calls: list = []
    manager = McpClientManager()
    manager.register_session("s1", _FakeSession([_mcp_tool("search")], calls=calls))
    specs = await manager.import_tools("s1", vetting=_AcceptVetting())
    assert [s.name for s in specs] == ["search"]
    # 探针调用经影子工作区执行（空参探针：无默认值参数不臆造）
    assert ("search", {}) in calls
    evidence = manager.shadow_evidence("s1")
    assert "s1:search" in evidence
    assert evidence["s1:search"]["untrusted"] is True
    assert evidence["s1:search"]["ok"] is True
    # 全量查询视角
    assert "s1:search" in manager.shadow_evidence()


async def test_import_tools_shadow_probe_uses_schema_defaults():
    """探针参数派生：只取带默认值的可选字段（不猜测必填参数）。"""
    calls: list = []
    manager = McpClientManager()
    manager.register_session(
        "s1",
        _FakeSession(
            [
                {
                    "name": "search",
                    "description": "搜索",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "q": {"type": "string"},
                            "limit": {"type": "number", "default": 10},
                        },
                    },
                }
            ],
            calls=calls,
        ),
    )
    specs = await manager.import_tools("s1", vetting=_AcceptVetting())
    assert specs[0].name == "search"
    assert ("search", {"limit": 10}) in calls


async def test_import_tools_shadow_failure_records_evidence_only():
    """观察探针失败只记证据（ok=False），不阻断导入（观察不作挂载门禁）。"""

    class _FailingCallSession(_FakeSession):
        async def call_tool(self, name, args):
            raise RuntimeError("远端拒绝探针（必填参数缺失）")

    manager = McpClientManager()
    manager.register_session("s1", _FailingCallSession([_mcp_tool("search")]))
    specs = await manager.import_tools("s1", vetting=_AcceptVetting())
    assert [s.name for s in specs] == ["search"]
    assert manager.shadow_evidence("s1")["s1:search"]["ok"] is False


async def test_import_tools_shadow_workdir_virtualizes_local_writes(tmp_path):
    """提供 shadow_workdir：影子探针在工作目录副本执行，真实目录零触碰。"""
    workdir = tmp_path / "workspace"
    workdir.mkdir()
    (workdir / "keep.txt").write_text("original", encoding="utf-8")
    calls: list = []
    manager = McpClientManager()
    manager.register_session("s1", _FakeSession([_mcp_tool("search")], calls=calls))
    specs = await manager.import_tools("s1", vetting=_AcceptVetting(), shadow_workdir=workdir)
    assert [s.name for s in specs] == ["search"]
    # 远端探针不触碰本地工作区（观察零副作用）
    assert (workdir / "keep.txt").read_text(encoding="utf-8") == "original"


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

def test_http_client_2x_contract():
    """回归（mcp 2.x 适配）：SDK 客户端名为 streamable_http_client，
    签名支持 http_client 注入（headers 经 httpx 客户端注入的 2.x 契约）。
    SDK 缺失时跳过（可选依赖：模块导入与纯函数不受影响）。"""
    import inspect

    pytest.importorskip("mcp")

    from mcp.client.streamable_http import streamable_http_client

    assert callable(streamable_http_client)
    params = set(inspect.signature(streamable_http_client).parameters)
    assert "http_client" in params
    assert "url" in params
    # 2.x 字段形态（is_error/input_schema）为唯一契约
    from mcp.types import CallToolResult, Tool

    assert "is_error" in CallToolResult.model_fields
    assert "input_schema" in Tool.model_fields


async def test_sdk_session_open_wraps_internal_cancellation(monkeypatch):
    """连接被拒的 SDK 内部取消 → 收敛为 McpToolImportError。

    回归：SDK 把连接失败表达为 CancelledError（BaseException，旧
    except Exception 抓不住）——修复前直接穿出宿主，文档承诺「宿主
    只处理一个失败类型」漏出至少两种；现在除外层任务真被取消外一律
    收敛为导入错误。
    """
    import asyncio

    pytest.importorskip("mcp")

    from ink_engine.core.mcp_client import _SdkSession

    class _RefusingClient:
        async def __aenter__(self):
            raise asyncio.CancelledError("连接被拒（SDK 内部取消）")

        async def __aexit__(self, *exc):
            return None

    sdk_mod = sys.modules["mcp.client.streamable_http"]
    monkeypatch.setattr(sdk_mod, "streamable_http_client", lambda url, **kw: _RefusingClient())
    config = McpServerConfig(
        id="refused", transport=McpTransport.HTTP, url="https://mcp.example"
    )
    with pytest.raises(McpToolImportError, match="连接失败"):
        await _SdkSession.open(config)


async def test_sdk_session_open_cleanup_failure_does_not_mask(monkeypatch):
    """清理路径自身抛错不掩盖原始连接失败（原始失败优先，仅记日志）。"""
    pytest.importorskip("mcp")

    import mcp

    from ink_engine.core.mcp_client import _SdkSession

    class _CleanupExplodes:
        async def __aenter__(self):
            return (object(), object())

        async def __aexit__(self, *exc):
            raise RuntimeError("清理失败")

    class _FailingSession:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            raise RuntimeError("连接被拒")

        async def __aexit__(self, *exc):
            return None

    sdk_mod = sys.modules["mcp.client.streamable_http"]
    monkeypatch.setattr(sdk_mod, "streamable_http_client", lambda url, **kw: _CleanupExplodes())
    monkeypatch.setattr(mcp, "ClientSession", _FailingSession)
    config = McpServerConfig(
        id="cleanup", transport=McpTransport.HTTP, url="https://mcp.example"
    )
    with pytest.raises(McpToolImportError, match="连接被拒"):
        await _SdkSession.open(config)


async def test_sdk_session_open_propagates_outer_cancellation(monkeypatch):
    """外层任务真被取消：CancelledError 原样传播（不包装为导入错误）。"""
    import asyncio

    pytest.importorskip("mcp")

    from ink_engine.core.mcp_client import _SdkSession

    started = asyncio.Event()
    release = asyncio.Event()

    class _HangingClient:
        async def __aenter__(self):
            started.set()
            await release.wait()
            return (object(), object())

        async def __aexit__(self, *exc):
            return None

    sdk_mod = sys.modules["mcp.client.streamable_http"]
    monkeypatch.setattr(sdk_mod, "streamable_http_client", lambda url, **kw: _HangingClient())
    config = McpServerConfig(
        id="hang", transport=McpTransport.HTTP, url="https://mcp.example"
    )
    task = asyncio.create_task(_SdkSession.open(config))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


# 探针 server：启动时向 stderr 写结构化日志行（info/error 各一，含请求 id），
# 最小 MCP stdio 形态完成握手——验证执行件 stderr 桥接进引擎日志通道。
_STDERR_PROBE_SERVER = '''\
"""stdio 探针 server：向 stderr 写结构化日志行（桥接验证用）。"""
import asyncio
import json
import sys
from typing import Any

from mcp.server import Server, ServerRequestContext
from mcp.server.stdio import stdio_server
from mcp.types import ListToolsResult, PaginatedRequestParams, Tool


def _log(level: str, method: str, rid: int, ok: bool) -> None:
    payload = {
        "level": level,
        "event": "rpc",
        "method": method,
        "id": rid,
        "duration_ms": 1,
        "ok": ok,
    }
    sys.stderr.write(json.dumps(payload) + "\\n")
    sys.stderr.flush()


async def main() -> None:
    _log("info", "tools/list", 41, True)
    _log("error", "tools/call", 42, False)

    async def list_tools(
        ctx: ServerRequestContext[Any], params: PaginatedRequestParams | None
    ) -> ListToolsResult:
        return ListToolsResult(
            tools=[
                Tool(
                    name="probe",
                    description="探针工具",
                    inputSchema={"type": "object"},
                )
            ]
        )

    server = Server("stderr_probe", on_list_tools=list_tools)
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
'''


async def test_stdio_exec_stderr_forwarded_to_log_channel(tmp_path):
    """stdio 执行件 stderr 结构化日志收敛进引擎日志通道（请求 id + trace_id）。

    执行件把 stderr 当结构化日志通道；宿主捕获后逐行转发进引擎日志——
    执行件日志不再裸露到终端，并随引擎日志通道携带连接期 trace_id；
    行内 level 映射日志等级（error → ERROR 级），非结构化行按 info 落明。
    """
    import asyncio
    import inspect
    import json
    import logging

    pytest.importorskip("mcp")

    from mcp.client.stdio import stdio_client

    from ink_engine.core import mcp_client as module
    from ink_engine.core.logging import JsonFormatter, get_logger, trace_id_var
    from ink_engine.core.mcp_client import _SdkSession

    if "errlog" not in inspect.signature(stdio_client).parameters:
        pytest.skip("mcp SDK 不支持 errlog 定向（stderr 捕获不可用）")

    server_script = tmp_path / "stderr_probe_server.py"
    server_script.write_text(_STDERR_PROBE_SERVER, encoding="utf-8")

    captured: list[str] = []
    exec_logger = get_logger(f"{module.__name__}.exec")
    handler = logging.Handler()
    handler.setFormatter(JsonFormatter())
    handler.setLevel(logging.INFO)
    handler.emit = lambda record: captured.append(handler.format(record))
    exec_logger.addHandler(handler)
    exec_logger.setLevel(logging.INFO)
    token = trace_id_var.set("trace-stdio-01")
    try:
        config = McpServerConfig(
            id="stderr-probe",
            transport=McpTransport.STDIO,
            command=sys.executable,
            args=(str(server_script),),
            source=ToolSource.MARKET,
        )
        handle = await _SdkSession.open(config)
        try:
            await handle.list_tools()
        finally:
            await handle.aclose()
        deadline = asyncio.get_running_loop().time() + 5.0
        while len(captured) < 2 and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)
    finally:
        exec_logger.removeHandler(handler)
        trace_id_var.reset(token)

    assert len(captured) >= 2, f"执行件 stderr 日志未进引擎日志通道: {captured}"
    parsed = [json.loads(line) for line in captured]
    info = next(p for p in parsed if '"method": "tools/list"' in p["msg"])
    error = next(p for p in parsed if '"method": "tools/call"' in p["msg"])
    assert '"id": 41' in info["msg"]
    assert '"id": 42' in error["msg"]
    assert info["trace_id"] == "trace-stdio-01"
    assert error["level"] == "ERROR"
    assert error["logger"] == "ink_engine.core.mcp_client.exec"


def test_builtin_server_registry_covers_tools_json_server_ids():
    """内置 server 注册表：tools.json 13 个 mcp 工具的 server_id 全部有
    Python 侧定义（声明 → 真实连接的对齐落点）。"""
    from ink_engine.core.mcp_client import BUILTIN_MCP_SERVERS

    assert set(BUILTIN_MCP_SERVERS) == {"inkling_exec", "inkling_shell"}
    assert BUILTIN_MCP_SERVERS["inkling_exec"].transport is McpTransport.STDIO
    assert BUILTIN_MCP_SERVERS["inkling_shell"].transport is McpTransport.IN_MEMORY
    for config in BUILTIN_MCP_SERVERS.values():
        assert config.signature  # 连接身份签名齐备（vetting 清单不缺项）


def test_builtin_server_config_overrides_connection_bits_only():
    """内置定义 + 宿主连接位填充：环境相关参数可覆盖，注册表字段不可改。"""
    from ink_engine.core.mcp_client import (
        BUILTIN_MCP_SERVERS,
        builtin_mcp_server_config,
    )

    config = builtin_mcp_server_config(
        "inkling_exec",
        command="C:/bin/inkling_exec.exe",
        args=("serve",),
    )
    assert config is not None
    assert config.id == "inkling_exec"
    assert config.transport is McpTransport.STDIO
    assert config.command == "C:/bin/inkling_exec.exe"
    assert config.args == ("serve",)
    assert config.source is BUILTIN_MCP_SERVERS["inkling_exec"].source
    assert config.signature == "builtin:inkling_exec"

    with pytest.raises(GraphDefinitionError, match="注册表字段不可覆盖"):
        builtin_mcp_server_config("inkling_exec", transport=McpTransport.HTTP)
    with pytest.raises(GraphDefinitionError, match="未知字段"):
        builtin_mcp_server_config("inkling_exec", bogus=1)
    assert builtin_mcp_server_config("ghost-server") is None


async def test_connect_builtin_in_memory_shell_server():
    """connect_builtin：inkling_shell 经内存嵌入工厂建立真实会话。"""
    import asyncio
    import contextlib

    pytest.importorskip("mcp")

    from mcp.server import Server
    from mcp.shared.memory import create_client_server_memory_streams
    from mcp.types import ListToolsResult, PaginatedRequestParams, Tool

    from ink_engine.core.mcp_client import McpClientManager

    async def list_tools(ctx, params: PaginatedRequestParams | None) -> ListToolsResult:
        return ListToolsResult(
            tools=[
                Tool(
                    name="ui_query",
                    description="设备感知",
                    input_schema={"type": "object"},
                )
            ]
        )

    server = Server("inkling_shell", on_list_tools=list_tools)

    @contextlib.asynccontextmanager
    async def server_factory():
        async with create_client_server_memory_streams() as (client_streams, server_streams):
            read, write = server_streams
            task = asyncio.create_task(_run_until_closed(server, read, write))
            try:
                yield client_streams
            finally:
                task.cancel()
                with contextlib.suppress(BaseException):
                    await task

    manager = McpClientManager()
    handle = await manager.connect_builtin(
        "inkling_shell", server_factory=server_factory
    )
    try:
        tools = await handle.list_tools()
        assert len(tools) == 1
        assert tools[0].name == "ui_query"
    finally:
        await handle.aclose()

    # 未定义 server_id → fail-closed 拒绝
    with pytest.raises(McpToolImportError, match="未定义"):
        await manager.connect_builtin("ghost-server")


async def _run_until_closed(server, read, write) -> None:
    try:
        async with write:
            await server.run(read, write, server.create_initialization_options())
    except BaseException:
        pass
