"""声明式工具创建（工具定义 = 数据：名称/描述/参数 schema/强制权限/端点）。

工具定义数据化之后，注册一个新工具 = 声明一条数据（name/description/
parameters/permissions/endpoint），而非编写一个执行函数——执行体经
执行体注册表按端点类型分发（宿主注入实现，引擎不生成执行代码）。

安全边界（fail-closed 底线）：
- 强制权限声明：permissions 缺失或为空 = 校验失败（未声明权限的工具
  默认拒绝是 PermissionGate 的兜底语义，声明式注册把它提前到建表期）；
- 端点类型与沙箱守卫联动：http_fetch 经 NetworkPolicy 网络守卫（白名单
  命中 = 免审批快速路径；unlisted_policy=review 档白名单外域名转审批、
  deny 档硬拒）、process_exec 经 ProcessSandbox 命令白名单、file_ops
  经 FileSandbox 根目录——操作提取器（endpoint_operation）按端点类型
  从参数推导判定目标，供 ToolPipeline 的 gate/sandbox 环节消费；
- 执行体注册表缺省为空：未注册端点类型的调用在分发处显式拒绝
  （不静默失败也不穿出）。

端点类型只是分发/守卫的接线依据，不限定实现：http_fetch 默认执行体
经 make_http_fetch_executor 提供（httpx 可选依赖，缺失时显式报错），
宿主可注册自定义执行体覆盖。

白名单审计：端点类型 = **声明式注册表 + 引擎默认内置**（谓词注册表同
哲学）——``EndpointTypeSpec`` 条目携带判定动作域/配置必填键/契约输出
形态/判定目标提取与失败原因钩子/沙箱守卫接线，内置 7 种在模块加载期
登记，宿主经 :class:`EndpointTypeRegistry` 增补自定义端点（注册 =
装配期代码动作，非 agent 可写数据）。自定义端点与内置端点同等走全
流水线（门禁 → 沙箱 → 守卫 → 审批 → 审计），注册表无「跳过流水线
环节」开关；未注册端点 = 定义期拒绝 + 分发处 fail-closed。
"""
from __future__ import annotations

import inspect
import json
import urllib.parse
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .tool_pipeline import ToolPipeline

from .contracts import NodeContract
from .exceptions import GraphDefinitionError, SandboxViolation
from .llm.tools import ToolSpec
from .logging import get_logger
from .permissions import (
    DENY,
    REVIEW,
    GateResult,
    NetworkPolicy,
    NetworkPolicySandbox,
    PermissionGate,
    parse_permission,
)
from .sandbox import FS_OPERATIONS as _FS_GUARDED_OPS
from .sandbox import FileSandbox, ProcessSandbox
from .schema_validator import (
    FIELD_ARRAY,
    FIELD_BOOL,
    FIELD_NUMBER,
    FIELD_OBJECT,
    FIELD_STRING,
    SchemaField,
)
from .tool_pipeline import DEFAULT_MAX_RESULT_CHARS

logger = get_logger(__name__)


class EndpointType(StrEnum):
    """声明式工具的端点类型（分发/守卫接线的依据）。

    HTTP_FETCH: 网络抓取/调用（NetworkPolicy 网络守卫：白名单直过，
       白名单外按 unlisted_policy 转审批或硬拒）。
    PROCESS_EXEC: 受限子进程执行（ProcessSandbox 命令白名单守卫）。
    FILE_OPS: 文件读写删除（FileSandbox 根目录守卫）。
    MCP: 外部 MCP server 工具调用（按 server_id 路由会话；挂载须经
        vetting 闸门与审批，会话缺失 = fail-closed 拒绝）。
    WEB_SEARCH: 联网搜索（本地聚合源/厂商降级；结果域名过滤在实现内，
        不设本地域名沙箱——与 fetch 的单 URL 出网语义不同；权限动作 =
        独立 search 域（ENG6-10），不再挂 connect 域名白名单）。
    COLLAB_REQUEST: 协作者召唤（宿主执行体把 EntitySpec 物化为 spawn
        子图——多 agent 动态协作入口；权限动作 = 独立 collab 域，
        判定目标 = 实体 id（collab:request:<entity_id>），fail-closed）。
    TASK_MANAGER: 待办清单管理（agent 自维护的持久化任务清单，按 thread
        隔离；单工具多操作 = operation 参数区分 create/update/complete/
        list/clear；判定目标 = 操作名（todo:manage:<operation>），
        缺 operation = fail-closed）。
    """

    HTTP_FETCH = "http_fetch"
    PROCESS_EXEC = "process_exec"
    FILE_OPS = "file_ops"
    MCP = "mcp"
    WEB_SEARCH = "web_search"
    COLLAB_REQUEST = "collab_request"
    TASK_MANAGER = "task_manager"


# 各端点类型的判定动作（endpoint_operation 的映射依据；与权限域动作对齐）
# search = 工作区文本内容检索（grep）/ search_paths = 工作区路径检索
# （glob）——同属只读文件操作域；edit = 就地改写，一等操作域（权限
# 动作 filesystem:edit、沙箱守卫与审计可独立区分）
_FILE_OPS_ACTIONS = ("read", "write", "delete", "edit", "search", "search_paths")


