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
    EndpointTypeSpec,
    build_declarative_pipeline,
    endpoint_operation,
    endpoint_operation_failure_reason,
    endpoint_registry,
    make_declarative_extractor,
    tool_contract_from_declaration,
)
from ink_engine.core.exceptions import GraphDefinitionError, SandboxViolation
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.schema_validator import FIELD_ARRAY, SchemaField
from ink_engine.core.tool_orchestrator import ToolTraceStore
from ink_engine.core.tool_pipeline import ToolPipeline


def _declarative(endpoint: EndpointType = EndpointType.HTTP_FETCH, **kw) -> DeclarativeToolSpec:
    base = {
        "name": "mytool",
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
    """未注册端点类型（非内置且未登记）→ 定义期拒绝。"""
    with pytest.raises(GraphDefinitionError, match="端点类型未注册"):
        _declarative(endpoint="unknown_endpoint")  # type: ignore[arg-type]


def test_string_endpoint_normalized_to_enum():
    """字符串端点与枚举端点构造等价（构造成功即运行期可用）。

    回归：修复前字符串端点经 StrEnum 值成员匹配通过校验，但
    endpoint_operation 用 is 比较全 False——操作提取器无法判定目标，
    调用被 fail-closed 拒绝且无从定位。现在构造期强制归一为枚举。
    """
    string_spec = DeclarativeToolSpec(
        name="fstool",
        description="file tool",
        parameters={"type": "object"},
        permissions=("filesystem:write:/book/**",),
        endpoint="file_ops",
        endpoint_config={"root": "/book"},
    )
    enum_spec = DeclarativeToolSpec(
        name="fstool",
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
        name="fstool",
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
    assert rebuilt.name == "mytool"
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
    assert spec.name == "mytool"
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


def test_endpoint_operation_process_argv_stringified():
    """process_exec argv 参数被模型字符串化时容错（JSON 字符串数组 → 数组）。

    shell_exec 命令面 = argv[0]：模型常把嵌套数组输出为 JSON 字符串
    （如 ``"[\\\"pip\\\", \\\"install\\\"]"``）——提取器须解析为数组再取
    首元素作判定目标，否则 fail-closed 误拒（v8 实测 shell_exec 3/3 被拒）。
    """
    config = {
        "operation_param": "argv",
        "allowlist": ["pip", "python"],
    }
    op, target = endpoint_operation(
        EndpointType.PROCESS_EXEC,
        {"command": "shell_exec", "argv": '["pip", "install", "pytest"]'},
        config=config,
    )
    assert (op, target) == ("exec", "pip")
    # 失败原因：容错成功后返回 None（判定可成立）
    assert (
        endpoint_operation_failure_reason(
            EndpointType.PROCESS_EXEC,
            {"command": "shell_exec", "argv": '["pip", "install"]'},
            config=config,
        )
        is None
    )
    # 非 JSON / 非数组字符串 = 无法判定（fail-closed），文案指引正确形态
    assert (
        endpoint_operation(
            EndpointType.PROCESS_EXEC,
            {"command": "shell_exec", "argv": "pip install"},
            config=config,
        )
        is None
    )
    reason = endpoint_operation_failure_reason(
        EndpointType.PROCESS_EXEC,
        {"command": "shell_exec", "argv": "pip install"},
        config=config,
    )
    assert reason and "字符串数组" in reason


def test_endpoint_operation_task_manager():
    """task_manager 判定目标 = operation 值（todo:manage:<op>）。"""
    op, target = endpoint_operation(
        EndpointType.TASK_MANAGER,
        {"operation": "create", "title": "任务"},
    )
    assert (op, target) == ("manage", "create")
    # 缺 operation = fail-closed，失败原因给出操作集指引
    assert (
        endpoint_operation(EndpointType.TASK_MANAGER, {"title": "任务"})
        is None
    )
    reason = endpoint_operation_failure_reason(
        EndpointType.TASK_MANAGER, {"title": "任务"}
    )
    assert reason and "create/update/complete/list/clear/delete" in reason

def test_endpoint_operation_file():
    """file_ops 端点：操作 + 路径作判定目标（非法操作不产生判定目标）。"""
    op, target = endpoint_operation(
        EndpointType.FILE_OPS, {"operation": "write", "path": "/book/ch1.md"}
    )
    assert (op, target) == ("write", "/book/ch1.md")
    assert endpoint_operation(EndpointType.FILE_OPS, {"operation": "chmod", "path": "/x"}) is None


def test_endpoint_operation_file_edit_first_class():
    """file_ops 一等操作域：edit = 就地改写，判定目标原样保留（权限动作
    filesystem:edit、沙箱守卫与审计可独立区分，不再归一为 write）。

    回归：edit 曾不在操作白名单，file_edit 调用被提取器判为无法判定目标
    （"操作提取器无法判定目标，拒绝执行"）；升级为一等操作域后原样判定。
    未知操作仍返回 None（fail-closed 不破坏）。
    """
    op, target = endpoint_operation(
        EndpointType.FILE_OPS, {"operation": "edit", "path": "/book/ch1.md"}
    )
    assert (op, target) == ("edit", "/book/ch1.md")
    # 未知操作仍无法判定（fail-closed）
    assert endpoint_operation(EndpointType.FILE_OPS, {"operation": "chmod", "path": "/x"}) is None


def test_failure_reason_file_ops_missing_operation():
    """判定失败原因：file_ops 缺 operation/非法 operation 给出合法值清单。"""
    reason = endpoint_operation_failure_reason(
        EndpointType.FILE_OPS, {"path": "/book/ch1.md"}
    )
    assert reason is not None and "operation" in reason and "edit" in reason
    reason = endpoint_operation_failure_reason(
        EndpointType.FILE_OPS, {"operation": "chmod", "path": "/x"}
    )
    assert reason is not None and "chmod" not in (reason or "")
    # 合法调用不产生失败原因
    assert (
        endpoint_operation_failure_reason(
            EndpointType.FILE_OPS, {"operation": "write", "path": "/a.md"}
        )
        is None
    )


def test_failure_reason_http_url_missing():
    assert endpoint_operation_failure_reason(EndpointType.HTTP_FETCH, {}) is not None
    assert (
        endpoint_operation_failure_reason(
            EndpointType.HTTP_FETCH, {"url": "https://a.example.com/x"}
        )
        is None
    )


def test_file_ops_operation_enum_definition_time_validation():
    """定义期硬校验：file_ops 工具声明的 operation enum 必须 ⊆ 引擎操作域。

    回归：file_edit 曾声明 operation enum 与提取器白名单不一致，运行期
    必被 fail-closed 拒绝且无从定位（静默缺口）；现在定义期即报错。
    """
    # 合法：enum 全部落在操作域内
    DeclarativeToolSpec(
        name="fstool",
        description="file tool",
        parameters={
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": ["read", "write", "edit"]},
                "path": {"type": "string"},
            },
        },
        permissions=("filesystem:write:/book/**",),
        endpoint="file_ops",
        endpoint_config={"root": "/book"},
    )
    # 非法：enum 含引擎不支持的 chmod → 定义期拒绝
    with pytest.raises(GraphDefinitionError, match="引擎不支持的文件操作"):
        DeclarativeToolSpec(
            name="fstool2",
            description="file tool",
            parameters={
                "type": "object",
                "properties": {
                    "operation": {"type": "string", "enum": ["write", "chmod"]},
                    "path": {"type": "string"},
                },
            },
            permissions=("filesystem:write:/book/**",),
            endpoint="file_ops",
            endpoint_config={"root": "/book"},
        )
    # 未声明 operation 参数（无 enum 约束）不触发校验
    DeclarativeToolSpec(
        name="fstool3",
        description="file tool",
        parameters={"type": "object", "properties": {"path": {"type": "string"}}},
        permissions=("filesystem:write:/book/**",),
        endpoint="file_ops",
        endpoint_config={"root": "/book"},
    )


def test_endpoint_operation_file_search_ops():
    """file_ops 检索操作：search/search_paths 判定目标（无 path 回落端点根）。
    检索操作 = 只读文件操作域的新成员：权限动作与沙箱守卫按操作名对齐
    （filesystem:search / filesystem:search_paths）；无 path 参数时全域
    检索，判定目标 = 端点配置根目录（检索域 = 整个工作区根）。
    """
    op, target = endpoint_operation(
        EndpointType.FILE_OPS,
        {"operation": "search", "pattern": "foo"},
        config={"root": "/ws"},
    )
    assert (op, target) == ("search", "/ws")
    op, target = endpoint_operation(
        EndpointType.FILE_OPS,
        {"operation": "search_paths", "pattern": "**/*.py", "path": "/ws/src"},
        config={"root": "/ws"},
    )
    assert (op, target) == ("search_paths", "/ws/src")
    # 无根回落（未注入 config）= 无法判定目标（fail-closed）
    assert (
        endpoint_operation(EndpointType.FILE_OPS, {"operation": "search", "pattern": "x"})
        is None
    )
    # 非法操作仍无法判定（fail-closed）
    assert endpoint_operation(EndpointType.FILE_OPS, {"operation": "chmod", "path": "/x"}) is None


def test_endpoint_operation_web_search():
    """web_search 端点：独立权限动作 search（ENG6-10；空查询无法判定）。

    联网搜索与 fetch 的单 URL 出网不同：查询串不能做域名白名单匹配，
    权限动作 = 独立 search（不再挂 connect 域名语义）——新声明用
    ``network:search:*``，既有 ``network:connect:*`` 全开通配经
    :func:`~ink_engine.core.permissions.rule_matches` 兼容分支继续生效。
    """
    op, target = endpoint_operation(
        EndpointType.WEB_SEARCH, {"query": "最新研究", "limit": 5}
    )
    assert (op, target) == ("search", "最新研究")
    assert endpoint_operation(EndpointType.WEB_SEARCH, {}) is None
    assert endpoint_operation(EndpointType.WEB_SEARCH, {"query": ""}) is None


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
    traces = await trace_store.list(tool="mytool")
    assert len(traces) == 1
    assert traces[0].ok is True

    # 权限未命中（命令不在权限声明内）→ fail-closed 拒绝 + 失败轨迹
    denied = await pipeline.execute(Ctx(), spec, {"command": "rm"})
    assert denied.ok is False
    assert denied.decision == "deny"
    traces = await trace_store.list(tool="mytool")
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
    # fail-closed 文案携带结构化原因（指引模型自我纠正）
    assert "command" in (result.error or "")


def test_make_declarative_extractor_resolves_by_endpoint():
    """桥接提取器：spec.name 反查声明式定义 → 端点类型推导判定目标。"""
    executors = DeclarativeToolExecutors()
    file_def = DeclarativeToolSpec(
        name="fstool",
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
    traces = await trace_store.list(tool="mytool")
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
    """network_policy 并入流水线：白名单 = 免审批快速路径；白名单外转审批。

    审批即网关：非白名单域名强制挂卡（_NetworkReviewGate），审批 accept
    后放行、reject 后拒绝——不再 fail-closed 硬拒。
    """
    from ink_engine.core.permissions import NetworkPolicy

    definition = _declarative(
        permissions=("network:connect:*",)  # 宽权限：域名收口归网络守卫/审批
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
        """审批卡上下文：未预设注入值 = 拒绝（fail-closed 兜底）。"""

        def __init__(self, inject=None):
            self._inject = dict(inject or {})
            self.cards = []

        async def interrupt(self, key, payload):
            self.cards.append((key, payload))
            return self._inject.pop(key, "reject")

        async def get_interrupt_payload(self, key):
            return None

    spec = definition.to_spec()
    # 白名单域名 → 门禁放行、沙箱放行（免审批快速路径）
    allowed = await pipeline.execute(Ctx(), spec, {"url": "https://sub.example.com/a"})
    assert allowed.ok is True
    assert calls == ["https://sub.example.com/a"]
    # 非白名单域名 → 审批卡裁决（默认 reject → 拒绝，不执行）
    ctx = Ctx()
    denied = await pipeline.execute(ctx, spec, {"url": "https://other.org/a"})
    assert denied.ok is False
    assert denied.decision == "reject"
    assert ctx.cards, "非白名单域名必须挂审批卡"
    assert calls == ["https://sub.example.com/a"]
    # 审批 accept → 放行执行（审批即网关，白名单不再是执行期硬边界）
    ctx = Ctx(inject={"gate:mytool": {"decision": "accept"}})
    accepted = await pipeline.execute(ctx, spec, {"url": "https://other.org/a"})
    assert accepted.ok is True
    assert calls == ["https://sub.example.com/a", "https://other.org/a"]
    assert ctx.cards, "非白名单域名必须挂审批卡"


async def test_network_policy_deny_mode_keeps_fail_closed():
    """unlisted_policy=deny：白名单外域名保持 fail-closed 硬拒（收紧面）。"""
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
        network_unlisted_policy="deny",
    )

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    spec = definition.to_spec()
    allowed = await pipeline.execute(Ctx(), spec, {"url": "https://sub.example.com/a"})
    assert allowed.ok is True
    assert calls == ["https://sub.example.com/a"]
    # 非白名单域名 → 沙箱硬拒（NetworkPolicySandbox 违规，权限层已放行）
    denied = await pipeline.execute(Ctx(), spec, {"url": "https://other.org/a"})
    assert denied.ok is False
    assert denied.decision == "deny"
    assert "域名不在白名单" in (denied.error or "")
    assert calls == ["https://sub.example.com/a"]


async def test_file_search_ops_pipeline_gate_and_sandbox():
    """检索操作走完整流水线：权限动作命中 → 沙箱边界解析 → 执行体分发。

    全域检索（无 path）判定目标 = 根目录本身：权限模式含根目录条目
    （``filesystem:search:root|root/**``）才放行——越界 path 由沙箱拒绝。
    """
    definition = _declarative(
        name="grep",
        endpoint=EndpointType.FILE_OPS,
        endpoint_config={"root": "/ws"},
        permissions=("filesystem:search:/ws|/ws/**",),
        parameters={
            "type": "object",
            "properties": {
                "operation": {"enum": ["search"]},
                "pattern": {"type": "string"},
            },
        },
    )
    executors = DeclarativeToolExecutors()
    executors.register_definition(definition)
    calls: list[dict] = []

    async def file_executor(ctx, defn, args, approval):
        calls.append(args)
        return "ok"

    executors.register(EndpointType.FILE_OPS, file_executor)
    pipeline = build_declarative_pipeline(executors)

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    spec = definition.to_spec()
    # 全域检索：目标回落根目录 → 权限命中 + 沙箱解析通过
    allowed = await pipeline.execute(
        Ctx(), spec, {"operation": "search", "pattern": "foo"}
    )
    assert allowed.ok is True
    assert calls[-1]["pattern"] == "foo"
    # 非法操作（chmod）→ 提取器无法判定目标 → fail-closed 拒绝
    denied = await pipeline.execute(Ctx(), spec, {"operation": "chmod", "path": "/ws/x"})
    assert denied.ok is False
    assert denied.decision == "deny"
    assert "无法判定" in (denied.error or "")


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
        name="runtool",
        endpoint=EndpointType.PROCESS_EXEC,
        permissions=("process:exec:*",),  # 宽权限：沙箱白名单做命令收口
        endpoint_config={"allowlist": ["git"], "path": os.environ.get("PATH")},
    )
    file_def = DeclarativeToolSpec(
        name="fstool",
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
        name="mytool",
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


async def test_auto_sandbox_uses_calling_tool_own_definition(tmp_path):
    """跨工具沙箱边界回归（ENG6-1）：守卫按当前调用工具自身定义构造。

    修复前取注册表第一个匹配定义——同端点先登记宽 root 的工具 B 时，
    窄 root 工具 A 的越界路径被 B 的 root 放过（纵深防御被绕过）。
    """
    narrow_root = tmp_path / "narrow"
    wide_root = tmp_path / "wide"
    narrow_root.mkdir()
    wide_root.mkdir()

    wide_def = _declarative(
        name="wide_tool",
        endpoint=EndpointType.FILE_OPS,
        permissions=("filesystem:write:*",),
        endpoint_config={"root": str(wide_root)},
    )
    narrow_def = DeclarativeToolSpec(
        name="narrow_tool",
        description="窄边界工具",
        parameters={"type": "object"},
        permissions=("filesystem:write:*",),  # 宽权限：沙箱根目录做路径收口
        endpoint=EndpointType.FILE_OPS,
        endpoint_config={"root": str(narrow_root)},
    )
    executors = DeclarativeToolExecutors()
    # 先登记宽边界定义：修复前第一个匹配即被采用 → 窄工具越界可逃逸
    executors.register_definition(wide_def)
    executors.register_definition(narrow_def)

    async def file_executor(ctx, defn, args, approval):
        return f"fs:{args.get('path')}"

    executors.register(EndpointType.FILE_OPS, file_executor)
    pipeline = build_declarative_pipeline(executors, gate=None)

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    narrow_spec = narrow_def.to_spec()
    # 窄工具写自身根内 → 放行
    inside = await pipeline.execute(
        Ctx(), narrow_spec, {"operation": "write", "path": str(narrow_root / "a.md")}
    )
    assert inside.ok is True
    # 窄工具越界（落在宽工具根内、窄工具根外）→ 必须被窄工具自身 root 拒绝
    escaped = await pipeline.execute(
        Ctx(), narrow_spec, {"operation": "write", "path": str(wide_root / "x.md")}
    )
    assert escaped.ok is False
    assert escaped.decision == "deny"
    assert "路径越界" in (escaped.error or "")


async def test_trace_args_stripped_before_persist(memory_storage):
    """轨迹脱敏回归（ENG6-2）：凭据类参数不随轨迹落库。"""
    from ink_engine.core.permissions import PermissionGate

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
        trace_sink=lambda trace: trace_store.record(trace),
    )

    class Ctx:
        async def emit(self, *args, **kwargs):
            pass

    spec = definition.to_spec()
    result = await pipeline.execute(
        Ctx(), spec, {"command": "git", "api_key": "sk-secret", "keep": 1}
    )
    assert result.ok is True
    traces = await trace_store.list(tool="mytool")
    assert len(traces) == 1
    assert traces[0].args["api_key"] == ""
    assert traces[0].args["keep"] == 1
    assert traces[0].args["command"] == "git"


def test_web_search_permission_action_compat_and_new():
    """ENG6-10 回归：web_search 独立动作 search + 既有 connect:* 兼容。"""
    from ink_engine.core.permissions import parse_permission, rule_matches

    # 新声明：network:search:* 命中 search 操作（pattern = 通配标记）
    assert rule_matches(parse_permission("network:search:*"), "search", "任意查询")
    # 既有声明：network:connect:* 全开通配兼容（查询串无法做域名匹配）
    assert rule_matches(parse_permission("network:connect:*"), "search", "任意查询")
    # 非通配的 connect 声明不误放行 search（白名单语义不被绕过）
    assert not rule_matches(
        parse_permission("network:connect:example.com"), "search", "任意查询"
    )
    # connect 操作语义不受影响
    assert rule_matches(
        parse_permission("network:connect:example.com"), "connect", "example.com"
    )


async def test_http_fetch_streams_with_cap(monkeypatch):
    """ENG6-9 回归：http_fetch 响应流式读取 + 上限截断（不整读 OOM）。"""
    import httpx

    if not hasattr(httpx, "AsyncClient"):
        pytest.skip("httpx 不可用")

    class FakeStreamResponse:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def aiter_text(self):
            async def gen():
                for _ in range(50):
                    yield "x" * 1000  # 总 50KB

            return gen()

    streamed = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        def stream(self, method, url, headers=None):
            streamed.append((method, url))
            return FakeStreamResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    from ink_engine.core.declarative_tools import make_http_fetch_executor

    executor = make_http_fetch_executor(max_chars=5000)
    spec = DeclarativeToolSpec(
        name="fetchdocs",
        description="抓取",
        parameters={"type": "object", "properties": {"url": {"type": "string"}}},
        permissions=("network:connect:example.com",),
        endpoint=EndpointType.HTTP_FETCH,
        endpoint_config={"method": "GET"},
    )
    out = await executor(None, spec, {"url": "https://example.com/doc"}, None)
    assert out.startswith("HTTP 200")
    assert "溢出截断" in out
    body = out.split("\n", 1)[1]
    assert len(body) < 6000
    assert streamed == [("GET", "https://example.com/doc")]


# ── 端点类型注册表（EndpointTypeRegistry）──────────────────────────────


def test_builtin_endpoints_registered():
    """引擎内置 7 种端点类型在模块加载期登记（注册表非空、名全）。"""
    names = set(endpoint_registry.names)
    assert {
        "http_fetch",
        "process_exec",
        "file_ops",
        "mcp",
        "web_search",
        "collab_request",
        "task_manager",
    } <= names
    assert endpoint_registry.has("file_ops")
    assert endpoint_registry.get("file_ops").actions == (
        "read",
        "write",
        "delete",
        "edit",
        "search",
        "search_paths",
    )


def test_custom_endpoint_registration_and_dispatch():
    """宿主注册自定义端点：构造期校验通过、判定目标按注册钩子分发。"""
    endpoint_registry.register(
        EndpointTypeSpec(
            name="database_query",
            actions=("query",),
            config_requirements=("engine",),
            extractor=lambda args, config: (
                ("query", args["table"]) if args.get("table") else None
            ),
            failure_reason=lambda args, config: (
                None if args.get("table") else "table 参数缺失"
            ),
            output_fields=(SchemaField(name="rows", required=True, kind=FIELD_ARRAY),),
        )
    )
    try:
        spec = DeclarativeToolSpec(
            name="db_query",
            description="数据库查询",
            parameters={"type": "object", "properties": {"table": {"type": "string"}}},
            permissions=("database:query:*",),
            endpoint="database_query",
            endpoint_config={"engine": "sqlite"},
        )
        # 自定义端点保留字符串形态（非枚举），构造期校验通过
        assert spec.endpoint == "database_query"
        assert endpoint_operation("database_query", {"table": "books"}) == (
            "query",
            "books",
        )
        assert endpoint_operation("database_query", {}) is None
        reason = endpoint_operation_failure_reason("database_query", {})
        assert reason and "table 参数缺失" in reason
        # 契约输出形态按注册表条目取数
        contract = tool_contract_from_declaration(spec)
        assert contract.output_schema.fields[0].name == "rows"
        # 序列化往返保持字符串形态
        restored = DeclarativeToolSpec.from_dict(spec.to_dict())
        assert restored.endpoint == "database_query"
        assert restored.endpoint_config["engine"] == "sqlite"
    finally:
        endpoint_registry._specs.pop("database_query", None)


def test_custom_endpoint_config_requirements_enforced():
    """自定义端点 config_requirements 定义期强制（缺声明即拒绝）。"""
    endpoint_registry.register(
        EndpointTypeSpec(
            name="db_req_test",
            actions=("query",),
            config_requirements=("engine",),
            extractor=lambda args, config: (("query", args["table"]) if args.get("table") else None),
        )
    )
    try:
        with pytest.raises(GraphDefinitionError, match="engine"):
            DeclarativeToolSpec(
                name="db_bad",
                description="缺配置",
                parameters={},
                permissions=("database:query:*",),
                endpoint="db_req_test",
            )
    finally:
        endpoint_registry._specs.pop("db_req_test", None)


def test_endpoint_duplicate_registration_rejected():
    """重复注册（含覆盖内置）= 显式拒绝（防静默覆盖引擎安全语义）。"""
    with pytest.raises(GraphDefinitionError, match="重复注册"):
        endpoint_registry.register(endpoint_registry.get("file_ops"))


def test_endpoint_unregistered_spec_rejected():
    """未注册端点名的工具定义 → 构造期拒绝（fail-closed 于定义期）。"""
    with pytest.raises(GraphDefinitionError, match="端点类型未注册"):
        DeclarativeToolSpec(
            name="ghost",
            description="未注册端点",
            parameters={},
            permissions=("filesystem:read:*",),
            endpoint="no_such_endpoint",
        )


def test_endpoint_sandbox_ops_without_builder_rejected():
    """声明了守卫域但无守卫构造器 = 注册即拒绝（一致性校验）。"""
    with pytest.raises(GraphDefinitionError, match="sandbox_builder"):
        EndpointTypeSpec(
            name="incomplete_endpoint",
            actions=("query",),
            sandbox_ops=("query",),
        )


class _AllowlistTargetSandbox:
    """自定义端点守卫桩：只放行白名单 target（validate 契约与引擎沙箱同）。"""

    def __init__(self, allowed: tuple[str, ...]) -> None:
        self._allowed = allowed

    def guards_operation(self, operation: str) -> bool:
        return operation == "query"

    def validate(self, operation: str, target: str) -> str | None:
        if target not in self._allowed:
            raise SandboxViolation(f"目标不在白名单: {target}")
        return target


async def test_custom_endpoint_pipeline_guard_wired():
    """自定义端点走全流水线：注册表守卫自动接线，违规 target 被沙箱拒绝。

    注册表无「跳过流水线环节」开关：自定义端点与内置端点同等经过
    门禁 → 沙箱 → 守卫 → 审批 → 审计；声明了 sandbox_ops 的端点
    其守卫在流水线中自动生效（无需宿主手动注入沙箱）。
    """
    endpoint_registry.register(
        EndpointTypeSpec(
            name="guarded_query",
            actions=("query",),
            extractor=lambda args, config: (
                ("query", args["target"]) if args.get("target") else None
            ),
            sandbox_ops=("query",),
            sandbox_builder=lambda definition: _AllowlistTargetSandbox(("ok",)),
        )
    )
    try:
        definition = DeclarativeToolSpec(
            name="gq",
            description="带守卫查询",
            parameters={"type": "object", "properties": {"target": {"type": "string"}}},
            permissions=("database:query:*",),
            endpoint="guarded_query",
        )
        executors = DeclarativeToolExecutors()
        executors.register_definition(definition)
        executors.register(
            "guarded_query",
            lambda ctx, spec, args, approval: f"executed:{args['target']}",
        )
        pipeline = build_declarative_pipeline(executors)

        class Ctx:
            async def emit(self, *args, **kwargs):
                pass

        ok = await pipeline.execute(Ctx(), definition.to_spec(), {"target": "ok"})
        assert ok.ok is True
        assert ok.output == "executed:ok"
        denied = await pipeline.execute(Ctx(), definition.to_spec(), {"target": "bad"})
        assert denied.ok is False
        assert denied.decision == "deny"
        assert "目标不在白名单" in (denied.error or "")
    finally:
        endpoint_registry._specs.pop("guarded_query", None)
