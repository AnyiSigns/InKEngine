"""声明式工具创建（工具定义 = 数据：名称/描述/参数 schema/强制权限/端点）。

工具定义数据化之后，注册一个新工具 = 声明一条数据（name/description/
parameters/permissions/endpoint），而非编写一个执行函数——执行体经
执行体注册表按端点类型分发（宿主注入实现，引擎不生成执行代码）。

安全边界（fail-closed 底线）：
- 强制权限声明：permissions 缺失或为空 = 校验失败（未声明权限的工具
  默认拒绝是 PermissionGate 的兜底语义，声明式注册把它提前到建表期）；
- 端点类型与沙箱守卫联动：http_fetch 经 NetworkPolicy 域名白名单、
  process_exec 经 ProcessSandbox 命令白名单、file_ops 经 FileSandbox
  根目录——操作提取器（endpoint_operation）按端点类型从参数推导判定
  目标，供 ToolPipeline 的 gate/sandbox 环节消费；
- 执行体注册表缺省为空：未注册端点类型的调用在分发处显式拒绝
  （不静默失败也不穿出）。

端点类型只是分发/守卫的接线依据，不限定实现：http_fetch 默认执行体
经 make_http_fetch_executor 提供（httpx 可选依赖，缺失时显式报错），
宿主可注册自定义执行体覆盖。
"""
from __future__ import annotations

import inspect
import urllib.parse
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from .exceptions import GraphDefinitionError, SandboxViolation
from .llm.tools import ToolSpec
from .logging import get_logger
from .permissions import NetworkPolicy, NetworkPolicySandbox, PermissionGate, parse_permission
from .sandbox import FS_OPERATIONS as _FS_GUARDED_OPS
from .sandbox import FileSandbox, ProcessSandbox

if TYPE_CHECKING:
    from .tool_pipeline import ToolPipeline

logger = get_logger(__name__)


class EndpointType(StrEnum):
    """声明式工具的端点类型（分发/守卫接线的依据）。

    HTTP_FETCH: 网络抓取/调用（NetworkPolicy 域名白名单守卫）。
    PROCESS_EXEC: 受限子进程执行（ProcessSandbox 命令白名单守卫）。
    FILE_OPS: 文件读写删除（FileSandbox 根目录守卫）。
    MCP: 外部 MCP server 工具调用（按 server_id 路由会话；挂载须经
        vetting 闸门与审批，会话缺失 = fail-closed 拒绝）。
    """

    HTTP_FETCH = "http_fetch"
    PROCESS_EXEC = "process_exec"
    FILE_OPS = "file_ops"
    MCP = "mcp"


# 各端点类型的判定动作（endpoint_operation 的映射依据；与权限域动作对齐）
_ENDPOINT_ACTIONS: dict[EndpointType, tuple[str, ...]] = {
    EndpointType.HTTP_FETCH: ("connect",),
    EndpointType.PROCESS_EXEC: ("exec",),
    EndpointType.FILE_OPS: ("read", "write", "delete"),
    EndpointType.MCP: ("call",),
}

# 端点配置的必填白名单键（沙箱自动接线的声明依据：process_exec 须声明
# 命令白名单、file_ops 须声明根目录——缺失即定义期拒绝，fail-closed）。
# MCP 端点无本地沙箱（调用经远程 server 会话转发），不自动构造守卫；
# server_id 是路由密钥，定义期必须声明（会话缺失 = 分发处拒绝）
_ENDPOINT_CONFIG_REQUIREMENTS: dict[EndpointType, tuple[str, ...]] = {
    EndpointType.HTTP_FETCH: (),
    EndpointType.PROCESS_EXEC: ("allowlist",),
    EndpointType.FILE_OPS: ("root",),
    EndpointType.MCP: ("server_id",),
}