@dataclass(frozen=True, slots=True)
class EndpointTypeSpec:
    """端点类型注册表条目：分发/守卫/契约语义的数据化封装（宿主扩展位）。

    与 :class:`rules.RuleTypeRegistry` 同哲学：内置端点 = 引擎默认（机制
    语义），宿主可经 :meth:`EndpointTypeRegistry.register` 增补自定义端点
    ——每个端点必须连带声明它的判定动作域、配置必填键、契约输出形态、
    判定目标提取/失败原因钩子、沙箱守卫接线。全部字段构成该端点的
    **完整接线语义**：自定义端点与内置端点同等走全流水线（门禁 → 沙箱
    → 守卫 → 审批 → 审计），不存在「跳过流水线环节」的开关。

    Attributes:
        name: 端点类型名（注册键，工具声明 ``endpoint`` 字段引用）。
        actions: 判定动作域（operation 集合；file_ops 定义期校验
            operation 枚举不得超出此域）。
        config_requirements: 定义期必填配置键（缺失即拒绝，fail-closed）。
        output_fields: 契约输出形态（tool_contract_from_declaration 取数）。
        extractor: 判定目标提取钩子 ``(args, config) -> (operation, target)
            | None``——None = 无法判定目标（fail-closed）。
        failure_reason: 判定失败原因钩子 ``(args, config) -> str | None``。
        sandbox_ops: 需沙箱守卫的操作集合（空 = 无本地沙箱，门禁+审批为
            边界——与 mcp/web_search 同语义）。
        sandbox_builder: 守卫构造器 ``(definition) -> sandbox``（按定义
            强制声明的配置键构造守卫）。``sandbox_ops`` 非空而构造器缺失
            = 注册即拒绝（一致性校验，fail-closed）。
    """

    name: str
    actions: tuple[str, ...] = ()
    config_requirements: tuple[str, ...] = ()
    output_fields: tuple[SchemaField, ...] = ()
    extractor: (
        Callable[[dict[str, Any], dict | None], tuple[str, str] | None] | None
    ) = None
    failure_reason: Callable[[dict[str, Any], dict | None], str | None] | None = None
    sandbox_ops: tuple[str, ...] = ()
    sandbox_builder: Callable[[DeclarativeToolSpec], Any] | None = None

    def __post_init__(self) -> None:
        if not self.name:
            raise GraphDefinitionError("端点类型名不能为空")
        if self.sandbox_ops and self.sandbox_builder is None:
            raise GraphDefinitionError(
                f"端点类型 {self.name} 声明了沙箱守卫域 {self.sandbox_ops} "
                "但未提供守卫构造器（sandbox_builder）"
            )


class EndpointTypeRegistry:
    """端点类型注册表：内置默认 + 宿主注册扩展位（谓词注册表同哲学）。

    引擎内置 7 种端点类型在模块加载时登记（机制语义）；宿主自定义端点
    经 :meth:`register` 增补。重复注册（含覆盖内置）= 编程错误，显式
    拒绝——防静默覆盖引擎安全语义。注册是**装配期代码动作**，不是
    agent 可写数据：agent 只能引用已注册端点创建工具，不能注册端点。
    """

    def __init__(self) -> None:
        self._specs: dict[str, EndpointTypeSpec] = {}

    def register(self, spec: EndpointTypeSpec) -> None:
        """登记端点类型（重复登记抛错，防静默覆盖语义）。"""
        if spec.name in self._specs:
            raise GraphDefinitionError(f"端点类型重复注册: {spec.name}")
        self._specs[spec.name] = spec

    def get(self, name: str) -> EndpointTypeSpec | None:
        return self._specs.get(str(name))

    def has(self, name: str) -> bool:
        return str(name) in self._specs

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._specs)


def _extract_http_fetch(
    args: dict[str, Any], config: dict | None = None
) -> tuple[str, str] | None:
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


def _extract_process_exec(
    args: dict[str, Any], config: dict | None = None
) -> tuple[str, str] | None:
    command_param = "command"
    if isinstance(config, dict):
        command_param = str(config.get("operation_param") or "command")
    if command_param == "argv":
        # 命令面 = 参数数组首元素（shell_exec：判定目标 = argv[0] 真实
        # 命令，白名单按命令面校验）；argv 可能被模型字符串化，先规范化
        argv = coerce_argv(args.get("argv"))
        command = argv[0] if argv and isinstance(argv[0], str) else None
    else:
        command = args.get(command_param)
    return ("exec", command) if isinstance(command, str) and command else None


def _extract_file_ops(
    args: dict[str, Any], config: dict | None = None
) -> tuple[str, str] | None:
    operation = args.get("operation")
    if operation not in _FILE_OPS_ACTIONS:
        # 调用未传/传非法 operation：回落工具声明的固定操作（单操作
        # 工具如 glob→search_paths——schema 约束 operation 为固定枚举，
        # 但模型调用可能省略该「实现细节」参数；声明值仍属合法操作域
        # 则判定目标成立，不做 fail-closed 误拒）
        declared = (
            (config or {}).get("operation")
            if isinstance(config, dict)
            else None
        )
        operation = declared if declared in _FILE_OPS_ACTIONS else None
        if operation is None:
            return None
    path = args.get("path")
    # 检索操作（search/search_paths）无 path 参数 = 全域检索：判定目标
    # 回落端点配置根目录（权限模式与沙箱按根目录校验，检索域 = 整个
    # 工作区根；带 path 时目标 = 该路径，检索域 = 路径内）
    if operation in ("search", "search_paths") and (
        not isinstance(path, str) or not path
    ) and isinstance(config, dict):
        path = config.get("root")
    if not isinstance(path, str) or not path:
        return None
    return (operation, path)


def _extract_mcp(
    args: dict[str, Any], config: dict | None = None
) -> tuple[str, str] | None:
    server_id = (config or {}).get("server_id") if isinstance(config, dict) else None
    return ("call", server_id) if isinstance(server_id, str) and server_id else None


