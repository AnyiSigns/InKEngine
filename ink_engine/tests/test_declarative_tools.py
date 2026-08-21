"""声明式工具创建单测：强制权限/端点类型/操作推导/执行体分发/流水线集成。

语义检查点：注册新工具 = 声明一条数据（name/description/参数 schema/
强制权限/端点类型），执行体经注册表分发（宿主注入）；未声明权限 =
定义期拒绝（fail-closed 提前到建表期）；端点类型与沙箱守卫联动
（判定目标推导供门禁/沙箱环节消费）；声明式工具过完整流水线（门禁 →
沙箱 → 守卫 → 审批 → 审计 → 轨迹）。
"""
from __future__ import annotations

import os

import pytest

from ink_engine.core.declarative_tools import (
    DeclarativeToolExecutors,
    DeclarativeToolSpec,
    EndpointType,
    build_declarative_pipeline,
    endpoint_operation,
    make_declarative_extractor,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.tool_orchestrator import ToolTraceStore
from ink_engine.core.tool_pipeline import ToolPipeline


def _declarative(endpoint: EndpointType = EndpointType.HTTP_FETCH, **kw) -> DeclarativeToolSpec:
    base = {
        "name": "my_tool",
        "description": "声明式工具",
        "parameters": {"type": "object", "properties": {"url": {"type": "string"}}},
        "permissions": ("network:connect:*.example.com",),
        "endpoint": endpoint,
    }
    base.update(kw)
    return DeclarativeToolSpec(**base)


def test_missing_permissions_rejected():
    """强制权限声明：permissions 缺失/为空 → 定义期拒绝（fail-closed）。"""
    with pytest.raises(GraphDefinitionError, match="必须声明权限"):
        DeclarativeToolSpec(
            name="t", description="d", parameters={}, permissions=()
        )


def test_invalid_permission_rejected():
    """非法权限声明形态 → 定义期拒绝。"""
    with pytest.raises(GraphDefinitionError, match="权限声明非法"):
        _declarative(permissions=("not-a-valid-permission",))


def test_invalid_endpoint_rejected():
    """未知端点类型 → 定义期拒绝。"""
    with pytest.raises(GraphDefinitionError, match="端点类型非法"):
        _declarative(endpoint="unknown_endpoint")  # type: ignore[arg-type]


def test_string_endpoint_normalized_to_enum():
    """字符串端点与枚举端点构造等价（构造成功即运行期可用）。

    回归：修复前字符串端点经 StrEnum 值成员匹配通过校验，但
    endpoint_operation 用 is 比较全 False——操作提取器无法判定目标，
    调用被 fail-closed 拒绝且无从定位。现在构造期强制归一为枚举。
    """
    string_spec = DeclarativeToolSpec(
        name="fs_tool",
        description="file tool",
        parameters={"type": "object"},
        permissions=("filesystem:write:/book/**",),
        endpoint="file_ops",
        endpoint_config={"root": "/book"},
    )
    enum_spec = DeclarativeToolSpec(
        name="fs_tool",
        description="file tool",
        parameters={"type": "object"},
        permissions=("filesystem:write:/book/**",),
        endpoint=EndpointType.FILE_OPS,
        endpoint_config={"root": "/book"},
    )
    assert string_spec.endpoint is EndpointType.FILE_OPS
    assert string_spec == enum_spec
    assert string_spec.to_dict()["endpoint"] == "file_ops"
    # 端点归一后操作推导与枚举声明完全一致（修复前此路径返回 None）
    assert endpoint_operation(
        string_spec.endpoint, {"operation": "write", "path": "/book/a.md"}
    ) == ("write", "/book/a.md")
    # 其余端点类型的字符串形态同样归一（各端点要求的配置齐全）
    assert DeclarativeToolSpec(
        name="t", description="d", parameters={},
        permissions=("network:connect:*.example.com",),
        endpoint="http_fetch",
    ).endpoint is EndpointType.HTTP_FETCH
    assert DeclarativeToolSpec(
        name="t", description="d", parameters={},
        permissions=("process:exec:git",),
        endpoint="process_exec", endpoint_config={"allowlist": ["git"]},
    ).endpoint is EndpointType.PROCESS_EXEC
    assert DeclarativeToolSpec(
        name="t", description="d", parameters={},
        permissions=("mcp:call:s1",),
        endpoint="mcp", endpoint_config={"server_id": "s1"},
    ).endpoint is EndpointType.MCP


def test_string_endpoint_flows_through_extractor():
    """字符串端点声明的定义经桥接提取器正常推导（登记/分发不依赖枚举入参）。"""
    executors = DeclarativeToolExecutors()
    definition = DeclarativeToolSpec(
        name="fs_tool",
        description="file tool",
        parameters={"type": "object"},
        permissions=("filesystem:write:/book/**",),
        endpoint="file_ops",
        endpoint_config={"root": "/book"},
    )
    executors.register_definition(definition)
    extractor = make_declarative_extractor(executors)
    assert extractor(definition.to_spec(), {"operation": "write", "path": "/book/a.md"}) == (
        "write",
        "/book/a.md",
    )


def test_declarative_round_trip():
    """声明式定义数据往返（持久化/知识集导出形态）。"""
    definition = _declarative(
        endpoint=EndpointType.PROCESS_EXEC,
        endpoint_config={"allowlist": ["git"]},
        meta={"source": "seed"},
    )
    rebuilt = DeclarativeToolSpec.from_dict(definition.to_dict())
    assert rebuilt.name == "my_tool"
    assert rebuilt.endpoint is EndpointType.PROCESS_EXEC
    assert rebuilt.endpoint_config == {"allowlist": ["git"]}
    assert rebuilt.meta == {"source": "seed"}
    assert rebuilt.permissions == ("network:connect:*.example.com",)


def test_network_policy_field_round_trip():
    """定义级网络策略字段往返（宿主顶层 policy 不再折叠进 meta）。"""
    from ink_engine.core.permissions import NetworkPolicy

    definition = _declarative(
        endpoint=EndpointType.HTTP_FETCH,
        network_policy=NetworkPolicy(allow_domains=frozenset({"*.example.com", "api.demo"})),
        meta={"source": "seed"},
    )
    data = definition.to_dict()
    assert data["network_policy"] == {
        "allow_domains": ["*.example.com", "api.demo"]
    }
    assert "network_policy" not in data["meta"]  # 顶层字段承载，不折叠进 meta
    rebuilt = DeclarativeToolSpec.from_dict(data)
    assert rebuilt.network_policy == definition.network_policy
    assert rebuilt.network_policy.allow_domains == frozenset(
        {"*.example.com", "api.demo"}
    )
    # 缺省 None 往返：键省略 + 解析回落 None
    plain = _declarative()
    plain_data = plain.to_dict()
    assert "network_policy" not in plain_data
    assert DeclarativeToolSpec.from_dict(plain_data).network_policy is None


def test_network_policy_declaration_rejects_malformed():
    """network_policy 声明形态非法 = 定义期拒绝（fail-fast）。"""
    base = _declarative().to_dict()
    with pytest.raises(GraphDefinitionError):
        DeclarativeToolSpec.from_dict({**base, "network_policy": {"allow_domains": "x"}})
    with pytest.raises(GraphDefinitionError):
        DeclarativeToolSpec.from_dict({**base, "network_policy": "http"})


def test_declarative_to_spec():
    """声明式定义 → 引擎工具描述（参数 schema 与权限声明透传）。"""
    spec = _declarative().to_spec()
    assert isinstance(spec, ToolSpec)
    assert spec.name == "my_tool"
    assert spec.permissions == ("network:connect:*.example.com",)


def test_endpoint_operation_http():
    """http_fetch 端点：从参数推导 (connect, host)——域名判定目标。"""
    op, target = endpoint_operation(
        EndpointType.HTTP_FETCH, {"url": "https://api.example.com/v1/books"}
    )
    assert (op, target) == ("connect", "api.example.com")
    assert endpoint_operation(EndpointType.HTTP_FETCH, {}) is None
    assert endpoint_operation(EndpointType.HTTP_FETCH, {"url": "not-a-url"}) is None


def test_endpoint_operation_process():
    """process_exec 端点：命令名作判定目标。"""
    op, target = endpoint_operation(
        EndpointType.PROCESS_EXEC, {"command": "git", "args": ["status"]}
    )
    assert (op, target) == ("exec", "git")


def test_endpoint_operation_process_operation_param_declared():
    """process_exec 操作目标参数名声明：判定优先声明、缺省回落（向后兼容）。

    端点配置声明 operation_param 后，判定读声明参数名（工具 schema 无需
    补固定 command 枚举参数）；未声明时回落既有 command 推导。
    """
    declared = endpoint_operation(
        EndpointType.PROCESS_EXEC,
        {"cmd": "git", "args": ["status"]},
        config={"allowlist": ["git"], "operation_param": "cmd"},
    )
    assert declared == ("exec", "git")
    # 声明优先：声明后不再读 command 参数（防声明与既有参数双源歧义）
    assert (
        endpoint_operation(
            EndpointType.PROCESS_EXEC,
            {"cmd": "git", "command": "curl"},
            config={"operation_param": "cmd"},
        )
        == ("exec", "git")
    )
    # 声明参数缺失 = 无法判定目标（fail-closed，不回落 command）
    assert (
        endpoint_operation(
            EndpointType.PROCESS_EXEC,
            {"command": "git"},
            config={"operation_param": "cmd"},
        )
        is None
    )
    # 缺省回落：无声明（None config / 空 config）仍按 command 推导
    fallback = endpoint_operation(
        EndpointType.PROCESS_EXEC, {"command": "git"}
    )
    assert fallback == ("exec", "git")
    assert (
        endpoint_operation(
            EndpointType.PROCESS_EXEC,
            {"command": "git"},
            config={"allowlist": ["git"]},
        )
        == ("exec", "git")
    )


def test_endpoint_operation_file():
    """file_ops 端点：操作 + 路径作判定目标（非法操作不产生判定目标）。"""
    op, target = endpoint_operation(
        EndpointType.FILE_OPS, {"operation": "write", "path": "/book/ch1.md"}
    )
    assert (op, target) == ("write", "/book/ch1.md")
    assert endpoint_operation(EndpointType.FILE_OPS, {"operation": "chmod", "path": "/x"}) is None


async def test_executor_dispatch_routes_by_endpoint():
    """执行体分发：按端点类型路由；未注册端点/未登记定义 → 显式拒绝。"""
    executors = DeclarativeToolExecutors()
    definition = _declarative(
        endpoint=EndpointType.PROCESS_EXEC,
        endpoint_config={"allowlist": ["git"]},
    )
    executors.register_definition(definition)
    calls: list[str] = []

    async def process_executor(ctx, defn, args, approval):
        calls.append(defn.endpoint.value)
        return f"exec:{args.get('command')}"

    executors.register(EndpointType.PROCESS_EXEC, process_executor)
    spec = definition.to_spec()
    result = await executors.dispatch(None, spec, {"command": "git"})
    assert result == "exec:git"
    assert calls == ["process_exec"]

    # 未登记定义的工具 → 拒绝
    with pytest.raises(GraphDefinitionError, match="无声明式定义"):
        await executors.dispatch(None, ToolSpec(name="ghost"), {})
    # 未注册端点类型的定义 → 拒绝
    executors.register_definition(_declarative(endpoint=EndpointType.HTTP_FETCH, name="net"))
    with pytest.raises(GraphDefinitionError, match="未注册执行体"):
        await executors.dispatch(None, ToolSpec(name="net"), {})


async def test_pipeline_full_flow_with_declarative_tools(memory_storage):
    """声明式工具过完整流水线：操作推导 → 门禁 → 沙箱 → 执行 → 审计 → 轨迹。"""
    from ink_engine.core.permissions import PermissionGate
    from ink_engine.core.sandbox import ProcessSandbox

    definition = _declarative(
        endpoint=EndpointType.PROCESS_EXEC,
        permissions=("process:exec:git",),
        endpoint_config={"allowlist": ["git"]},
    )
    spec = definition.to_spec()
    executors = DeclarativeToolExecutors()
    executors.register_definition(definition)

    async def process_executor(ctx, defn, args, approval):
        return "git status"

    executors.register(EndpointType.PROCESS_EXEC, process_executor)
    trace_store = ToolTraceStore(memory_storage)
    pipeline = ToolPipeline(
        gate=PermissionGate(),
        extractor=lambda s, a: endpoint_operation(definition.endpoint, a),
        sandboxes=(ProcessSandbox(allowlist=("git",), path=os.environ.get("PATH")),),
        executor=executors.dispatch,
        trace_sink=lambda trace: trace_store.record(trace),
    )

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    result = await pipeline.execute(Ctx(), spec, {"command": "git", "args": ["status"]})
    assert result.ok is True
    assert result.output == "git status"
    traces = await trace_store.list(tool="my_tool")
    assert len(traces) == 1
    assert traces[0].ok is True

    # 权限未命中（命令不在权限声明内）→ fail-closed 拒绝 + 失败轨迹
    denied = await pipeline.execute(Ctx(), spec, {"command": "rm"})
    assert denied.ok is False
    assert denied.decision == "deny"
    traces = await trace_store.list(tool="my_tool")
    assert len(traces) == 2
    assert traces[0].ok is False


async def test_pipeline_rejects_undeterminable_target(memory_storage):
    """声明式工具判定目标推导失败（非法/缺参）→ fail-closed 拒绝。

    回归 P0-4：修复前 extractor 返回 None（有 extractor 但解析不出目标）
    时门禁与沙箱整段跳过、仍执行 executor——受沙箱守卫的端点可绕过
    越界操作；现在与「未配置提取器」同语义拒绝（allow_unchecked=False）。
    """
    from ink_engine.core.sandbox import ProcessSandbox

    definition = _declarative(
        endpoint=EndpointType.PROCESS_EXEC,
        permissions=("process:exec:git",),
        endpoint_config={"allowlist": ["git"], "path": os.environ.get("PATH")},
    )
    executors = DeclarativeToolExecutors()
    executors.register_definition(definition)

    async def process_executor(ctx, defn, args, approval):
        raise AssertionError("不应执行：目标不可判定必须被门禁拦截")

    executors.register(EndpointType.PROCESS_EXEC, process_executor)
    pipeline = build_declarative_pipeline(
        executors, gate=None, sandboxes=(ProcessSandbox(allowlist=("git",)),)
    )

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    # 缺 command（process_exec 目标推导失败）→ 拒绝且执行体未被调用
    spec = definition.to_spec()
    result = await pipeline.execute(Ctx(), spec, {})
    assert result.ok is False
    assert result.decision == "deny"
    assert "无法判定目标" in (result.error or "")


def test_make_declarative_extractor_resolves_by_endpoint():
    """桥接提取器：spec.name 反查声明式定义 → 端点类型推导判定目标。"""
    executors = DeclarativeToolExecutors()
    file_def = DeclarativeToolSpec(
        name="fs_tool",
        description="file tool",
        parameters={"type": "object"},
        permissions=("filesystem:write:/book/**",),
        endpoint=EndpointType.FILE_OPS,
        endpoint_config={"root": "/book"},
    )
    executors.register_definition(file_def)
    extractor = make_declarative_extractor(executors)
    assert extractor(file_def.to_spec(), {"operation": "write", "path": "/book/a.md"}) == (
        "write",
        "/book/a.md",
    )
    # 未登记定义 → 无法推导（None）
    assert extractor(ToolSpec(name="ghost"), {}) is None


async def test_build_declarative_pipeline_full_flow(memory_storage):
    """引擎侧桥装配：harness 声明式工具经桥走完整流水线（登记 → 推导 → 分发）。

    回归 P1-1：修复前声明式工具无生产接线（to_spec 丢端点、定义不登记），
    桥补齐 extractor/executor 后同一注册表即可执行。
    """
    from ink_engine.core.permissions import PermissionGate
    from ink_engine.core.tool_orchestrator import ToolTraceStore

    definition = _declarative(
        endpoint=EndpointType.PROCESS_EXEC,
        permissions=("process:exec:git",),
        endpoint_config={"allowlist": ["git"], "path": os.environ.get("PATH")},
    )
    executors = DeclarativeToolExecutors()
    executors.register_definition(definition)

    async def process_executor(ctx, defn, args, approval):
        return "ok"

    executors.register(EndpointType.PROCESS_EXEC, process_executor)
    trace_store = ToolTraceStore(memory_storage)
    pipeline = build_declarative_pipeline(
        executors,
        gate=PermissionGate(),
        sandboxes=(),
        trace_sink=lambda trace: trace_store.record(trace),
    )

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    spec = definition.to_spec()
    result = await pipeline.execute(Ctx(), spec, {"command": "git"})
    assert result.ok is True
    assert result.output == "ok"
    traces = await trace_store.list(tool="my_tool")
    assert len(traces) == 1
    assert traces[0].ok is True


async def test_pipeline_default_gate_fail_closed():
    """未注入门禁时按默认拒绝策略兜底：权限未命中的调用不得直通执行。"""
    definition = _declarative()  # http_fetch，权限 network:connect:*.example.com
    executors = DeclarativeToolExecutors()
    executors.register_definition(definition)
    calls: list[str] = []

    async def http_executor(ctx, defn, args, approval):
        calls.append(args["url"])
        return "body"

    executors.register(EndpointType.HTTP_FETCH, http_executor)
    pipeline = build_declarative_pipeline(executors)  # 不传 gate

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    spec = definition.to_spec()
    # 权限声明命中白名单 → 放行
    allowed = await pipeline.execute(Ctx(), spec, {"url": "https://api.example.com/v1"})
    assert allowed.ok is True
    assert calls == ["https://api.example.com/v1"]
    # 未命中域名 → 默认门禁拒绝（修复前 gate=None 会直通执行）
    denied = await pipeline.execute(Ctx(), spec, {"url": "https://evil.com/x"})
    assert denied.ok is False
    assert denied.decision == "deny"
    assert calls == ["https://api.example.com/v1"]


async def test_network_policy_sandbox_wired():
    """network_policy 并入沙箱环节：http_fetch 域名白名单真实生效。"""
    from ink_engine.core.permissions import NetworkPolicy

    definition = _declarative(
        permissions=("network:connect:*",)  # 宽权限：沙箱层做域名收口
    )
    executors = DeclarativeToolExecutors()
    executors.register_definition(definition)
    calls: list[str] = []

    async def http_executor(ctx, defn, args, approval):
        calls.append(args["url"])
        return "body"

    executors.register(EndpointType.HTTP_FETCH, http_executor)
    pipeline = build_declarative_pipeline(
        executors,
        network_policy=NetworkPolicy(allow_domains=("*.example.com",)),
    )

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    spec = definition.to_spec()
    # 白名单域名 → 门禁放行、沙箱放行
    allowed = await pipeline.execute(Ctx(), spec, {"url": "https://sub.example.com/a"})
    assert allowed.ok is True
    assert calls == ["https://sub.example.com/a"]
    # 非白名单域名 → 沙箱拒绝（NetworkPolicySandbox 违规，权限层已放行）
    denied = await pipeline.execute(Ctx(), spec, {"url": "https://other.org/a"})
    assert denied.ok is False
    assert denied.decision == "deny"
    assert "域名不在白名单" in (denied.error or "")
    assert calls == ["https://sub.example.com/a"]


def test_endpoint_operation_scheme_whitelist():
    """http_fetch 判定目标：仅 http/https + host 合法才产生 (connect, host)。"""
    assert endpoint_operation(
        EndpointType.HTTP_FETCH, {"url": "https://api.example.com:8443/v1"}
    ) == ("connect", "api.example.com")
    # 非白名单协议 / 无协议 / 带凭据的 URL → 无法判定（fail-closed）
    assert endpoint_operation(EndpointType.HTTP_FETCH, {"url": "ftp://example.com/f"}) is None
    assert endpoint_operation(EndpointType.HTTP_FETCH, {"url": "javascript:alert(1)"}) is None
    assert endpoint_operation(
        EndpointType.HTTP_FETCH, {"url": "https://user:pass@example.com/x"}
    ) == ("connect", "example.com")


def test_process_exec_requires_allowlist_declared():
    """process_exec 端点强制声明命令白名单：缺失即定义期拒绝（fail-closed）。"""
    with pytest.raises(GraphDefinitionError, match="allowlist"):
        _declarative(endpoint=EndpointType.PROCESS_EXEC)
    with pytest.raises(GraphDefinitionError, match="allowlist"):
        _declarative(endpoint=EndpointType.PROCESS_EXEC, endpoint_config={"allowlist": []})
    # 声明合法白名单 → 通过
    _declarative(endpoint=EndpointType.PROCESS_EXEC, endpoint_config={"allowlist": ["git"]})


def test_file_ops_requires_root_declared():
    """file_ops 端点强制声明根目录：缺失即定义期拒绝（fail-closed）。"""
    with pytest.raises(GraphDefinitionError, match="root"):
        _declarative(endpoint=EndpointType.FILE_OPS)
    _declarative(endpoint=EndpointType.FILE_OPS, endpoint_config={"root": "/book"})


async def test_pipeline_auto_wires_process_and_file_sandboxes():
    """三类端点沙箱自动接线：process/file 从 endpoint_config 构造守卫并生效。"""

    executors = DeclarativeToolExecutors()
    process_def = _declarative(
        name="run_tool",
        endpoint=EndpointType.PROCESS_EXEC,
        permissions=("process:exec:*",),  # 宽权限：沙箱白名单做命令收口
        endpoint_config={"allowlist": ["git"], "path": os.environ.get("PATH")},
    )
    file_def = DeclarativeToolSpec(
        name="fs_tool",
        description="file tool",
        parameters={"type": "object"},
        permissions=("filesystem:write:*",),  # 宽权限：沙箱根目录做路径收口
        endpoint=EndpointType.FILE_OPS,
        endpoint_config={"root": "/book"},
    )
    executors.register_definition(process_def)
    executors.register_definition(file_def)

    async def process_executor(ctx, defn, args, approval):
        return f"exec:{args.get('command')}"

    async def file_executor(ctx, defn, args, approval):
        return f"fs:{args.get('path')}"

    executors.register(EndpointType.PROCESS_EXEC, process_executor)
    executors.register(EndpointType.FILE_OPS, file_executor)
    pipeline = build_declarative_pipeline(executors, gate=None)

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    # process_exec：白名单命令放行，白名单外命令被沙箱拒绝
    ok = await pipeline.execute(Ctx(), process_def.to_spec(), {"command": "git"})
    assert ok.ok is True and ok.output == "exec:git"
    denied = await pipeline.execute(Ctx(), process_def.to_spec(), {"command": "rm"})
    assert denied.ok is False and denied.decision == "deny"
    assert "命令不在白名单" in (denied.error or "")

    # file_ops：根目录内放行（沙箱解析为绝对路径回写执行参数），越界
    # 被沙箱拒绝（无需宿主手动注入沙箱）
    fs_ok = await pipeline.execute(
        Ctx(), file_def.to_spec(), {"operation": "write", "path": "/book/ch1.md"}
    )
    assert fs_ok.ok is True and "ch1.md" in fs_ok.output
    fs_denied = await pipeline.execute(
        Ctx(), file_def.to_spec(), {"operation": "write", "path": "/etc/passwd"}
    )
    assert fs_denied.ok is False and fs_denied.decision == "deny"
    assert "路径越界" in (fs_denied.error or "")


async def test_gate_judges_by_definition_permissions():
    """门禁按定义声明权限判定：调用方伪造的宽松 spec 权限不生效。

    回归：修复前门禁消费 spec.permissions——构造 name 命中已登记定义、
    但权限更宽松的 ToolSpec 可绕过定义的白名单约束。
    """
    executors = DeclarativeToolExecutors()
    definition = _declarative(
        permissions=("network:connect:*.example.com",)
    )
    executors.register_definition(definition)

    async def http_executor(ctx, defn, args, approval):
        return "body"

    executors.register(EndpointType.HTTP_FETCH, http_executor)
    pipeline = build_declarative_pipeline(executors)

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    # 伪造宽松权限的 spec：定义只允许 *.example.com
    forged = ToolSpec(
        name="my_tool",
        description="伪造",
        parameters={},
        permissions=("network:connect:*",),
    )
    allowed = await pipeline.execute(
        Ctx(), forged, {"url": "https://api.example.com/v1"}
    )
    assert allowed.ok is True
    denied = await pipeline.execute(
        Ctx(), forged, {"url": "https://evil.example.org/x"}
    )
    assert denied.ok is False and denied.decision == "deny"