@dataclass(frozen=True, slots=True)
class DeclarativeToolSpec:
    """声明式工具定义（数据形态，注册前经校验）。

    Attributes:
        name: 工具名（全局唯一，重复注册由宿主注册表判定）。
        description: 工具描述（LLM 选工具的依据）。
        parameters: 参数 JSON Schema dict（OpenAI 兼容形态）。
        permissions: 声明式权限（强制非空，如 ``filesystem:write:/book/**``）——
            校验在定义期完成，不等到权限判定才暴露。
        endpoint: 端点类型（分发/守卫接线）。
        endpoint_config: 端点配置（http_fetch: method/base_url；process_exec:
            命令白名单；file_ops: 操作白名单；mcp: server_id 路由密钥），
            随定义持久化。
        meta: 扩展元数据（宿主语义，如来源 harness/经验蒸馏标记）。
    """

    name: str
    description: str
    parameters: dict[str, Any] = field(default_factory=dict)
    permissions: tuple[str, ...] = ()
    endpoint: EndpointType = EndpointType.HTTP_FETCH
    endpoint_config: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        """定义期校验（fail-fast：权限缺失/权限声明非法/参数 schema 非法/
        端点白名单缺失——缺声明即拒绝，不延后到执行期）。"""
        if not self.name:
            raise GraphDefinitionError("工具名不能为空")
        if not self.permissions:
            raise GraphDefinitionError(
                f"工具 {self.name} 必须声明权限（fail-closed：未声明权限的工具默认拒绝）"
            )
        for perm in self.permissions:
            try:
                parse_permission(perm)
            except ValueError as exc:
                raise GraphDefinitionError(f"工具 {self.name} 权限声明非法: {exc}") from exc
        if not isinstance(self.parameters, dict):
            raise GraphDefinitionError(
                f"工具 {self.name} 参数 schema 须为 JSON Schema dict"
            )
        if self.endpoint not in EndpointType:
            raise GraphDefinitionError(f"工具 {self.name} 端点类型非法: {self.endpoint!r}")
        for key in _ENDPOINT_CONFIG_REQUIREMENTS.get(self.endpoint, ()):
            if not self.endpoint_config.get(key):
                raise GraphDefinitionError(
                    f"工具 {self.name} 的 {self.endpoint.value} 端点须声明"
                    f" {key}（沙箱守卫白名单，缺失即拒绝）"
                )
        if self.endpoint is EndpointType.PROCESS_EXEC:
            allowlist = self.endpoint_config.get("allowlist")
            if not isinstance(allowlist, (list, tuple)) or not all(
                isinstance(cmd, str) and cmd for cmd in allowlist
            ):
                raise GraphDefinitionError(
                    f"工具 {self.name} 的 allowlist 须为非空命令白名单清单"
                )
        if self.endpoint is EndpointType.FILE_OPS:
            root = self.endpoint_config.get("root")
            if not isinstance(root, str) or not root:
                raise GraphDefinitionError(
                    f"工具 {self.name} 的 root 须为非空根目录路径"
                )

    def to_spec(self) -> ToolSpec:
        """转为引擎工具描述（参数 schema 与权限声明透传）。"""
        return ToolSpec(
            name=self.name,
            description=self.description,
            parameters=self.parameters,
            permissions=self.permissions,
        )

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "permissions": list(self.permissions),
            "endpoint": self.endpoint.value,
            "endpoint_config": self.endpoint_config,
            "meta": self.meta,
        }

    @classmethod
    def from_dict(cls, data: dict) -> DeclarativeToolSpec:
        endpoint = data.get("endpoint", EndpointType.HTTP_FETCH.value)
        try:
            endpoint_enum = EndpointType(endpoint)
        except ValueError as exc:
            raise GraphDefinitionError(f"端点类型非法: {endpoint!r}") from exc
        return cls(
            name=data["name"],
            description=data.get("description") or "",
            parameters=data.get("parameters") or {},
            permissions=tuple(data.get("permissions") or ()),
            endpoint=endpoint_enum,
            endpoint_config=data.get("endpoint_config") or {},
            meta=data.get("meta") or {},
        )