def _extract_web_search(
    args: dict[str, Any], config: dict | None = None
) -> tuple[str, str] | None:
    query = args.get("query")
    return ("search", query) if isinstance(query, str) and query else None


def _extract_collab_request(
    args: dict[str, Any], config: dict | None = None
) -> tuple[str, str] | None:
    entity_id = args.get("entity_id")
    return ("request", entity_id) if isinstance(entity_id, str) and entity_id else None


def _extract_task_manager(
    args: dict[str, Any], config: dict | None = None
) -> tuple[str, str] | None:
    operation = args.get("operation")
    return ("manage", operation) if isinstance(operation, str) and operation else None


def _reason_http_fetch(
    args: dict[str, Any], config: dict | None = None
) -> str | None:
    url = args.get("url")
    if not isinstance(url, str) or not url:
        return "url 参数缺失或非法"
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return "url 无法解析"
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return "url 协议/主机非法（仅 http/https 且须含主机名）"
    return None


def _reason_process_exec(
    args: dict[str, Any], config: dict | None = None
) -> str | None:
    command_param = "command"
    if isinstance(config, dict):
        command_param = str(config.get("operation_param") or "command")
    if command_param == "argv":
        argv = coerce_argv(args.get("argv"))
        if not (argv and isinstance(argv[0], str)):
            return "argv 参数缺失或非法（应为字符串数组，如 [\"python\", \"--version\"]）"
        return None
    command = args.get(command_param)
    if not isinstance(command, str) or not command:
        return f"{command_param} 参数缺失或非字符串"
    return None


def _reason_file_ops(
    args: dict[str, Any], config: dict | None = None
) -> str | None:
    operation = args.get("operation")
    if operation not in _FILE_OPS_ACTIONS:
        declared = (
            (config or {}).get("operation")
            if isinstance(config, dict)
            else None
        )
        if declared in _FILE_OPS_ACTIONS:
            operation = declared
        else:
            allowed = "/".join(_FILE_OPS_ACTIONS)
            return f"operation 字段缺失或非法（合法值：{allowed}）"
    path = args.get("path")
    if not isinstance(path, str) or not path:
        return "path 参数缺失或非字符串"
    return None


def _reason_mcp(
    args: dict[str, Any], config: dict | None = None
) -> str | None:
    server_id = (config or {}).get("server_id") if isinstance(config, dict) else None
    if not (isinstance(server_id, str) and server_id):
        return "server_id 未配置（无法路由）"
    return None


def _reason_web_search(
    args: dict[str, Any], config: dict | None = None
) -> str | None:
    query = args.get("query")
    if not isinstance(query, str) or not query:
        return "query 参数缺失"
    return None


def _reason_collab_request(
    args: dict[str, Any], config: dict | None = None
) -> str | None:
    entity_id = args.get("entity_id")
    if not isinstance(entity_id, str) or not entity_id:
        return "entity_id 参数缺失或非法（须为已注册实体 id）"
    return None


def _reason_task_manager(
    args: dict[str, Any], config: dict | None = None
) -> str | None:
    operation = args.get("operation")
    if not isinstance(operation, str) or not operation:
        return "operation 参数缺失或非法（须为 create/update/complete/list/clear/delete 之一）"
    return None


# 内置端点类型注册表（模块加载期登记；重复登记 = 编程错误）
endpoint_registry = EndpointTypeRegistry()


def _register_builtin_endpoint(spec: EndpointTypeSpec) -> None:
    endpoint_registry.register(spec)


