"""声明式工具创建单测：强制权限/端点类型/操作推导/执行体分发/流水线集成。

语义检查点：注册新工具 = 声明一条数据（name/description/参数 schema/
强制权限/端点类型），执行体经注册表分发（宿主注入）；未声明权限 =
定义期拒绝（fail-closed 提前到建表期）；端点类型与沙箱守卫联动
（判定目标推导供门禁/沙箱环节消费）；声明式工具过完整流水线（门禁 →
沙箱 → 守卫 → 审批 → 审计 → 轨迹）。
"""
from __future__ import annotations

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
    definition = _declarative(endpoint=EndpointType.PROCESS_EXEC)
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
        sandboxes=(ProcessSandbox(allowlist=("git",)),),
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