def endpoint_operation(
    endpoint: EndpointType, args: dict[str, Any], *, config: dict | None = None
) -> tuple[str, str] | None:
    """按端点类型从调用参数推导 (operation, target) 判定目标。

    - http_fetch: ("connect", url 的 host)；
    - process_exec: ("exec", 命令名)；
    - file_ops: (参数中声明的操作, 路径)，操作非法 = None（无法判定目标，
       由流水线按缺判定目标拒绝）；
    - mcp: ("call", server_id)，server_id 取自定义配置（缺省无法路由
       时返回 None = fail-closed 拒绝）。

    供 ToolPipeline 的 extractor 接线：声明式工具经此推导后走权限门禁
    与沙箱守卫（判定目标与执行参数一致，防二次拼接逃逸）。
    """
    if endpoint is EndpointType.HTTP_FETCH:
        url = args.get("url")
        if not isinstance(url, str) or not url:
            return None
        try:
            parsed = urllib.parse.urlsplit(url)
        except ValueError:
            return None
        # 协议白名单 + host 形式校验：仅 http/https 可出网，凭据/非标准
        # 协议的 host 提取一律拒绝（无法判定目标 = fail-closed）
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return None
        return ("connect", parsed.hostname)
    if endpoint is EndpointType.PROCESS_EXEC:
        command = args.get("command")
        return ("exec", command) if isinstance(command, str) else None
    if endpoint is EndpointType.FILE_OPS:
        operation = args.get("operation")
        path = args.get("path")
        if operation in _ENDPOINT_ACTIONS[endpoint] and isinstance(path, str):
            return (operation, path)
        return None
    if endpoint is EndpointType.MCP:
        server_id = (config or {}).get("server_id") if isinstance(config, dict) else None
        return ("call", server_id) if isinstance(server_id, str) and server_id else None
    return None


# 执行体签名：async (ctx, spec, args, approval) -> str（ToolPipeline.executor 契约）
DeclarativeExecutor = Callable[..., Awaitable[str]]
class DeclarativeToolExecutors:
    """声明式工具执行体注册表：端点类型 → 执行体（宿主注入分发）。

    注册 = 插拔 U 盘：新增端点类型 = 注册新执行体，声明式工具零改动；
    未注册端点类型 = 分发处显式拒绝（fail-closed，不静默失败）。
    同名重复注册 = 覆盖（宿主启动按配置装配，配置驱动）。
    """

    def __init__(self) -> None:
        self._executors: dict[EndpointType, DeclarativeExecutor] = {}
        # 声明式定义登记表（工具名 → 定义）：执行体分发反查端点类型的来源
        self._definitions: dict[str, DeclarativeToolSpec] = {}

    def register(self, endpoint: EndpointType, executor: DeclarativeExecutor) -> None:
        if not callable(executor):
            raise GraphDefinitionError(f"执行体须为可调用对象: {endpoint}")
        self._executors[endpoint] = executor

    def get(self, endpoint: EndpointType) -> DeclarativeExecutor | None:
        return self._executors.get(endpoint)

    def has(self, endpoint: EndpointType) -> bool:
        return endpoint in self._executors

    async def dispatch(
        self, ctx: Any, spec: ToolSpec, args: dict, approval: Any = None
    ) -> str:
        """按端点类型分发执行（spec 须携带端点信息——声明式工具经
        DeclarativeToolSpec 定义，执行体按 spec.name 反查定义后分发）。

        Args:
            ctx: 节点上下文（ToolPipeline.execute 透传）。
            spec: 引擎工具描述（name 反查声明式定义）。
            args: 调用参数。
            approval: 审批决议（门禁/沙箱通过后的执行透传）。

        Raises:
            GraphDefinitionError: 未注册端点类型或工具无声明式定义——
                显式拒绝而非静默失败。
        """
        definition = self._definitions.get(spec.name)
        if definition is None:
            raise GraphDefinitionError(f"工具 {spec.name} 无声明式定义（未登记）")
        executor = self._executors.get(definition.endpoint)
        if executor is None:
            raise GraphDefinitionError(
                f"工具 {spec.name} 的端点类型未注册执行体: {definition.endpoint.value}"
            )
        result = executor(ctx, definition, args, approval)
        if inspect.isawaitable(result):
            result = await result
        return str(result)

    def register_definition(self, definition: DeclarativeToolSpec) -> None:
        """登记声明式定义（执行体分发反查的注册来源）。"""
        self._definitions[definition.name] = definition

    def unregister_definition(self, name: str) -> None:
        """注销声明式定义（卸载挂载工具/清理失效条目用；缺失静默）。"""
        self._definitions.pop(name, None)

    @property
    def definitions(self) -> dict[str, DeclarativeToolSpec]:
        return dict(self._definitions)