_register_builtin_endpoint(
    EndpointTypeSpec(
        name=EndpointType.HTTP_FETCH.value,
        actions=("connect",),
        extractor=_extract_http_fetch,
        failure_reason=_reason_http_fetch,
        output_fields=(
            SchemaField(name="status_code", required=True, kind=FIELD_NUMBER),
            SchemaField(name="body", required=True, kind=FIELD_STRING),
        ),
    )
)
_register_builtin_endpoint(
    EndpointTypeSpec(
        name=EndpointType.PROCESS_EXEC.value,
        actions=("exec",),
        config_requirements=("allowlist",),
        extractor=_extract_process_exec,
        failure_reason=_reason_process_exec,
        output_fields=(
            SchemaField(name="stdout", required=True, kind=FIELD_STRING),
            SchemaField(name="exit_code", required=True, kind=FIELD_NUMBER),
        ),
        sandbox_ops=("exec",),
        sandbox_builder=lambda definition: ProcessSandbox(
            allowlist=tuple(definition.endpoint_config["allowlist"]),
            path=definition.endpoint_config.get("path"),
        ),
    )
)
_register_builtin_endpoint(
    EndpointTypeSpec(
        name=EndpointType.FILE_OPS.value,
        actions=_FILE_OPS_ACTIONS,
        config_requirements=("root",),
        extractor=_extract_file_ops,
        failure_reason=_reason_file_ops,
        output_fields=(
            SchemaField(name="result", required=True, kind=FIELD_STRING),
        ),
        sandbox_ops=_FILE_OPS_ACTIONS,
        sandbox_builder=lambda definition: FileSandbox(
            root=definition.endpoint_config["root"]
        ),
    )
)
_register_builtin_endpoint(
    EndpointTypeSpec(
        name=EndpointType.MCP.value,
        actions=("call",),
        config_requirements=("server_id",),
        extractor=_extract_mcp,
        failure_reason=_reason_mcp,
        output_fields=(
            SchemaField(name="result", required=True, kind=FIELD_OBJECT),
        ),
    )
)
_register_builtin_endpoint(
    EndpointTypeSpec(
        name=EndpointType.WEB_SEARCH.value,
        actions=("search",),
        extractor=_extract_web_search,
        failure_reason=_reason_web_search,
        output_fields=(
            SchemaField(name="results", required=True, kind=FIELD_ARRAY),
        ),
    )
)
_register_builtin_endpoint(
    EndpointTypeSpec(
        name=EndpointType.COLLAB_REQUEST.value,
        actions=("request",),
        extractor=_extract_collab_request,
        failure_reason=_reason_collab_request,
    )
)
_register_builtin_endpoint(
    EndpointTypeSpec(
        name=EndpointType.TASK_MANAGER.value,
        actions=("manage",),
        extractor=_extract_task_manager,
        failure_reason=_reason_task_manager,
    )
)


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
        network_policy: 定义级网络策略（http_fetch 端点的域名白名单声明；
            None = 不声明，走流水线全局策略）——宿主顶层 policy 经此字段
            承载，不再折叠进 meta。
    """

    name: str
    description: str
    parameters: dict[str, Any] = field(default_factory=dict)
    permissions: tuple[str, ...] = ()
    # 端点类型：内置端点 = EndpointType 枚举成员；自定义端点 = 注册表名
    # （str，经 EndpointTypeRegistry 校验，构造期即 fail-closed）
    endpoint: EndpointType | str = EndpointType.HTTP_FETCH
    endpoint_config: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    network_policy: NetworkPolicy | None = None

    def __post_init__(self) -> None:
        # 端点归一：宿主可传字符串形态（"file_ops"）——构造期强制转为枚举，
        # 后续 is 比较/分发/序列化全部按枚举工作（构造成功即运行期可用，
        # 字符串形态不再出现「校验放行但 is 全 False」的静默失效）；非内置
        # 字符串 = 自定义端点（经 EndpointTypeRegistry 注册），保留字符串
        # 形态，经注册表解析/校验（构造期即 fail-closed）。
        if not isinstance(self.endpoint, EndpointType):
            endpoint = self.endpoint
            try:
                endpoint = EndpointType(endpoint)
            except ValueError:
                endpoint = str(endpoint)
            object.__setattr__(self, "endpoint", endpoint)
        self.validate()

    def validate(self) -> None:
        """定义期校验（fail-fast：权限缺失/权限声明非法/参数 schema 非法/
        端点白名单缺失——缺声明即拒绝，不延后到执行期）。
        命名规范断言不在此层：工具名规则在提案/自写边界执行
        （self_proposal 的 TOOL 补丁校验），本层承载的是通用定义形态
        校验——出厂基线工具（含历史下划线名）经装配路径注册不受影响，
        命名整改由产品层决策后统一执行。
        """
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
        spec = endpoint_registry.get(str(self.endpoint))
        if spec is None:
            raise GraphDefinitionError(
                f"工具 {self.name} 端点类型未注册: {self.endpoint!r}"
                "（须为内置端点或经 EndpointTypeRegistry.register 注册的自定义端点）"
            )
        endpoint_label = getattr(self.endpoint, "value", self.endpoint)
        for key in spec.config_requirements:
            if not self.endpoint_config.get(key):
                raise GraphDefinitionError(
                    f"工具 {self.name} 的 {endpoint_label} 端点须声明"
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
            # 定义期硬校验：parameters 声明的 operation enum 必须全部落在
            # 引擎操作域内（防「file_edit 自诞生起即不可达」类静默缺口——
            # 声明与提取器白名单不一致会在定义期暴露而非运行期 fail-closed）。
            op_enum = self._declared_operation_enum()
            allowed = set(spec.actions)
            unsupported = op_enum - allowed
            if unsupported:
                raise GraphDefinitionError(
                    f"工具 {self.name} 声明了引擎不支持的文件操作: "
                    f"{'、'.join(sorted(unsupported))}（合法值："
                    f"{'、'.join(sorted(allowed))}）"
                )

    def _declared_operation_enum(self) -> set[str]:
        """参数 schema 中声明的 operation 枚举值（缺声明 = 空集）。

        定义期硬校验的取数来源：声明式工具若在 parameters 里约束
        operation 的 enum，其值必须 ⊆ 引擎操作域（endpoint_operation
        白名单），否则运行期必然无法判定目标——提前到定义期暴露。
        """
        props = (
            self.parameters.get("properties") if isinstance(self.parameters, dict) else None
        )
        if not isinstance(props, dict):
            return set()
        op_schema = props.get("operation")
        if not isinstance(op_schema, dict):
            return set()
        enum = op_schema.get("enum")
        if not isinstance(enum, list):
            return set()
        return {str(v) for v in enum if isinstance(v, str)}

    def to_spec(self) -> ToolSpec:
        """转为引擎工具描述（参数 schema 与权限声明透传）。"""
        return ToolSpec(
            name=self.name,
            description=self.description,
            parameters=self.parameters,
            permissions=self.permissions,
        )

    def to_dict(self) -> dict:
        data: dict = {
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "permissions": list(self.permissions),
            "endpoint": getattr(self.endpoint, "value", self.endpoint),
            "endpoint_config": self.endpoint_config,
            "meta": self.meta,
        }
        if self.network_policy is not None:
            data["network_policy"] = {
                "allow_domains": sorted(self.network_policy.allow_domains)
            }
        return data

    @classmethod
    def from_dict(cls, data: dict) -> DeclarativeToolSpec:
        endpoint = data.get("endpoint", EndpointType.HTTP_FETCH.value)
        try:
            endpoint_enum = EndpointType(endpoint)
        except ValueError:
            # 自定义端点：保留字符串形态，构造期经 EndpointTypeRegistry 校验
            # （未注册 = 构造即拒绝，fail-closed）
            endpoint_enum = str(endpoint)
        network_policy: NetworkPolicy | None = None
        raw_policy = data.get("network_policy")
        if raw_policy is not None:
            if not isinstance(raw_policy, dict):
                raise GraphDefinitionError("network_policy 声明须为 dict")
            domains = raw_policy.get("allow_domains") or ()
            if not isinstance(domains, (list, tuple)) or not all(
                isinstance(domain, str) and domain for domain in domains
            ):
                raise GraphDefinitionError(
                    "network_policy.allow_domains 须为非空域名白名单清单"
                )
            network_policy = NetworkPolicy(
                allow_domains=frozenset(domains)
            )
        return cls(
            name=data["name"],
            description=data.get("description") or "",
            parameters=data.get("parameters") or {},
            permissions=tuple(data.get("permissions") or ()),
            endpoint=endpoint_enum,
            endpoint_config=data.get("endpoint_config") or {},
            meta=data.get("meta") or {},
            network_policy=network_policy,
        )


def coerce_argv(value: Any) -> list[str] | None:
    """argv 参数规范化：数组直通；JSON 字符串数组尝试解析。

    模型常把嵌套数组输出为 JSON 字符串（如 ``"[\"pip\", \"install\"]"``）——
    判定/执行须统一收口为真正数组，否则 fail-closed 误拒（无法判定目标）
    且执行体（命令面 = argv[0] 白名单）拿到字符串会拒绝。解析失败或
    非字符串元素 = None（调用方按缺参处理）。
    """
    if isinstance(value, list):
        return value if all(isinstance(x, str) for x in value) else None
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except ValueError:
            return None
        if isinstance(parsed, list) and all(isinstance(x, str) for x in parsed):
            return parsed
    return None


def endpoint_operation(
    endpoint: EndpointType | str, args: dict[str, Any], *, config: dict | None = None
) -> tuple[str, str] | None:
    """按端点类型从调用参数推导 (operation, target) 判定目标。

    端点语义经 :data:`endpoint_registry` 分发：内置端点的提取钩子与
    历史实现等价（http_fetch → ("connect", url host)；process_exec →
    ("exec", 命令名)，命令参数名可经 config 的 ``operation_param`` 声明；
    file_ops → (参数中声明的操作, 路径)；mcp → ("call", server_id)；
    web_search → ("search", query)；collab_request → ("request",
    entity_id)；task_manager → ("manage", operation)）；自定义端点取
    其注册表条目声明的 extractor 钩子。端点未注册 = None（无法判定目标，
    由流水线按缺判定目标 fail-closed 拒绝）。

    供 ToolPipeline 的 extractor 接线：声明式工具经此推导后走权限门禁
    与沙箱守卫（判定目标与执行参数一致，防二次拼接逃逸）。
    """
    spec = endpoint_registry.get(str(endpoint))
    if spec is None or spec.extractor is None:
        return None
    return spec.extractor(args, config)


def endpoint_operation_failure_reason(
    endpoint: EndpointType | str, args: dict[str, Any], *, config: dict | None = None
) -> str | None:
    """判定目标推导失败的结构化原因（供流水线 fail-closed 文案指引模型）。

    与 :func:`endpoint_operation` 同源分发：推导成功或端点未注册返回
    None；推导失败返回具体缺参/非法原因，让拒绝文案可指导模型自我纠正
    （如 file_ops 缺 operation 时列出合法值）。
    """
    spec = endpoint_registry.get(str(endpoint))
    if spec is None or spec.failure_reason is None:
        return None
    return spec.failure_reason(args, config)


# 执行体签名：async (ctx, spec, args, approval) -> str（ToolPipeline.executor 契约）
DeclarativeExecutor = Callable[..., Awaitable[str]]
class DeclarativeToolExecutors:
    """声明式工具执行体注册表：端点类型 → 执行体（宿主注入分发）。

    注册 = 插拔 U 盘：新增端点类型 = 注册新执行体，声明式工具零改动；
    未注册端点类型 = 分发处显式拒绝（fail-closed，不静默失败）。
    同名重复注册 = 覆盖（宿主启动按配置装配，配置驱动）。
    """

    def __init__(self) -> None:
        self._executors: dict[str, DeclarativeExecutor] = {}
        # 声明式定义登记表（工具名 → 定义）：执行体分发反查端点类型的来源
        self._definitions: dict[str, DeclarativeToolSpec] = {}

    def register(
        self, endpoint: EndpointType | str, executor: DeclarativeExecutor
    ) -> None:
        if not callable(executor):
            raise GraphDefinitionError(f"执行体须为可调用对象: {endpoint}")
        self._executors[str(endpoint)] = executor

    def get(self, endpoint: EndpointType | str) -> DeclarativeExecutor | None:
        return self._executors.get(str(endpoint))

    def has(self, endpoint: EndpointType | str) -> bool:
        return str(endpoint) in self._executors

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
        executor = self._executors.get(str(definition.endpoint))
        if executor is None:
            raise GraphDefinitionError(
                f"工具 {spec.name} 的端点类型未注册执行体: "
                f"{getattr(definition.endpoint, 'value', definition.endpoint)}"
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


def make_declarative_failure_reason(
    executors: DeclarativeToolExecutors,
) -> Callable[[ToolSpec, dict], str | None]:
    """声明式工具的判定失败原因钩子（ToolPipeline.failure_reason 接线）。

    与提取器同源反查定义：推导失败时给出结构化缺参/非法原因，供
    fail-closed 拒绝文案携带，指引模型自我纠正（不泄露敏感细节）。
    """

    def reason(spec: ToolSpec, args: dict) -> str | None:
        definition = executors.definitions.get(spec.name)
        if definition is None:
            return None
        return endpoint_operation_failure_reason(
            definition.endpoint, args, config=definition.endpoint_config
        )

    return reason


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
        if definition is None:
            # 无声明式定义 = 未登记工具：显式拒绝（fail-closed）——回退到
            # 调用方权限会放开「未登记定义但已登记权限」的绕过窗口
            return GateResult(
                DENY,
                name,
                operation,
                target,
                f"工具 {name} 无声明式定义（未登记），拒绝执行",
            )
        return self._inner.check(
            name, operation, target, permissions=definition.permissions
        )


class _NetworkReviewGate:
    """网络域名审批桥：白名单外 connect → 强制转审批（审批即网关）。

    放开语义：``NetworkPolicySandbox.unlisted_policy="review"`` 时，白名单
    外域名不再 fail-closed 拒绝，而是在门禁层强制 REVIEW——挂卡审批，
    审批决议 accept 后放行执行（沙箱同态放行）；白名单命中保持内层
    判定（免审批快速路径）。

    内层判定为 DENY 不升级（工具声明权限是边界，审批不越过声明权限
    拒绝——审批只救「权限已放行但白名单未命中」的域名）。
    """

    def __init__(self, inner: Any, sandbox: NetworkPolicySandbox) -> None:
        self._inner = inner
        self._sandbox = sandbox

    def check(self, name: str, operation: str, target: str, permissions=None):
        verdict = self._inner.check(
            name, operation, target, permissions=permissions
        )
        if verdict.decision != DENY and self._sandbox.requires_review(
            operation, target
        ):
            return GateResult(
                REVIEW,
                name,
                operation,
                target,
                "域名不在白名单（已转审批，审批通过后放行）",
            )
        return verdict


class _AutoDefinitionSandbox:
    """按调用时定义现取守卫的声明式沙箱（懒解析接线）。

    构建期快照问题：若在构建流水线后 register_definition 新工具，快照
    沙箱不含其守卫（file_ops 无根目录边界、process_exec 无命令白名单
    时仅靠权限 pattern 约束，纵深防御被削弱）。本沙箱在每次校验时按
    **当前调用工具自身定义**（spec.name 反查）构造守卫：事后注册的
    定义立即获得硬边界，且守卫语义与构建期接线等价（定义即权威）。
    """

    def __init__(
        self,
        executors: DeclarativeToolExecutors,
        registry: EndpointTypeRegistry | None = None,
    ) -> None:
        self._executors = executors
        self._registry = registry if registry is not None else endpoint_registry

    def guards_operation(self, operation: str, name: str | None = None) -> bool:
        # 守卫域由定义端点决定（ToolPipeline 透传 name 按调用工具判定）：
        # 端点声明了沙箱守卫操作才拦（process_exec → exec、file_ops →
        # FS 操作、自定义带沙箱端点）；无 name（旧调用面）回落端点无关
        # 的 exec/FS 操作域
        if name is not None:
            definition = self._executors.definitions.get(name)
            if definition is not None:
                spec = self._registry.get(str(definition.endpoint))
                return spec is not None and operation in spec.sandbox_ops
        return operation in ("exec",) or operation in _FS_GUARDED_OPS

    def validate(
        self, operation: str, target: str, name: str | None = None
    ) -> str | None:
        # 按当前调用工具自身定义构造沙箱：跨工具共享注册表时，工具 A
        # 的 root 硬边界不得被工具 B 的 root 放过（修复前取第一个匹配
        # 定义——同端点多定义时边界可被绕过）。定义缺失 = fail-closed
        # 拒绝（无沙箱边界的操作不得放行）；已注册端点按其注册表条目
        # 的 sandbox_builder 构造守卫，未声明本地沙箱的端点（mcp/
        # web_search/…）以门禁+审批为边界。
        definition = self._executors.definitions.get(name) if name else None
        if definition is not None:
            spec = self._registry.get(str(definition.endpoint))
            if spec is not None:
                if spec.sandbox_builder is not None:
                    sandbox = spec.sandbox_builder(definition)
                    resolved = sandbox.validate(operation, target)
                    return resolved if resolved is not None else target
                return target
        raise SandboxViolation(
            f"无声明式定义守卫操作 {operation!r}（工具 {name!r} 目标 {target!r}"
            " 无沙箱边界）"
        )


def build_declarative_pipeline(
    executors: DeclarativeToolExecutors,
    *,
    gate: Any = None,
    sandboxes: tuple[Any, ...] = (),
    network_policy: NetworkPolicy | None = None,
    network_unlisted_policy: str = "review",
    guards: tuple[Callable[..., Any], ...] = (),
    audit: Callable[..., Any] | None = None,
    max_result_chars: int = DEFAULT_MAX_RESULT_CHARS,
    trace_sink: Callable[..., Any] | None = None,
    registry: EndpointTypeRegistry | None = None,
) -> ToolPipeline:
    """声明式工具执行流水线装配（轻路径的引擎侧桥接）。

    extractor = 端点类型操作推导（endpoint_operation）、executor =
    端点执行体分发（DeclarativeToolExecutors.dispatch）——声明式工具
    经此走完整流水线（门禁 → 沙箱 → 守卫 → 审批 → 审计）。

    门禁默认 fail-closed：未注入 gate 时按 :class:`PermissionGate`
    默认策略（未声明权限/未命中 = 拒绝）兜底；判定一律按**定义声明的
    权限**（:class:`_DefinitionGate` 包装，调用方 spec 权限不参与）；
    沙箱自动接线：http_fetch 经 ``network_policy`` 并入网络守卫，
    带沙箱的端点（process_exec/file_ops/自定义声明 sandbox_ops 者）由
    :class:`_AutoDefinitionSandbox` 按调用时定义现取守卫（白名单/根目录
    在定义期强制声明，缺声明注册即拒绝；事后注册的新定义同样立即获得
    守卫）——声明了守卫域的端点全部有对应守卫，判定目标推导失败恒
    fail-closed 拒绝。

    ``registry`` 指定端点类型注册表（缺省 = 模块级 :data:`endpoint_registry`
    ——宿主自定义端点注册进同一注册表后此处自动生效）。

    ``network_unlisted_policy`` 控制白名单外域名的处置（默认
    ``"review"`` = 转审批，审批即网关；``"deny"`` = fail-closed
    硬拒，与沙箱原语一致）。review 档时白名单外域名由
    :class:`_NetworkReviewGate` 强制挂卡，审批通过后放行；白名单命中
    保持直过（免审批快速路径）。
    """
    from .tool_pipeline import ToolPipeline

    if gate is None:
        gate = PermissionGate()
    gate = _DefinitionGate(executors, gate)
    net_sandbox: NetworkPolicySandbox | None = None
    if network_policy is not None:
        net_sandbox = (
            network_policy
            if isinstance(network_policy, NetworkPolicySandbox)
            else NetworkPolicySandbox(
                allow_domains=network_policy.allow_domains,
                unlisted_policy=network_unlisted_policy,
            )
        )
        sandboxes = (*sandboxes, net_sandbox)
    if net_sandbox is not None and net_sandbox.unlisted_policy == "review":
        gate = _NetworkReviewGate(gate, net_sandbox)
    sandboxes = (*sandboxes, _AutoDefinitionSandbox(executors, registry))

    return ToolPipeline(
        gate=gate,
        extractor=make_declarative_extractor(executors),
        failure_reason=make_declarative_failure_reason(executors),
        sandboxes=sandboxes,
        guards=guards,
        executor=executors.dispatch,
        audit=audit,
        max_result_chars=max_result_chars,
        allow_unchecked=False,
        trace_sink=trace_sink,
    )


def make_http_fetch_executor(
    *, timeout: float = 30.0, max_chars: int = DEFAULT_MAX_RESULT_CHARS
) -> DeclarativeExecutor:
    """默认 http_fetch 执行体（httpx 可选依赖；未安装时调用即显式报错）。

    仅做受控抓取：超时 + 流式读取 + 字节上限截断（ENG6-9：不再整读
    响应再截断——响应流式消费，超限即停，防超大响应 OOM；与
    ProcessSandbox 输出截断同档防护）；域名白名单经
    :func:`build_declarative_pipeline` 的 ``network_policy`` 参数并入
    沙箱环节（NetworkPolicySandbox 在守卫层先行判定，执行体不再自行
    判断域名——守卫在前，执行在后）。
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
        # 流式读取 + 上限（ENG6-9）：响应不整读进内存——按 max_chars
        # 消费字节流，超出即停（溢出标记与整读语义一致）
        body: list[str] = []
        size = 0
        overflow = False
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client, client.stream(
            method, url, headers=headers
        ) as response:
            async for chunk in response.aiter_text():
                room = max_chars - size
                if room <= 0:
                    overflow = True
                    break
                body.append(chunk[:room])
                size += len(body[-1])
                if len(chunk) > room:
                    overflow = True
                    break
        text = "".join(body)
        if overflow:
            text += "\n…（溢出截断）"
        return f"HTTP {response.status_code}\n{text}"

    return execute


# ── 声明 → 结点契约（契约映射：input=parameters，output=端点操作结果形态）──

# JSON Schema 类型 → SchemaField 类型映射（未知类型回落字符串，宁宽松不误拒）
_JSON_SCHEMA_TO_FIELD: dict[str, str] = {
    "string": FIELD_STRING,
    "integer": FIELD_NUMBER,
    "number": FIELD_NUMBER,
    "boolean": FIELD_BOOL,
    "object": FIELD_OBJECT,
    "array": FIELD_ARRAY,
}

# 审批档 → 契约安全档（与审批档同阶：allow=0 最严 / review=1 / deny=2）
_APPROVAL_TO_SAFETY_TIER: dict[str, int] = {
    "allow": 0,
    "review": 1,
    "deny": 2,
}

# 端点操作结果形态已折叠进 EndpointTypeSpec.output_fields（注册表条目）——
# tool_contract_from_declaration 按端点注册表取数，无独立模块级清单。


def _field_from_property(name: str, prop: Any, required: bool) -> SchemaField:
    """JSON Schema 属性 → SchemaField（类型/枚举/边界透传；未知回落字符串）。"""
    if not isinstance(prop, dict):
        return SchemaField(name=name, required=required, kind=FIELD_STRING)
    kind = _JSON_SCHEMA_TO_FIELD.get(str(prop.get("type") or "string"), FIELD_STRING)
    enum = tuple(str(item) for item in prop.get("enum") or ())
    minimum = prop.get("minimum")
    maximum = prop.get("maximum")
    return SchemaField(
        name=name,
        required=required,
        kind=kind,
        enum=enum,
        min=float(minimum) if isinstance(minimum, (int, float)) else None,
        max=float(maximum) if isinstance(maximum, (int, float)) else None,
    )