def make_declarative_extractor(
    executors: DeclarativeToolExecutors,
) -> Callable[[ToolSpec, dict], tuple[str, str] | None]:
    """声明式工具的操作提取器（ToolPipeline.extractor 接线）。

    spec.name 反查声明式定义 → 按端点类型从调用参数推导判定目标
    （endpoint_operation）；目标无法判定返回 None——ToolPipeline 对
    提取器返回 None 且非 allow_unchecked 的调用 fail-closed 拒绝
    （无法判定目标 = 无法做权限/沙箱判定，不直通执行）。
    """

    def extract(spec: ToolSpec, args: dict) -> tuple[str, str] | None:
        definition = executors.definitions.get(spec.name)
        if definition is None:
            return None
        return endpoint_operation(definition.endpoint, args, config=definition.endpoint_config)

    return extract


class _DefinitionGate:
    """定义级权限门禁：按声明式定义声明的权限判定（防宽松 spec 覆盖）。

    调用方传入的 spec.permissions 不参与判定——声明式工具的权限边界
    = 定义声明的权限（定义期已校验非空且合法）；引擎自有装配路径始终
    一致，此包装把「调用方伪造宽松权限」的窗口也封住。
    """

    def __init__(self, executors: DeclarativeToolExecutors, inner: Any) -> None:
        self._executors = executors
        self._inner = inner

    def check(self, name: str, operation: str, target: str, permissions=None):
        definition = self._executors.definitions.get(name)
        if definition is not None:
            permissions = definition.permissions
        return self._inner.check(
            name, operation, target, permissions=permissions
        )


class _AutoDefinitionSandbox:
    """按调用时定义现取守卫的声明式沙箱（懒解析接线）。

    构建期快照问题：若在构建流水线后 register_definition 新工具，快照
    沙箱不含其守卫（file_ops 无根目录边界、process_exec 无命令白名单
    时仅靠权限 pattern 约束，纵深防御被削弱）。本沙箱在每次校验时从
    执行体注册表现取定义构造守卫：事后注册的定义立即获得硬边界，且
    守卫语义与构建期接线等价（定义即权威）。
    """

    def __init__(self, executors: DeclarativeToolExecutors) -> None:
        self._executors = executors

    def guards_operation(self, operation: str) -> bool:
        # 守卫域由定义端点决定：process_exec → exec；file_ops → FS 操作
        return operation in ("exec",) or operation in _FS_GUARDED_OPS

    def validate(self, operation: str, target: str) -> str | None:
        for definition in self._executors.definitions.values():
            if definition.endpoint is EndpointType.PROCESS_EXEC and operation == "exec":
                sandbox = ProcessSandbox(
                    allowlist=tuple(definition.endpoint_config["allowlist"]),
                    path=definition.endpoint_config.get("path"),
                )
                sandbox.validate(operation, target)
                return target
            if (
                definition.endpoint is EndpointType.FILE_OPS
                and operation in _FS_GUARDED_OPS
            ):
                sandbox = FileSandbox(root=definition.endpoint_config["root"])
                resolved = sandbox.validate(operation, target)
                return resolved if resolved is not None else target
        raise SandboxViolation(
            f"无声明式定义守卫操作 {operation!r}（目标 {target!r} 无沙箱边界）"
        )