def tool_contract_from_declaration(
    spec: DeclarativeToolSpec, *, version: int | None = None
) -> NodeContract:
    """工具声明 → 结点契约（input=parameters，output=端点操作结果形态）。

    契约生成是纯数据变换：parameters 的 JSON Schema 属性逐项映射为
    SchemaField（必填/类型/枚举/边界透传），output 按端点类型给出操作
    结果形态（process_exec → stdout/exit_code，file_ops → result，
    mcp → result 对象，http_fetch → status_code/body，web_search →
    results 数组）；安全档按审批档同阶映射（allow=0/review=1/deny=2）；
    契约版本缺省取声明 meta.contract_version，无则 1。

    Args:
        spec: 声明式工具定义（工具表唯一登记来源）。
        version: 契约版本覆盖（缺省 = meta.contract_version 或 1）。

    Returns:
        结点契约（input_schema/output_schema 均为 SchemaSpec 数据形态，
        随补丁链版本化/回退）。
    """
    from .schema_validator import SchemaSpec

    properties = spec.parameters.get("properties") or {}
    if not isinstance(properties, dict):
        raise GraphDefinitionError(
            f"工具 {spec.name} 参数 properties 须为 dict（契约映射前提）"
        )
    required = set(spec.parameters.get("required") or ())
    input_fields = tuple(
        _field_from_property(str(name), prop, str(name) in required)
        for name, prop in properties.items()
    )
    endpoint_spec = endpoint_registry.get(str(spec.endpoint))
    output_fields = endpoint_spec.output_fields if endpoint_spec is not None else ()
    if not output_fields:
        output_fields = (
            SchemaField(name="result", required=True, kind=FIELD_STRING),
        )
    contract_version = version
    if contract_version is None:
        raw = spec.meta.get("contract_version")
        contract_version = int(raw) if isinstance(raw, (int, float)) else 1
    return NodeContract(
        input_schema=SchemaSpec(name=f"{spec.name}.input", fields=input_fields),
        output_schema=SchemaSpec(name=f"{spec.name}.output", fields=output_fields),
        safety_tier=_APPROVAL_TO_SAFETY_TIER.get(
            str(spec.meta.get("approval") or "review"), 1
        ),
        version=contract_version,
    )


def tool_node_mapping(
    definitions: list[DeclarativeToolSpec],
) -> dict[str, str]:
    """工具表 → 结点池映射（node_type == tool_name，同源单一事实）。

    结点池条目与工具表共享同一登记来源：工具登记即结点类型登记，任一
    漂移（工具名重复/结点类型被占）在此显式报错，不做静默覆盖。

    Returns:
        {tool_name: node_type}（本实现口径下恒为同名字典，契约锚点）。
    """
    mapping: dict[str, str] = {}
    for definition in definitions:
        if definition.name in mapping:
            raise GraphDefinitionError(f"工具名重复（结点池同源冲突）: {definition.name}")
        mapping[definition.name] = definition.name
    return mapping


def node_contracts_from_tools(
    definitions: list[DeclarativeToolSpec],
) -> dict[str, NodeContract]:
    """工具表 → 结点池条目（结点类型 = 工具名；契约 = 自动生成）。

    Args:
        definitions: 声明式工具定义清单（工具表同一登记来源）。

    Returns:
        {node_type: NodeContract}——结点池按此登记，与工具表同源。
    """
    mapping = tool_node_mapping(definitions)
    contracts: dict[str, NodeContract] = {}
    for definition in definitions:
        contracts[mapping[definition.name]] = tool_contract_from_declaration(definition)
    return contracts