def build_declarative_pipeline(
    executors: DeclarativeToolExecutors,
    *,
    gate: Any = None,
    sandboxes: tuple[Any, ...] = (),
    network_policy: NetworkPolicy | None = None,
    guards: tuple[Callable[..., Any], ...] = (),
    audit: Callable[..., Any] | None = None,
    max_result_chars: int = 100_000,
    trace_sink: Callable[..., Any] | None = None,
) -> ToolPipeline:
    """声明式工具执行流水线装配（轻路径的引擎侧桥接）。

    extractor = 端点类型操作推导（endpoint_operation）、executor =
    端点执行体分发（DeclarativeToolExecutors.dispatch）——声明式工具
    经此走完整流水线（门禁 → 沙箱 → 守卫 → 审批 → 审计）。

    门禁默认 fail-closed：未注入 gate 时按 :class:`PermissionGate`
    默认策略（未声明权限/未命中 = 拒绝）兜底；判定一律按**定义声明的
    权限**（:class:`_DefinitionGate` 包装，调用方 spec 权限不参与）；
    沙箱自动接线：http_fetch 经 ``network_policy`` 并入域名白名单，
    process_exec/file_ops 由 :class:`_AutoDefinitionSandbox` 按调用时
    定义现取守卫（白名单/根目录在定义期强制声明，缺声明注册即拒绝；
    事后注册的新定义同样立即获得守卫）——三类端点全部有对应守卫，
    判定目标推导失败恒 fail-closed 拒绝。
    """
    from .tool_pipeline import ToolPipeline

    if gate is None:
        gate = PermissionGate()
    gate = _DefinitionGate(executors, gate)
    if network_policy is not None:
        sandbox = (
            network_policy
            if isinstance(network_policy, NetworkPolicySandbox)
            else NetworkPolicySandbox(allow_domains=network_policy.allow_domains)
        )
        sandboxes = (*sandboxes, sandbox)
    sandboxes = (*sandboxes, _AutoDefinitionSandbox(executors))

    return ToolPipeline(
        gate=gate,
        extractor=make_declarative_extractor(executors),
        sandboxes=sandboxes,
        guards=guards,
        executor=executors.dispatch,
        audit=audit,
        max_result_chars=max_result_chars,
        allow_unchecked=False,
        trace_sink=trace_sink,
    )


def make_http_fetch_executor(
    *, timeout: float = 30.0, max_chars: int = 100_000
) -> DeclarativeExecutor:
    """默认 http_fetch 执行体（httpx 可选依赖；未安装时调用即显式报错）。

    仅做受控抓取：超时 + 输出截断（与 ProcessSandbox 输出截断同档防护）；
    域名白名单经 :func:`build_declarative_pipeline` 的 ``network_policy``
    参数并入沙箱环节（NetworkPolicySandbox 在守卫层先行判定，执行体
    不再自行判断域名——守卫在前，执行在后）。
    """

    async def execute(ctx: Any, definition: DeclarativeToolSpec, args: dict, approval: Any) -> str:
        try:
            import httpx
        except ImportError as exc:
            raise RuntimeError(
                "http_fetch 执行体依赖 httpx（pip install ink-engine[llm]），未安装"
            ) from exc
        config = definition.endpoint_config
        method = str(config.get("method") or args.get("method") or "GET").upper()
        url = args.get("url")
        if not isinstance(url, str) or not url:
            raise ValueError(f"工具 {definition.name} 缺 url 参数")
        headers = config.get("headers") or args.get("headers") or {}
        if not isinstance(headers, dict):
            raise ValueError("headers 须为 dict")
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.request(method, url, headers=headers)
        text = response.text
        overflow = len(text) > max_chars
        body = text[:max_chars] + ("\n…（溢出截断）" if overflow else "")
        return f"HTTP {response.status_code}\n{body}"

    return execute


__all__ = [
    "DeclarativeExecutor",
    "DeclarativeToolExecutors",
    "DeclarativeToolSpec",
    "EndpointType",
    "build_declarative_pipeline",
    "endpoint_operation",
    "make_declarative_extractor",
    "make_http_fetch_executor",
]