def validate_tool_node_consistency(
    node_pool: dict[str, NodeContract],
    definitions: list[DeclarativeToolSpec],
) -> list[str]:
    """结点池 ↔ 工具表一致性校验（同源门禁的观察侧）。

    .. note:: 离线审计工具（ENG6-8）：本门禁不被 harness.build_tools
       装配路径自动调用（harness 注册期校验在 harness 模块归口）——
       定位 = 离线审计/回归工具：装配期门禁消费由宿主在构建处显式
       调用（如 CI/self_check 对登记结果跑一致性核对），本函数只做
       纯计算不做任何装配副作用。

    Returns:
        违规清单（空 = 一致）：结点池条目与工具表同源——结点类型缺失、
    多余、契约输入/输出形态与自动生成不一致均列入，供装配期门禁消费。
    """
    issues: list[str] = []
    expected = node_contracts_from_tools(definitions)
    for node_type in sorted(set(node_pool) | set(expected)):
        if node_type not in node_pool:
            issues.append(f"结点池缺工具映射类型: {node_type}")
            continue
        if node_type not in expected:
            issues.append(f"结点池存在工具表外类型: {node_type}")
            continue
        actual = node_pool[node_type]
        want = expected[node_type]
        if actual.input_schema != want.input_schema:
            issues.append(f"结点 {node_type} 输入契约与工具声明不符")
        if actual.output_schema != want.output_schema:
            issues.append(f"结点 {node_type} 输出契约与工具声明不符")
    return issues


__all__ = [
    "DeclarativeExecutor",
    "DeclarativeToolExecutors",
    "DeclarativeToolSpec",
    "EndpointType",
    "EndpointTypeRegistry",
    "EndpointTypeSpec",
    "build_declarative_pipeline",
    "coerce_argv",
    "endpoint_operation",
    "endpoint_registry",
    "make_declarative_extractor",
    "make_http_fetch_executor",
    "node_contracts_from_tools",
    "tool_contract_from_declaration",
    "tool_node_mapping",
    "validate_tool_node_consistency",
]
