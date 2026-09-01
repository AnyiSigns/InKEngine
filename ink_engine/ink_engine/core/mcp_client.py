"""MCP 客户端适配器：把外部 MCP server 的工具借为引擎声明式工具。

外部 MCP server（市场/自建/stdio/远程 HTTP）是 AI 可借用的工具来源：
本模块把 server 暴露的工具「借」进引擎工具表，复用既有声明式工具
流水线——vetting 闸门（可信度审查）、权限门禁（``mcp:call:<server_id>``）、
沙箱守卫（MCP 端点无本地沙箱，调用经远程会话转发）与审计留痕全部
沿用，新增的只是「端点类型 = MCP」这一接线分支。

设计要点（与引擎内核零依赖原则一致）：
- ``mcp`` SDK 为可选依赖：连接/调用函数内惰性 import，未安装时显式报错
  并给出安装提示，模块导入与纯函数（工具转换）不受其影响；
- 工具转换是纯函数（无 SDK 依赖）：MCP 工具描述 → ``DeclarativeToolSpec``，
  经同一套定义期校验（权限强制声明、server_id 路由密钥必填）；
- 连接生命周期归 ``McpClientManager``：会话按 server_id 路由，分发执行器
  经 ``DeclarativeToolExecutors`` 注册即插即用，未挂载 server 的调用
  fail-closed 拒绝；
- 挂载必经 vetting 闸门：每个导入工具生成 ``ToolManifest`` 供
  ``ToolVetting`` 审查（来源/签名/权限声明），被拒工具不进入工具表
  （fail-closed，不静默放行）。

传输形态（Streamable HTTP 为主，stdio 次之，内存用于内嵌/测试）：
- http：``streamable_http_client(url, http_client=...)``（MCP v2 规范主传输）；
- stdio：自写传输（线程私有事件循环 + JSON-RPC 分帧，见
  ``_ThreadedMcpTransport``）拉起本地进程——不依赖 mcp SDK 的 anyio
  封装，跨 boot/round/stop 的事件循环切换稳定；执行件的 stderr（结构化
  日志通道）捕获进引擎日志，不裸露到终端；
- in_memory：宿主注入 ``server_factory``（返回 (read, write) 流对的异步
  上下文管理器），用于内嵌 server 或测试桩，不依赖真实网络/进程。
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import contextvars
import itertools
import json
import logging
import os
import shutil
import tempfile
import threading
from collections.abc import Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, TextIO

from .declarative_tools import (
    DeclarativeToolExecutors,
    DeclarativeToolSpec,
    EndpointType,
)
from .exceptions import GraphDefinitionError
from .logging import get_logger
from .tool_pipeline import DEFAULT_MAX_RESULT_CHARS
from .tool_vetting import (
    ShadowRunResult,
    ToolManifest,
    ToolSource,
    ToolVetting,
    VettingVerdict,
)

logger = get_logger(__name__)

# 连接/调用超时（秒）：MCP 握手与工具调用均须有上界，避免无限挂起拖垮回合
_CONNECT_TIMEOUT = 30.0
_CALL_TIMEOUT = 60.0

# stdio 帧协议形态：本环境 MCP stdio 生态（SDK 2.x 客户端/服务端、
# 内置执行件 inkling_exec）均为 **JSON Lines**（每行一个 JSON，无
# header）——协议层以 json_lines 为缺省；``Content-Length`` 分帧为
# 旧标准兼容形态（读侧自适应，写侧按配置显式启用）。
CONTENT_LENGTH_FRAMING = "content_length"
JSON_LINES_FRAMING = "json_lines"

# stdio 单帧上限（字节）：Content-Length 分帧的可信上界。恶意/异常
# server 可声明超大 Content-Length 诱导引擎分配巨量缓冲（内存耗尽），
# 读侧按此上限 fail-closed 断开连接。
MAX_STDIO_FRAME_BYTES = 16 * 1024 * 1024

# stdio 进程监督的保守缺省值（重启策略是数据字段，缺省取此处）：
# 重启尝试 2 次、间隔 1s、连续 3 次「重试耗尽」即熔断（进程反复
# 秒崩是环境性故障，持续拉起只会拖垮回合——fail-closed 上报）。
_DEFAULT_STDIO_RESTART_RETRIES = 2
_DEFAULT_STDIO_RESTART_BACKOFF = 1.0
_DEFAULT_STDIO_CIRCUIT_BREAK_THRESHOLD = 3

# 工具调用结果文本截断上限（ENG6-6：与引擎 tool_pipeline.DEFAULT_MAX_RESULT_CHARS
# 共享常量——MCP server 响应同样可能大对象挤爆上下文，单点维护防漂移）
_MAX_RESULT_CHARS = DEFAULT_MAX_RESULT_CHARS

# 内存传输的 server 工厂签名：() -> 异步上下文管理器，产出 (read, write) 流对
ServerFactory = Callable[[], Any]


class McpTransport(StrEnum):
    """MCP 连接传输形态（HTTP 为主，stdio 次之，内存用于内嵌/测试）。"""

    HTTP = "http"
    STDIO = "stdio"
    IN_MEMORY = "in_memory"


@dataclass(frozen=True, slots=True)
class StdioRestartPolicy:
    """stdio 进程重启策略（数据化声明；缺省 = 保守安全值）。

    Attributes:
        max_retries: 单次崩溃后的重启尝试上限（0 = 不拉起，fail-fast）。
        backoff: 相邻重启尝试的等待秒数（秒；固定退避，节奏可预期）。
        circuit_break_threshold: 连续「重试耗尽」事件次数达到阈值 =
            熔断打开——不再尝试拉起，调用直接 fail-closed（错误上报，
            进程反复崩溃是环境性问题，持续拉起徒增噪声与成本）。
    """

    max_retries: int = _DEFAULT_STDIO_RESTART_RETRIES
    backoff: float = _DEFAULT_STDIO_RESTART_BACKOFF
    circuit_break_threshold: int = _DEFAULT_STDIO_CIRCUIT_BREAK_THRESHOLD

    def __post_init__(self) -> None:
        if self.max_retries < 0:
            raise ValueError(f"重启尝试次数不能为负: {self.max_retries}")
        if self.backoff < 0:
            raise ValueError(f"重启退避秒数不能为负: {self.backoff}")
        if self.circuit_break_threshold < 1:
            raise ValueError(
                f"熔断阈值须 >= 1: {self.circuit_break_threshold}"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_retries": self.max_retries,
            "backoff": self.backoff,
            "circuit_break_threshold": self.circuit_break_threshold,
        }

    @classmethod
    def from_dict(cls, data: Any) -> StdioRestartPolicy:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"stdio 重启策略非法: 期望 dict，收到 {type(data).__name__}"
            )
        return cls(
            max_retries=data.get("max_retries", _DEFAULT_STDIO_RESTART_RETRIES),
            backoff=float(data.get("backoff", _DEFAULT_STDIO_RESTART_BACKOFF)),
            circuit_break_threshold=data.get(
                "circuit_break_threshold", _DEFAULT_STDIO_CIRCUIT_BREAK_THRESHOLD
            ),
        )


class McpToolImportError(GraphDefinitionError):
    """MCP server 工具导入失败（连接/列表/转换/vetting 任一环节报错）。

    继承 GraphDefinitionError：导入失败属定义期错误，宿主在挂载流程中
    捕获后转拒绝（不静默降级为「无工具」）。
    """


def _require_mcp():
    """惰性引入 mcp SDK（可选依赖）：未安装时抛清晰错误 + 安装提示。

    连接/调用路径才需要 SDK；纯函数（工具转换/清单生成）不触碰此路径，
    保证模块导入与单元测试零外部依赖。返回的模块为 ``mcp`` 顶层包。
    """
    try:
        import mcp
    except ImportError as exc:
        raise RuntimeError(
            "MCP 适配器依赖官方 mcp SDK（pip install mcp），未安装；"
            "安装后即可挂载外部 MCP server 工具"
        ) from exc
    return mcp


# mcp SDK 为可选依赖（见 _require_mcp）：本模块导入零 SDK 依赖——
# 连接/调用路径才惰性引入；2.x 更名（streamable_http_client/is_error/
# input_schema）为唯一契约（pyproject 下限 mcp>=2.0）。


@dataclass(frozen=True, slots=True)
class McpServerConfig:
    """MCP server 连接配置（数据形态，可持久化进集数据通道）。

    Attributes:
        id: server 唯一标识（会话路由密钥 + 权限域 ``mcp:call:<id>``）。
        transport: 传输形态（http/stdio/in_memory）。
        url: Streamable HTTP 端点（transport=http 时必填）。
        headers: HTTP 附加请求头（鉴权 token 等，仅 http；持久化时注意
            敏感信息——请求头不是凭据保险箱）。
        command: 本地可执行命令（transport=stdio 时必填）。
        args: 命令参数清单。
        env: 子进程环境变量（仅 stdio；缺省继承宿主环境；repr 遮蔽，
            防日志/调试输出泄漏凭据）。
        source: 工具来源分类（vetting 闸门的可信度依据）。
        signature: 来源签名（已审批挂载的连接身份标识；显式提供时
            vetting 清单使用真签名，缺省由 server id 派生连接身份）。
        server_factory: 内存传输的 server 工厂（transport=in_memory 时必填）；
            非序列化字段，持久化时忽略。
        restart_policy: stdio 进程监督的重启策略（仅 stdio 生效；None =
            缺省保守值）。http 传输的会话重建由协议层（reconnect）承担，
            内存传输无进程可监督——两者不受此字段影响。
        stdio_framing: stdio 帧协议形态（仅 stdio 生效）：``json_lines``
            = 每行一个 JSON（本环境缺省：SDK 2.x 与内置执行件 inkling_exec
            均为该形态）；``content_length`` = MCP 旧标准 Content-Length
            分帧（兼容形态，读侧自适应、写侧显式启用）。
    """

    id: str
    transport: McpTransport = McpTransport.HTTP
    url: str | None = None
    headers: dict[str, str] | None = field(default=None, repr=False)
    command: str | None = None
    args: tuple[str, ...] = ()
    env: dict[str, str] | None = field(default=None, repr=False)
    source: ToolSource = ToolSource.UNKNOWN
    signature: str | None = None
    server_factory: ServerFactory | None = field(default=None, repr=False)
    restart_policy: StdioRestartPolicy | None = None
    stdio_framing: str = JSON_LINES_FRAMING

    def to_dict(self, *, redact_credentials: bool = False) -> dict[str, Any]:
        """序列化（可持久化进集数据通道）。

        Args:
            redact_credentials: True = 凭据字段（headers/env 中的鉴权值）
                以 [REDACTED] 占位——持久化/审计等不恢复连接形态的落库
                路径应显式传 True，避免鉴权 token 明文留存；配置往返
                （需还原重连）保持 False。
        """
        data: dict[str, Any] = {
            "id": self.id,
            "transport": self.transport.value,
            "source": self.source.value,
        }
        if self.url:
            data["url"] = self.url
        if self.headers:
            data["headers"] = (
                {k: ("[REDACTED]" if v else v) for k, v in self.headers.items()}
                if redact_credentials
                else dict(self.headers)
            )
        if self.command:
            data["command"] = self.command
        if self.args:
            data["args"] = list(self.args)
        if self.env:
            data["env"] = (
                {k: ("[REDACTED]" if v else v) for k, v in self.env.items()}
                if redact_credentials
                else dict(self.env)
            )
        if self.signature:
            data["signature"] = self.signature
        if self.restart_policy is not None:
            data["restart_policy"] = self.restart_policy.to_dict()
        if self.stdio_framing != JSON_LINES_FRAMING:
            data["stdio_framing"] = self.stdio_framing
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> McpServerConfig:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"MCP 配置非法: 期望 dict，收到 {type(data).__name__}"
            )
        server_id = data.get("id")
        if not server_id or not isinstance(server_id, str):
            raise GraphDefinitionError("MCP 配置缺 id（字符串）")
        try:
            transport = McpTransport(data.get("transport", McpTransport.HTTP.value))
        except ValueError as exc:
            raise GraphDefinitionError(
                f"MCP 配置传输形态非法: {data.get('transport')!r}"
            ) from exc
        try:
            source = ToolSource(data.get("source", ToolSource.UNKNOWN.value))
        except ValueError as exc:
            raise GraphDefinitionError(
                f"MCP 配置来源分类非法: {data.get('source')!r}"
            ) from exc
        headers = data.get("headers")
        if headers is not None and not isinstance(headers, dict):
            raise GraphDefinitionError("MCP 配置 headers 须为 dict（请求头映射）")
        env = data.get("env")
        if env is not None and not isinstance(env, dict):
            raise GraphDefinitionError("MCP 配置 env 须为 dict（环境变量映射）")
        restart_policy = data.get("restart_policy")
        if restart_policy is not None and not isinstance(restart_policy, dict):
            raise GraphDefinitionError(
                "MCP 配置 restart_policy 须为 dict（重启策略声明）"
            )
        stdio_framing = data.get("stdio_framing", JSON_LINES_FRAMING)
        if stdio_framing not in (CONTENT_LENGTH_FRAMING, JSON_LINES_FRAMING):
            raise GraphDefinitionError(
                f"MCP 配置 stdio_framing 非法: {stdio_framing!r}"
                "（须为 content_length 或 json_lines）"
            )
        return cls(
            id=server_id,
            transport=transport,
            url=data.get("url"),
            headers=dict(headers) if headers else None,
            command=data.get("command"),
            args=tuple(data.get("args") or ()),
            env=dict(env) if env else None,
            source=source,
            signature=data.get("signature"),
            restart_policy=(
                StdioRestartPolicy.from_dict(restart_policy)
                if restart_policy is not None
                else None
            ),
            stdio_framing=stdio_framing,
        )


# ── 内置 MCP server 注册表（tools.json mcp 工具声明的 server_id 定义）──
# tools.json 中 13 个 endpoint=mcp 工具的 server_id 归并后仅两个：
# inkling_exec（研究链/OS 感知执行件，随包二进制的 stdio 服务）与
# inkling_shell（壳自身能力：设备感知/文档/截图/素材，宿主注入的内存
# 嵌入服务）。本表 = Python 侧权威定义（server_id → 传输形态/来源/
# 签名）；环境相关连接位（stdio 命令路径、in_memory 工厂）由宿主装配
# 期经 ``builtin_mcp_server_config`` 填充——声明层与真实连接由此对齐，
# 未注册 server_id 的调用走 McpClientManager fail-closed 拒绝。
BUILTIN_MCP_SERVERS: dict[str, McpServerConfig] = {
    "inkling_exec": McpServerConfig(
        id="inkling_exec",
        transport=McpTransport.STDIO,
        source=ToolSource.GITHUB,
        signature="builtin:inkling_exec",
        # 内置执行件以 ts_seed_pack 先例走 JSON Lines stdio（无
        # Content-Length 头，每行一个 JSON）——自写传输按此形态收发。
        stdio_framing=JSON_LINES_FRAMING,
    ),
    "inkling_shell": McpServerConfig(
        id="inkling_shell",
        transport=McpTransport.IN_MEMORY,
        source=ToolSource.GITHUB,
        signature="builtin:inkling_shell",
    ),
}


def builtin_mcp_server_config(
    server_id: str, **overrides: Any
) -> McpServerConfig | None:
    """内置 server 定义（注册表权威 + 宿主填充连接位）。

    ``overrides`` 只允许覆盖环境相关连接参数（command/args/url/headers/
    env/server_factory/restart_policy）；传输形态/来源/签名以注册表为
    准（宿主不得改写——防改头换面挂载）。未知 server_id 返回 None
    （fail-closed：未定义即不可连接）。
    """
    base = BUILTIN_MCP_SERVERS.get(server_id)
    if base is None:
        return None
    if any(k in overrides for k in ("id", "transport", "source", "signature")):
        raise GraphDefinitionError(
            f"内置 server 注册表字段不可覆盖: {server_id}"
        )
    unknown = set(overrides) - set(McpServerConfig.__dataclass_fields__)
    if unknown:
        raise GraphDefinitionError(
            f"内置 server 连接参数未知字段: {sorted(unknown)}"
        )
    return McpServerConfig(
        id=base.id,
        transport=base.transport,
        url=overrides.get("url", base.url),
        headers=overrides.get("headers", base.headers),
        command=overrides.get("command", base.command),
        args=overrides.get("args", base.args),
        env=overrides.get("env", base.env),
        source=base.source,
        signature=base.signature,
        server_factory=overrides.get("server_factory", base.server_factory),
        restart_policy=overrides.get("restart_policy", base.restart_policy),
        stdio_framing=overrides.get("stdio_framing", base.stdio_framing),
    )


def _normalize_input_schema(schema: Any) -> dict[str, Any]:
    """MCP 工具 inputSchema → 引擎参数 JSON Schema（缺省兜底为空对象）。

    MCP 与 OpenAI 兼容工具均使用 JSON Schema，字段大体兼容；此处只做
    最小规范化（保证 type=object、properties 为 dict），不重写语义。
    """
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}
    normalized = dict(schema)
    if normalized.get("type") not in ("object", None):
        normalized["type"] = "object"
    if not isinstance(normalized.get("properties"), dict):
        normalized["properties"] = {}
    return normalized


def convert_mcp_tool(server_id: str, tool: Any) -> DeclarativeToolSpec:
    """MCP 工具 → 声明式工具定义（纯函数，无 SDK 依赖，可独立测试）。

    字段映射：name/description/input_schema → 同名；端点固定 MCP，
    路由密钥 ``server_id`` 写入 endpoint_config（定义期必填校验）；权限
    统一为 ``mcp:call:<server_id>``（按 server 粒度管控，宿主放行即整
    server 可信）。约定优于配置：MCP 工具无需逐个手工声明权限。

    Args:
        server_id: 来源 server 标识。
        tool: MCP SDK 的 Tool 对象（鸭子类型读取 name/description/
            input_schema，2.x 实例属性为 snake_case；inputSchema 仅作
            遗留形态/JSON 往返的防御性回退）或等价 dict。

    Raises:
        GraphDefinitionError: 工具缺 name（MCP 协议违规）。
    """
    if isinstance(tool, dict):
        name = tool.get("name")
        description = tool.get("description") or ""
        # 2.x 字段形态是 input_schema（SDK 1.x 的 inputSchema 仅作
        # 遗留序列化数据回退）——两形态等价读取，参数 schema 不归一空壳
        schema = tool.get("input_schema")
        if schema is None:
            schema = tool.get("inputSchema")
    else:
        name = getattr(tool, "name", None)
        description = getattr(tool, "description", "") or ""
        schema = getattr(tool, "input_schema", None)
        if schema is None:
            schema = getattr(tool, "inputSchema", None)
    if not name or not isinstance(name, str):
        raise GraphDefinitionError("MCP 工具缺 name（协议违规）")
    return DeclarativeToolSpec(
        name=name,
        description=description,
        parameters=_normalize_input_schema(schema),
        permissions=(f"mcp:call:{server_id}",),
        endpoint=EndpointType.MCP,
        endpoint_config={"server_id": server_id},
        meta={"mcp_server": server_id},
    )


def build_mcp_manifest(
    server_id: str, tool: Any, *, source: ToolSource, signature: str | None = None
) -> ToolManifest:
    """为导入的 MCP 工具生成 vetting 清单（身份声明，供可信度闸门审查）。

    来源按配置分类；签名取挂载提供的显式签名（已审批连接的身份标识），
    缺省退化为 server 身份派生值——派生值只证明工具出自「某个」连接，
    不能替代真实审批签名，仅用于保证清单形态完整（否则来源未知且无
    签名的工具会被清单校验直接拒绝，无法进入静态审查环节）。
    权限统一声明，清单校验不缺项。
    """
    if isinstance(tool, dict):
        name = tool.get("name") or f"{server_id}:tool"
    else:
        name = getattr(tool, "name", None) or f"{server_id}:tool"
    return ToolManifest(
        name=name,
        source=source,
        signature=signature or f"mcp:{server_id}:{name}",
        permissions=(f"mcp:call:{server_id}",),
        meta={"mcp_server": server_id},
    )


def _probe_args_from_schema(schema: Any) -> dict[str, Any]:
    """观察探针的调用参数派生（只取带默认值的可选参数，不猜必填字段）。

    观察模式 = 行为证据探针：无默认值参数为必填语义（真实调用由宿主
    后续提供），探针绝不臆造必填参数——宁可调用失败（诚实留痕）也
    不产生不可控的远端副作用。空 schema/无默认值 = 空参探针。
    """
    if not isinstance(schema, dict):
        return {}
    props = schema.get("properties")
    if not isinstance(props, dict):
        return {}
    return {
        name: prop["default"]
        for name, prop in props.items()
        if isinstance(prop, dict) and "default" in prop
    }


class McpSessionHandle:
    """已连接 MCP 会话的句柄（按 server_id 路由；分发执行器据此调用）。

    抽象出 list_tools / call_tool 两个能力，便于测试以假实现替换真实
    SDK 会话（不依赖网络/进程即可验证转换与分发逻辑）。
    """

    async def list_tools(self) -> list[Any]:
        raise NotImplementedError

    async def call_tool(self, name: str, args: dict[str, Any]) -> str:
        raise NotImplementedError

    async def aclose(self) -> None:
        """释放会话与底层传输（连接生命周期归 manager 调用）。"""
        return None


def _outer_cancellation_requested() -> bool:
    """当前任务是否正被外部取消（真取消 vs SDK 内部取消的区分判据）。

    SDK 内部取消只会把 CancelledError 抛进本协程，不会改变本任务的
    取消计数；外部 ``task.cancel()`` 会先增加计数再投递异常——计数
    归零的 CancelledError 属 SDK 内部失败路径，收敛为导入错误。
    """
    task = asyncio.current_task()
    return task is not None and task.cancelling() > 0


async def _suppress_stack_close(exit_stack: AsyncExitStack) -> None:
    """尽力关闭退出栈（失败只记日志：清理不掩盖原始错误）。"""
    try:
        await exit_stack.aclose()
    except BaseException as exc:
        logger.warning("MCP 连接清理失败（不掩盖原始错误）: %s", exc)


def _is_connection_lost(exc: BaseException) -> bool:
    """连接层断流判定（决定拉起后是否重试一次原操作）。

    覆盖自写传输（``_McpConnectionLost``）与 MCP/anyio 在嵌入环境的
    主要断流形态；业务错误（server 已受理返回）不含这些标记，不判为
    连接丢失。
    """
    if isinstance(exc, _McpConnectionLost):
        return True
    text = str(exc).lower()
    return (
        "connection closed" in text
        or "connection lost" in text
        or "reset by peer" in text
        or "broken pipe" in text
        or "stream closed" in text
        or "remote end closed" in text
    )


def _is_business_error(exc: BaseException) -> bool:
    """业务失败判定（server 已受理并返回结构化错误）。

    ``_SdkSession.call_tool`` 对 ``result.isError``（参数缺失/校验失败等）
    抛 ``MCP 工具执行失败``——这是 server 端业务结论，不是进程崩溃：
    直接透传给上层，不触发 stdio 拉起、不谎报「进程崩溃」。
    """
    return "MCP 工具执行失败" in str(exc)


def _is_mcp_business_reject(exc: BaseException) -> bool:
    """server 业务拒绝判定（JSON-RPC error 形态）。

    自写传输的 ``_RpcError``：server 已受理并返回结构化 error 对象
    （含 -32602 参数校验、-32601 方法不存在等）——都是业务结论，不是
    连接断流（断流形态是 ``_McpConnectionLost``，走另一判据）。SDK 的
    ``MCPError`` 区分依据 = 错误码：只把 -32602 判为业务拒绝（SDK 将
    连接断流也表达为 MCPError，按 code 区分，断流原样透传交监督）。
    """
    if isinstance(exc, _RpcError):
        return True
    if type(exc).__name__ != "MCPError":
        return False
    return getattr(exc, "code", None) == -32602


def _forward_exec_line(log: logging.Logger, line: str) -> None:
    """单行执行件 stderr → 引擎日志通道（结构化行按 level 分级落明）。

    执行件把 stderr 当结构化日志通道（JSON 行：事件/请求 id/耗时/成败）；
    非结构化行（告警/panic 文本）按 info 落明不丢失。
    """
    try:
        is_error = json.loads(line).get("level") == "error"
    except ValueError:
        is_error = False
    if is_error:
        log.error("执行件: %s", line)
    else:
        log.info("执行件: %s", line)


# ── 自写 MCP stdio 传输（线程私有事件循环）────────────────────────────
# 引擎主体是单进程 asyncio（README 契约：不做多 worker 分布式执行）；
# 但 headless 壳每次 ``pyo3_async_runtimes::tokio::run`` 都会新建并销毁
# asyncio event loop（crate generic::run = new_event_loop + close）——任何
# 生命周期绑在「某一次 loop」上的异步资源（mcp SDK 的 anyio cancel
# scope、asyncio 子进程句柄）都会在跨 op（boot/round/stop）时崩溃。
# 自写传输把 stdio 会话整体放进**独立工作线程的私有 asyncio loop**：
# 该 loop 生命周期 = 线程 = 连接生命周期（= 引擎生命周期）。引擎侧
# 任意 loop/task 经 ``call_soon_threadsafe`` 提交请求、经
# ``concurrent.futures.Future`` 回收结果——与调用侧 loop 完全解耦，
# 无 task 亲和、无 cancel scope 约束。

_MCP_PROTOCOL_VERSION = "2025-03-26"
_MCP_CLIENT_NAME = "ink-engine"
_MCP_CLIENT_VERSION = "1.0"


class _RpcError(Exception):
    """MCP JSON-RPC error（server 返回的 error 对象）。

    自写传输以结构化 code/message 保留 server 的 JSON-RPC 错误结论，
    供业务拒绝（-32602 参数校验）与连接断流判别。
    """

    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"MCP JSON-RPC 错误（code={code}）: {message}")
        self.code = code
        self.message = message


class _McpConnectionLost(RuntimeError):
    """自写 stdio 传输的连接断流（子进程退出/EOF/管道破裂）。"""


def _encode_mcp_frame(
    payload: dict[str, Any], framing: str = CONTENT_LENGTH_FRAMING
) -> bytes:
    """MCP stdio 帧编码。

    - ``content_length``：LSP 风格 ``Content-Length`` 头 + UTF-8 JSON 体
      （MCP 规范标准分帧）；
    - ``json_lines``：JSON Lines——单行 JSON + ``\\n``（内置执行件
      inkling_exec 的 ts_seed_pack 先例形态）。
    """
    body = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    if framing == JSON_LINES_FRAMING:
        return body + b"\n"
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
    return header + body


def _parse_content_length(header: bytes) -> int:
    """解析帧头行的 ``Content-Length`` 值（非法形态回落 0，读循环跳过）。"""
    text = header.decode("ascii", errors="replace").strip()
    if not text.lower().startswith("content-length:"):
        return 0
    try:
        return int(text.split(":", 1)[1].strip())
    except ValueError:
        return 0


class _ThreadedMcpTransport:
    """自写 MCP stdio 客户端：线程私有事件循环 + JSON-RPC 分帧。

    动机（嵌入环境的 task 亲和根修）：headless 壳每次 ``tokio::run``
    新建并关闭 asyncio loop，mcp SDK 的 ``stdio_client``（anyio task
    group + cancel scope）与 asyncio 子进程句柄都绑定某一次 loop——
    跨 loop 即崩。本类把整个 stdio 会话放进独立工作线程的私有
    asyncio loop（生命周期 = 线程 = 连接 = 引擎），引擎侧任意 loop
    经 ``call_soon_threadsafe`` 提交、经 ``concurrent.futures.Future``
    回收，关闭是确定性的（terminate + cancel + loop 关闭 + 线程
    join），无 task 亲和约束。

    协议面（MCP stdio = LSP 分帧 + JSON-RPC 2.0）：请求/响应按 id
    配对（请求表）；server→client 请求应答 ping/roots/list（未知方法
    回 -32601）；通知（progress 等）忽略。initialize 握手在线程启动
    时完成，之后 tools/list、tools/call 即用。进程 stderr（结构化
    日志通道）在线程内捕获，经启动时捕获的 contextvars 逐行转发进
    引擎日志通道（trace_id 链路语义一致）。
    """

    def __init__(self, config: McpServerConfig) -> None:
        self._config = config
        self._log = get_logger(f"{__name__}.exec")
        self._context = contextvars.copy_context()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._started = threading.Event()
        self._startup_error: BaseException | None = None
        self._closed = False
        self._next_id = itertools.count(1)
        self._pending: dict[int, concurrent.futures.Future] = {}
        self._proc: asyncio.subprocess.Process | None = None
        self._write_queue: asyncio.Queue[bytes | None] | None = None
        self._stop: asyncio.Event | None = None
        # 写侧帧协议：按配置（标准 MCP = Content-Length；内置执行件 =
        # JSON Lines）；读侧自适应（首行以 Content-Length 或 { 区分），
        # server 以 JSON Lines 响应时写侧同步切换（容错未显式配置）。
        self._write_framing = config.stdio_framing or CONTENT_LENGTH_FRAMING

    # ── 生命周期 ──────────────────────────────────────────────────────

    def start(self) -> None:
        """启动工作线程并等待就绪（initialize 握手完成）。

        同步阻塞至就绪/失败（上界 _CONNECT_TIMEOUT）；失败统一抛
        ``McpToolImportError``（与 SDK 路径同收敛面）。``_started``
        表示初始化阶段结束（成功或失败），start 据此立即返回，不空等
        超时。
        """
        if self._thread is not None:
            return
        thread = threading.Thread(
            target=self._run_thread,
            name=f"mcp-stdio-{self._config.id}",
            daemon=True,
        )
        self._thread = thread
        thread.start()
        if not self._started.wait(timeout=_CONNECT_TIMEOUT + 5):
            self._closed = True
            raise McpToolImportError(
                f"MCP server {self._config.id} stdio 连接超时"
                f"（{_CONNECT_TIMEOUT} 秒）"
            )
        if self._startup_error is not None:
            error = self._startup_error
            self._startup_error = None
            raise McpToolImportError(
                f"MCP server {self._config.id} stdio 连接失败: {error}"
            ) from error

    def _run_thread(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        try:
            loop.run_until_complete(self._serve())
        except BaseException as exc:  # noqa: BLE001 启动/运行期失败统一收敛
            if not self._started.is_set():
                self._startup_error = exc
            else:
                self._fail_pending(exc)
            self._log.warning(
                "MCP server %s stdio 传输线程退出: %s", self._config.id, exc
            )
        finally:
            self._started.set()
            self._loop = None
            try:
                loop.close()
            except Exception:  # noqa: BLE001 清理噪音
                pass

    async def _serve(self) -> None:
        config = self._config
        self._stop = asyncio.Event()
        env = None if config.env is None else dict(os.environ, **config.env)
        proc = await asyncio.create_subprocess_exec(
            config.command,
            *list(config.args),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        self._proc = proc
        self._write_queue = asyncio.Queue()
        tasks = [
            asyncio.create_task(self._writer_loop(proc)),
            asyncio.create_task(self._stderr_loop(proc)),
            asyncio.create_task(self._reader_loop(proc)),
        ]
        stop_task = asyncio.create_task(self._stop.wait())
        try:
            try:
                await self._initialize()
            except BaseException as exc:
                self._startup_error = exc
                raise
            self._started.set()
            await asyncio.wait(
                [*tasks, stop_task],
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            stop_task.cancel()
            await self._teardown_process(proc)
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(BaseException):
                    await task

    async def _initialize(self) -> None:
        result = await self._request(
            "initialize",
            {
                "protocolVersion": _MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": _MCP_CLIENT_NAME,
                    "version": _MCP_CLIENT_VERSION,
                },
            },
            timeout=_CONNECT_TIMEOUT,
        )
        self._server_info = (
            result.get("serverInfo") if isinstance(result, dict) else None
        )
        self._queue_frame(
            _encode_mcp_frame(
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                self._write_framing,
            )
        )

    async def _teardown_process(
        self, proc: asyncio.subprocess.Process
    ) -> None:
        try:
            if proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        proc.kill()
                    await proc.wait()
            else:
                await proc.wait()
        except ProcessLookupError:
            pass

    async def aclose(self) -> None:
        """确定性关闭：通知私有 loop 终止子进程，等待线程退出。"""
        self._closed = True
        loop = self._loop
        if loop is not None:
            done = concurrent.futures.Future()
            loop.call_soon_threadsafe(self._request_close, done)
            try:
                await asyncio.wait_for(
                    asyncio.wrap_future(done), timeout=5.0
                )
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def _request_close(self, done: concurrent.futures.Future) -> None:
        stop = self._stop
        if stop is not None:
            stop.set()
        proc = self._proc
        if proc is not None and proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
        done.set_result(None)

    # ── 协议收发 ──────────────────────────────────────────────────────

    def _submit(
        self, method: str, params: dict[str, Any]
    ) -> tuple[int, concurrent.futures.Future]:
        """跨线程提交请求（任意线程/loop 可调；幂等安全）。

        Returns:
            (req_id, future)：req_id 供超时/取消时精确摘除挂起表项。
        """
        req_id = next(self._next_id)
        future: concurrent.futures.Future = concurrent.futures.Future()
        loop = self._loop
        if loop is None or self._closed:
            future.set_exception(
                _McpConnectionLost(
                    f"MCP server {self._config.id} 连接已关闭"
                )
            )
            return req_id, future
        loop.call_soon_threadsafe(
            self._enqueue_request, req_id, method, params, future
        )
        return req_id, future

    def _enqueue_request(
        self,
        req_id: int,
        method: str,
        params: dict[str, Any],
        future: concurrent.futures.Future,
    ) -> None:
        proc = self._proc
        if proc is None or proc.returncode is not None:
            future.set_exception(
                _McpConnectionLost(
                    f"MCP server {self._config.id} 连接已丢失"
                )
            )
            return
        self._pending[req_id] = future
        self._queue_frame(
            _encode_mcp_frame(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "method": method,
                    "params": params or {},
                },
                self._write_framing,
            )
        )

    async def _request(
        self, method: str, params: dict[str, Any], *, timeout: float
    ) -> Any:
        """提交请求并等待响应（引擎侧任意 loop 可调）。"""
        req_id, future = self._submit(method, params)
        try:
            return await asyncio.wait_for(
                asyncio.wrap_future(future), timeout=timeout
            )
        except (asyncio.TimeoutError, asyncio.CancelledError):
            loop = self._loop
            if loop is not None:
                loop.call_soon_threadsafe(self._drop_pending, req_id)
            raise

    def _drop_pending(self, req_id: int) -> None:
        future = self._pending.pop(req_id, None)
        if future is not None and not future.done():
            future.set_exception(
                asyncio.TimeoutError(
                    f"MCP server {self._config.id} 请求超时"
                )
            )

    def _queue_frame(self, frame: bytes) -> None:
        queue = self._write_queue
        if queue is not None:
            queue.put_nowait(frame)

    async def _writer_loop(
        self, proc: asyncio.subprocess.Process
    ) -> None:
        queue = self._write_queue
        while True:
            frame = await queue.get()
            if frame is None:
                return
            proc.stdin.write(frame)
            await proc.stdin.drain()

    async def _reader_loop(
        self, proc: asyncio.subprocess.Process
    ) -> None:
        stdout = proc.stdout
        try:
            while True:
                line = await stdout.readline()
                if not line:
                    break  # EOF：子进程已退出
                if line.startswith(b"Content-Length:"):
                    # 标准 MCP 分帧：解析 header 后按字节数读 body
                    content_length = _parse_content_length(line)
                    while True:
                        header = await stdout.readline()
                        if header in (b"\r\n", b"\n", b""):
                            break
                        if header.lower().startswith(b"content-length:"):
                            content_length = _parse_content_length(header)
                    if content_length <= 0:
                        continue
                    if content_length > MAX_STDIO_FRAME_BYTES:
                        # 帧大小超可信上界：断开连接（fail-closed）——
                        # 不按声明值分配缓冲，防恶意超大 Content-Length
                        raise _McpConnectionLost(
                            f"MCP server {self._config.id} 帧大小超限"
                            f"（{content_length} > {MAX_STDIO_FRAME_BYTES} 字节），连接已断开"
                        )
                    body = await stdout.readexactly(content_length)
                    msg = json.loads(body.decode("utf-8"))
                else:
                    # JSON Lines：整行即一条消息（内置执行件 ts_seed_pack
                    # 先例形态）；server 以该形态响应时写侧同步切换（容错
                    # 未显式配置的 json_lines server）
                    if not line.strip():
                        continue
                    msg = json.loads(line.decode("utf-8", errors="replace"))
                    if self._write_framing != JSON_LINES_FRAMING:
                        self._write_framing = JSON_LINES_FRAMING
                self._dispatch(msg)
        finally:
            self._fail_pending(
                _McpConnectionLost(
                    f"MCP server {self._config.id} 连接已关闭"
                )
            )

    def _dispatch(self, msg: dict[str, Any]) -> None:
        if "id" in msg:
            if "result" in msg or "error" in msg:
                future = self._pending.pop(msg["id"], None)
                if future is not None and not future.done():
                    if "error" in msg:
                        err = msg["error"]
                        future.set_exception(
                            _RpcError(
                                err.get("code", -32603),
                                err.get("message", ""),
                            )
                        )
                    else:
                        future.set_result(msg.get("result"))
                return
            self._handle_server_request(msg)
            return
        # 无 id = 通知（progress 等）：记录不处理

    def _handle_server_request(self, msg: dict[str, Any]) -> None:
        method = msg.get("method")
        req_id = msg.get("id")
        if method == "ping":
            result: Any = {}
        elif method == "roots/list":
            result = {"roots": []}
        else:
            self._queue_frame(
                _encode_mcp_frame(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": -32601,
                            "message": f"method not found: {method}",
                        },
                    },
                    self._write_framing,
                )
            )
            return
        self._queue_frame(
            _encode_mcp_frame(
                {"jsonrpc": "2.0", "id": req_id, "result": result},
                self._write_framing,
            )
        )

    def _fail_pending(self, exc: BaseException) -> None:
        pending, self._pending = self._pending, {}
        for future in pending.values():
            if not future.done():
                future.set_exception(exc)

    async def _stderr_loop(
        self, proc: asyncio.subprocess.Process
    ) -> None:
        log = self._log
        context = self._context
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace").strip()
            if not text:
                continue
            context.run(_forward_exec_line, log, text)

    # ── 能力面（协议方法）──────────────────────────────────────────────

    async def list_tools(self) -> list[dict[str, Any]]:
        result = await self._request("tools/list", {}, timeout=_CALL_TIMEOUT)
        if not isinstance(result, dict):
            return []
        return list(result.get("tools") or [])

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = await self._request(
            "tools/call",
            {"name": name, "arguments": arguments or {}},
            timeout=_CALL_TIMEOUT,
        )
        if not isinstance(result, dict):
            return {
                "content": [{"type": "text", "text": str(result)}],
                "isError": False,
            }
        return result

    async def ping(self) -> None:
        await self._request("ping", {}, timeout=_CALL_TIMEOUT)


class _SdkSession(McpSessionHandle):
    """MCP 会话句柄（双后端：SDK 会话或自写 stdio 传输）。

    - http / in_memory：官方 mcp SDK 的 ``ClientSession``（惰性 import，
      未安装即报错），文本提取兼容 TextContent 与未知内容类型；
    - stdio：自写 ``_ThreadedMcpTransport``（线程私有事件循环，无 task
      亲和约束）。这是嵌入环境的 task 亲和根修——SDK 的 ``stdio_client``
      是 async generator，内部 anyio cancel scope 要求 enter/exit 在
      **同一 asyncio task**；headless 壳每次 ``tokio::run`` 独立 task 且
      独立 event loop（新建+销毁），任何绑在某一次 loop 上的资源跨
      boot/round/stop 即崩。自写传输把 stdio 会话放进独立工作线程的
      私有 loop（生命周期 = 引擎），引擎侧任意 loop 提交/回收，与调用
      侧 loop 完全解耦。
    """

    def __init__(
        self,
        session: Any = None,
        exit_stack: AsyncExitStack | None = None,
        transport_task: asyncio.Task | None = None,
        closing: asyncio.Event | None = None,
        transport: _ThreadedMcpTransport | None = None,
    ) -> None:
        self._session = session
        self._exit_stack = exit_stack
        self._transport_task = transport_task
        self._closing = closing
        self._transport = transport

    @classmethod
    async def open(cls, config: McpServerConfig) -> _SdkSession:
        """按配置打开真实会话（stdio 走自写传输，其余惰性 import mcp）。

        stdio 传输走线程私有事件循环（``_ThreadedMcpTransport``，无
        task 亲和约束）；http/in_memory 传输维持 SDK 会话直管。

        Raises:
            McpToolImportError: 配置与传输形态不匹配（如 http 缺 url）、
                SDK 缺失、连接/初始化异常——全部统一包装为导入错误，
                宿主只处理一个失败类型；SDK 内部取消（连接拒绝等失败
                路径的表达方式）同样收敛；外层任务真被取消时原样传播。
        """
        if config.transport is McpTransport.STDIO:
            if not config.command:
                raise McpToolImportError(
                    f"MCP server {config.id} 的 stdio 传输缺 command"
                )
            transport = _ThreadedMcpTransport(config)
            try:
                transport.start()
            except McpToolImportError:
                raise
            except BaseException as exc:
                raise McpToolImportError(
                    f"MCP server {config.id} stdio 连接失败: {exc}"
                ) from exc
            return cls(transport=transport)
        exit_stack: AsyncExitStack = AsyncExitStack()
        try:
            _require_mcp()
            if config.transport is McpTransport.HTTP:
                if not config.url:
                    raise McpToolImportError(
                        f"MCP server {config.id} 的 http 传输缺 url"
                    )
                # mcp 2.x 契约（pyproject 下限 >=2.0）：客户端名
                # streamable_http_client，headers 经 httpx http_client 注入。
                # 惰性 import：未安装 SDK 时经 _require_mcp 显式报错（不
                # 污染模块导入期）。
                import httpx
                from mcp.client.streamable_http import streamable_http_client

                http_client = (
                    httpx.AsyncClient(headers=dict(config.headers))
                    if config.headers
                    else None
                )
                if http_client is not None:
                    exit_stack.push_async_callback(http_client.aclose)
                read, write = await exit_stack.enter_async_context(
                    streamable_http_client(config.url, http_client=http_client)
                )
            elif config.transport is McpTransport.IN_MEMORY:
                if config.server_factory is None:
                    raise McpToolImportError(
                        f"MCP server {config.id} 的内存传输缺 server_factory"
                    )
                read, write = await exit_stack.enter_async_context(
                    config.server_factory()
                )
            else:
                raise McpToolImportError(
                    f"MCP server {config.id} 的传输形态未支持: {config.transport}"
                )
            from mcp import ClientSession

            session = await exit_stack.enter_async_context(ClientSession(read, write))
            await asyncio.wait_for(session.initialize(), timeout=_CONNECT_TIMEOUT)
            return cls(session, exit_stack)
        except McpToolImportError:
            await _suppress_stack_close(exit_stack)
            raise
        except BaseException as exc:
            await _suppress_stack_close(exit_stack)
            if isinstance(exc, asyncio.CancelledError):
                if _outer_cancellation_requested():
                    # 外层任务真被取消：清理后原样传播（取消是宿主发起的
                    # 终止，不包装成导入错误）
                    raise
            elif isinstance(exc, (KeyboardInterrupt, SystemExit)):
                # 宿主中断信号：原样传播（不包装，与终止信号同语义）
                raise
            # 连接/初始化失败（含 SDK 内部取消表达）：统一收敛为导入错误，
            # 宿主只处理一个失败类型
            raise McpToolImportError(
                f"MCP server {config.id} 连接失败: {exc}"
            ) from exc

    async def list_tools(self) -> list[Any]:
        if self._transport is not None:
            return await self._transport.list_tools()
        try:
            result = await asyncio.wait_for(
                self._session.list_tools(), timeout=_CALL_TIMEOUT
            )
        except TimeoutError as exc:
            raise McpToolImportError(
                f"MCP 工具列举超时（{_CALL_TIMEOUT} 秒）"
            ) from exc
        return list(result.tools)

    async def call_tool(self, name: str, args: dict[str, Any]) -> str:
        try:
            if self._transport is not None:
                result = await self._transport.call_tool(name, args)
            else:
                result = await asyncio.wait_for(
                    self._session.call_tool(name, arguments=args or {}),
                    timeout=_CALL_TIMEOUT,
                )
        except TimeoutError as exc:
            raise GraphDefinitionError(
                f"MCP 工具调用超时: {name}（{_CALL_TIMEOUT} 秒）"
            ) from exc
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if _is_mcp_business_reject(exc):
                # server 业务拒绝（参数缺失/非法等 JSON-RPC error，如 SDK
                # 的 MCPError / 自写传输的 _RpcError）：转明确业务错误——
                # 不当作进程崩溃传播
                raise GraphDefinitionError(
                    f"MCP 工具执行失败: {name}: {exc}"
                ) from exc
            raise  # 连接层异常（Connection closed 等）透传，交监督句柄处理
        if _result_is_error(result):
            raise GraphDefinitionError(
                f"MCP 工具执行失败: {name}: {_extract_text(result)}"
            )
        return _extract_text(result)

    async def ping(self) -> None:
        """协议级存活探测（health_check 的判定依据）。

        自写传输直接发 ping；SDK 版本无 send_ping 能力时按存活判定
        （不抛错）。
        """
        if self._transport is not None:
            await self._transport.ping()
            return
        ping = getattr(self._session, "send_ping", None)
        if ping is not None:
            await asyncio.wait_for(ping(), timeout=_CALL_TIMEOUT)

    async def aclose(self) -> None:
        """释放会话与底层传输（连接生命周期归 manager 调用）。

        stdio 自写传输：确定性关闭（terminate + cancel + loop 关闭 +
        线程 join），无 task 亲和约束，任何 loop 可调。SDK 路径维持
        守护 task / AsyncExitStack 直管。
        """
        if self._transport is not None:
            await self._transport.aclose()
            return
        if self._transport_task is not None:
            if self._closing is not None:
                self._closing.set()
            try:
                await asyncio.wait_for(self._transport_task, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._transport_task.cancel()
                try:
                    await asyncio.wait_for(self._transport_task, timeout=5)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass  # 守护 task 退出异常归日志，不向上抛（清理噪音）
            return
        try:
            await self._exit_stack.aclose()
        except Exception as exc:  # noqa: BLE001 关闭失败是清理噪音，不影响调用面
            logger.warning("MCP 会话关闭异常（已吞掉，防 asyncio 后台报错）: %s", exc)


class _SupervisedStdioSession(McpSessionHandle):
    """stdio 进程会话的受监督句柄：崩溃探测 + 按重启策略拉起。

    在既有 spawn/退出清理/stderr 桥（``_SdkSession.open``，stdio 走自写
    传输）之上只补监督，不重写底层：本句柄持有当前 ``_SdkSession``，
    调用失败视为进程崩溃（stdio 传输 = 进程生命周期绑定，协议失败即
    进程死了），走「拉起 → 回到服务」路径——拉起成功后**不透传重试原
    操作**：失败的工具调用可能已在崩溃前被部分执行，重试有非幂等
    副作用风险（fail-safe：诚实失败，下个调用命中新会话）。

    失败路径（重试耗尽 → 熔断打开 → 错误上报）：
    - 拉起尝试有界（``max_retries``，间隔 ``backoff`` 秒）；
    - 一次「重试耗尽」事件计 1 分，连续到达
      ``circuit_break_threshold`` 分 = 熔断打开（fail-closed 直接
      拒绝调用直到重连/换会话——进程反复秒崩是环境性问题，不再
      持续拉起）；
    - 拉起成功清零连续失败分（熔断随之解除，只凭健康度判定）。
    Send 失败/取消例外：CancelledError 原样穿透（与外层取消语义
    一致，不误判为进程崩溃）。
    """

    def __init__(
        self,
        config: McpServerConfig,
        *,
        initial: _SdkSession | None = None,
        opener: Callable[[McpServerConfig], Any] | None = None,
    ) -> None:
        self._config = config
        self._policy = config.restart_policy or StdioRestartPolicy()
        self._opener = opener
        self._session: _SdkSession | None = initial
        self._circuit_open = False
        self._consecutive_failures = 0
        self._lock = asyncio.Lock()

    @property
    def circuit_open(self) -> bool:
        """熔断状态（熔断打开 = 不再拉起 + 调用 fail-closed）。"""
        return self._circuit_open

    @property
    def consecutive_failures(self) -> int:
        """连续失败计数（「重试耗尽」次数；拉起成功即清零）。"""
        return self._consecutive_failures

    async def _open_fresh(self) -> _SdkSession:
        opener = self._opener
        if opener is None:
            return await _SdkSession.open(self._config)
        return await opener(self._config)

    async def _ensure_open(self) -> _SdkSession:
        if self._circuit_open:
            raise McpToolImportError(
                f"MCP server {self._config.id} 的 stdio 进程熔断已打开"
                "（连续拉起失败），回调被拒——请重连/检查进程环境"
            )
        if self._session is None:
            self._session = await self._open_fresh()
            # 建立成功 = 进程可用：连续失败分清零（熔断只凭健康度判定）
            self._consecutive_failures = 0
        return self._session

    async def _teardown(self) -> None:
        """关闭当前会话句柄（失败只记日志：清理不掩盖崩溃路径）。"""
        session, self._session = self._session, None
        if session is not None:
            try:
                await session.aclose()
            except Exception as exc:
                logger.warning(
                    "MCP server %s 会话清理失败: %s", self._config.id, exc
                )

    async def _respawn(self, cause: Exception) -> _SdkSession:
        """崩溃拉起：按策略尝试有限次，重试耗尽上报并计数/熔断。

        Returns:
            新会话（拉起成功）。

        Raises:
            McpToolImportError: 重试耗尽（附带原始崩溃原因与熔断状态）。
        """
        attempts = self._policy.max_retries
        last_error = cause
        # 崩溃会话先清除（无论是否重启：僵死句柄不得继续承接调用——
        # 不重启时后续调用经 _ensure_open 重新建立）
        await self._teardown()
        for n in range(attempts):
            await asyncio.sleep(self._policy.backoff)
            try:
                session = await self._open_fresh()
            except Exception as exc:
                last_error = exc
                logger.warning(
                    "MCP server %s stdio 拉起第 %d/%d 次失败: %s",
                    self._config.id, n + 1, attempts, exc,
                )
                continue
            self._session = session
            self._consecutive_failures = 0
            logger.info(
                "MCP server %s stdio 进程已拉起（第 %d 次尝试成功）",
                self._config.id, n + 1,
            )
            return session
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._policy.circuit_break_threshold:
            self._circuit_open = True
            logger.error(
                "MCP server %s stdio 连续 %d 次拉起失败，熔断打开（fail-closed）",
                self._config.id, self._consecutive_failures,
            )
        raise self._failure_report(last_error, attempts)

    def _failure_report(self, cause: Exception, attempts: int) -> McpToolImportError:
        return McpToolImportError(
            f"MCP server {self._config.id} 的 stdio 进程崩溃且重启失败"
            f"（{attempts} 次尝试，熔断={self._circuit_open}）: {cause}"
        )

    async def _invoke(self, op: Callable[[_SdkSession], Any], op_name: str) -> Any:
        """会话调用 + 崩溃拉起（连接类失败拉起后重试一次；业务错误不重试）。

        按进程粒度串行（会话即进程：监督路径需要单一所有者，并发
        崩溃会双重拉起且失败互踩）。会话建立失败（进程秒崩）与
        调用期失败同走拉起路径——两者都是「进程不可用」。

        重试语义（E-P15）：连接类失败（Connection closed——请求未达
        server 或连接层断流）拉起成功后重试一次原操作：stdio 传输仅
        承载 inkling_exec（研究链确定性纯函数工具），重试无副作用
        风险；首连会话在嵌入 asyncio 环境不稳定（事件循环亲和抖动），
        重试可覆盖该抖动。业务错误（如「缺参数」——server 已受理并
        返回）不重试，诚实失败。会话建立失败（进程启动即崩）同样走
        拉起路径（按策略计数/熔断），不静默透传。
        """
        respawned = False
        async with self._lock:
            try:
                session = await self._ensure_open()
                try:
                    return await op(session)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if _is_business_error(exc):
                        # 业务失败（server 已受理并返回 is_error，如参数
                        # 缺失）直接透传，不误判为进程崩溃、不触发拉起
                        raise
                    respawned = True
                    connection_lost = _is_connection_lost(exc)
                    await self._respawn(exc)
                    if connection_lost:
                        try:
                            return await op(self._session)
                        except asyncio.CancelledError:
                            raise
                        except Exception as exc2:
                            raise McpToolImportError(
                                f"MCP server {self._config.id} 的 stdio 进程在 {op_name} "
                                f"期间崩溃（已按策略拉起并重试一次仍失败）: {exc2}"
                            ) from exc2
                    raise McpToolImportError(
                        f"MCP server {self._config.id} 的 stdio 进程在 {op_name} 期间崩溃"
                        f"（已按策略拉起，本次调用未重试——防非幂等副作用）: {exc}"
                    ) from exc
            except McpToolImportError as exc:
                if respawned or self._circuit_open:
                    raise  # 已走拉起路径（耗尽/熔断）或拉起后诚实失败：透传
                # 会话建立失败（进程启动即崩/不可用）：按策略拉起 + 计数
                await self._respawn(exc)
                raise McpToolImportError(
                    f"MCP server {self._config.id} 的 stdio 会话在 {op_name} 期间失效"
                    f"（已按策略拉起，本次调用未重试）: {exc}"
                ) from exc
            except asyncio.CancelledError:
                raise  # 外层取消原样穿透（不误判为进程崩溃）
            except Exception as exc:
                if _is_business_error(exc):
                    raise  # 业务失败（内层判定后透传）不被兜底误判
                # 会话建立失败（首次拉起/进程秒崩）→ 走重试耗尽路径
                await self._respawn(exc)
                raise McpToolImportError(
                    f"MCP server {self._config.id} 的 stdio 会话在 {op_name} 期间失效"
                    f"（已按策略拉起，本次调用未重试）: {exc}"
                ) from exc

    async def list_tools(self) -> list[Any]:
        return await self._invoke(
            lambda session: session.list_tools(), "list_tools"
        )

    async def call_tool(self, name: str, args: dict[str, Any]) -> str:
        return await self._invoke(
            lambda session: session.call_tool(name, args), "call_tool"
        )

    async def health_check(self) -> bool:
        """存活探测：协议级 ping（SDK 无 ping 能力时按可用会话判定）。

        探测失败 = 进程崩溃 → 尝试拉起（拉起成功返回 True）；熔断
        打开或拉起耗尽返回 False。宿主可按节奏调用（备用健康探查/
        环境巡检），默认不自动轮询（无额外后台任务，生命周期简单）。
        """
        if self._circuit_open:
            return False
        async with self._lock:
            try:
                session = await self._ensure_open()
                await self._probe(session)
                return True
            except asyncio.CancelledError:
                raise
            except McpToolImportError:
                return False
            except Exception as exc:
                try:
                    await self._respawn(exc)
                    return True
                except McpToolImportError:
                    return False

    async def _probe(self, session: _SdkSession) -> None:
        ping = getattr(session, "ping", None)
        if ping is not None:
            await ping()
            return
        # 兼容旧形态：_session 上挂 send_ping（历史测试桩/自定义句柄）
        client = getattr(session, "_session", None)
        ping = getattr(client, "send_ping", None)
        if ping is not None:
            await asyncio.wait_for(ping(), timeout=_CALL_TIMEOUT)
    async def aclose(self) -> None:
        """释放句柄（切断监督：后续访问按 ensure_open 重新拉起）。"""
        async with self._lock:
            self._circuit_open = False
            self._consecutive_failures = 0
            await self._teardown()


def _result_is_error(result: Any) -> bool:
    """MCP 调用结果的失败标记（dict 与 SDK 对象两形态；2.x 字段
    is_error，isError 仅为 1.x 遗留数据/自定义桩的防御性回退）。"""
    if isinstance(result, dict):
        marker = result.get("is_error")
        if marker is None:
            marker = result.get("isError")
        return bool(marker)
    marker = getattr(result, "is_error", None)
    if marker is None:
        marker = getattr(result, "isError", None)
    return bool(marker)


def _extract_text(result: Any) -> str:
    """从 MCP 调用结果提取文本（兼容 dict 与 SDK 对象两形态）。

    结果体 ``content`` 为内容项列表；内容项兼容 SDK 对象与 dict 两种
    形态（dict 形态常见于经 JSON 往返的代理/测试桩/自写传输）；文本项
    按 text 拼接并统一强转字符串，非文本项标注类型（``[<type>]``）后
    落明——不静默丢弃任何回执信息，也不把二进制/资源内容伪装成纯文本。
    """
    if isinstance(result, dict):
        content = result.get("content")
    else:
        content = getattr(result, "content", None)
    if not content:
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict):
            text = item.get("text")
            item_type = item.get("type", "unknown")
        else:
            text = getattr(item, "text", None)
            item_type = getattr(item, "type", "unknown")
        if text is not None:
            parts.append(str(text))
            continue
        parts.append(f"[{item_type}]")
    body = "\n".join(parts)
    if len(body) > _MAX_RESULT_CHARS:
        body = body[:_MAX_RESULT_CHARS] + "\n…（溢出截断）"
    return body


class McpClientManager:
    """MCP 连接管理器：会话生命周期 + 工具导入 + 分发执行器注册。

    会话按 server_id 路由：``connect`` 打开并登记；``dispatch``（声明式
    工具执行体）按定义中的 server_id 反查会话后转发调用；会话缺失 =
    fail-closed 拒绝（未挂载的 server 不可被调用）。导入工具经 vetting
    闸门过滤，被拒工具不进入工具表。
    """

    def __init__(self) -> None:
        self._sessions: dict[str, McpSessionHandle] = {}
        self._signatures: dict[str, str | None] = {}
        self._imported: dict[str, set[str]] = {}
        # 观察证据累积（E-P4）：工具名 → 影子运行观察结果（untrusted
        # 行为证据，信任进阶的输入；key = "<server_id>:<tool_name>"）
        self._shadow_evidence: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    def shadow_evidence(self, server_id: str | None = None) -> dict[str, dict[str, Any]]:
        """观察证据查询（影子运行结果：untrusted 行为证据，不作信任依据）。

        server_id 缺省 = 全量；指定 = 该 server 的工具观察结果（审计/
        信任进阶消费）。
        """
        if server_id is None:
            return dict(self._shadow_evidence)
        prefix = f"{server_id}:"
        return {
            key: value
            for key, value in self._shadow_evidence.items()
            if key.startswith(prefix)
        }

    def list_servers(self) -> list[str]:
        """已连接 server 标识清单（会话路由密钥，只读查询免内部状态外露）。"""
        return list(self._sessions)

    def imported_tools(self, server_id: str) -> frozenset[str]:
        """某 server 最近一次导入的工具名集合（卸载清理与重挂载差量的依据）。"""
        return frozenset(self._imported.get(server_id, ()))

    def register_session(self, server_id: str, handle: McpSessionHandle) -> None:
        """登记已就绪会话（测试桩 / 宿主预建会话均可注入）。

        已有活动会话时显式拒绝：会话生命周期归管理器独占，防止「覆盖
        不关闭旧句柄」的资源泄漏。需要换会话请先断开再登记。
        """
        if server_id in self._sessions:
            raise McpToolImportError(
                f"MCP server 已有活动会话: {server_id}（须先断开再登记）"
            )
        self._sessions[server_id] = handle

    async def connect(self, config: McpServerConfig) -> McpSessionHandle:
        """按配置打开会话并登记（重复连接关闭旧会话后重建，成功即覆盖）。

        打开失败时清理登记保证 fail-closed：残留已关闭句柄会误导
        分发器进入 SDK 异常路径而非干净的「未连接」拒绝。并发连接
        串行化（会话表是共享状态）。
        """
        async with self._lock:
            old = self._sessions.get(config.id)
            if old is not None:
                await old.aclose()
                self._sessions.pop(config.id, None)
            try:
                handle = await _SdkSession.open(config)
                if config.transport is McpTransport.STDIO:
                    # stdio 传输 = 进程生命周期绑定：包一层进程监督
                    # （崩溃探测 + 按重启策略拉起；http/内存不受影响）
                    handle = _SupervisedStdioSession(config, initial=handle)
            except Exception:
                self._sessions.pop(config.id, None)
                raise
            self._sessions[config.id] = handle
        self._signatures[config.id] = config.signature
        logger.info(
            "MCP server 已连接: %s（传输: %s）", config.id, config.transport.value
        )
        return handle

    async def connect_builtin(
        self, server_id: str, **overrides: Any
    ) -> McpSessionHandle:
        """按内置注册表连接（tools.json 声明 server 的真实连接入口）。

        宿主只传环境相关连接位（stdio 命令路径/in_memory 工厂等），
        传输形态/来源/签名以注册表为准；未定义的 server_id fail-closed
        拒绝（与分发路径同语义——声明层无定义即不可连接）。
        """
        config = builtin_mcp_server_config(server_id, **overrides)
        if config is None:
            raise McpToolImportError(
                f"内置 MCP server 未定义: {server_id}（注册表仅含 "
                f"{sorted(BUILTIN_MCP_SERVERS)}）"
            )
        return await self.connect(config)

    async def disconnect(self, server_id: str) -> bool:
        """关闭并注销会话（缺省返回 False，不抛错）。"""
        async with self._lock:
            handle = self._sessions.pop(server_id, None)
            self._signatures.pop(server_id, None)
        if handle is None:
            return False
        await handle.aclose()
        logger.info("MCP server 已断开: %s", server_id)
        return True

    async def close_all(self) -> None:
        """关闭全部会话（宿主优雅退出前调用，幂等；单会话关闭失败不阻断其余）。"""
        async with self._lock:
            handles = list(self._sessions.values())
            self._sessions.clear()
            self._signatures.clear()
        for handle in handles:
            try:
                await handle.aclose()
            except Exception as exc:
                logger.warning("MCP 会话关闭失败: %s", exc)

    async def import_tools(
        self,
        server_id: str,
        *,
        source: ToolSource = ToolSource.UNKNOWN,
        vetting: ToolVetting | None = None,
        signature: str | None = None,
        shadow_workdir: str | Path | None = None,
    ) -> list[DeclarativeToolSpec]:
        """列出并转换 server 工具为声明式定义（必经 vetting 闸门过滤）。

        vetting 为 None = 跳过审查（挂载审批已在提案流程完成）；提供时
        逐工具生成清单并 vet，仅 VERIFIED 判定通过——REVIEW（静态审查
        命中，语义 = 需人工确认，不自动放行）与 REJECTED 同样不进入
        工具表（fail-closed：信任靠审查证据，不静默放行）。签名取显式
        传入值，缺省回落到 ``connect`` 时登记的连接签名。

        观察模式（E-P4，ENG6-3 接线）：提供 vetting 且工具 VERIFIED 后，
        挂载流程并入 :meth:`ToolVetting.shadow_run`——影子执行探针（写
        虚拟化：工作目录副本 + 快照 diff；结果恒标记 untrusted）+ 观察
        证据累积（:meth:`shadow_evidence` 可查，信任进阶按证据累积，不
        靠承诺）。探针参数只取带默认值的可选字段（绝不臆造必填参数）；
        探针失败只记证据不阻断导入（观察是行为证据，不作信任依据，也
        不作挂载门禁）。``shadow_workdir`` 提供 = 以真实工作目录为影子
        模板（覆盖本地写语义的工具，如 exec 类 server）；缺省 = 空探针
        模板（远端调用无本地写面，仅记录调用成败证据）。

        Raises:
            McpToolImportError: 会话不存在（未连接/未挂载）。
        """
        handle = self._sessions.get(server_id)
        if handle is None:
            raise McpToolImportError(f"MCP server 未连接: {server_id}")
        if signature is None:
            signature = self._signatures.get(server_id)
        raw_tools = await handle.list_tools()
        specs: list[DeclarativeToolSpec] = []
        shadow_template: Path | None = None
        try:
            if vetting is not None and shadow_workdir is None:
                # 无本地工作目录语义：空探针模板（拷贝开销可忽略，探针只
                # 记录远端调用成败行为证据）
                shadow_template = Path(tempfile.mkdtemp(prefix="forge-shadow-probe-"))
            probe_workdir = (
                Path(shadow_workdir)
                if shadow_workdir is not None
                else shadow_template
            )
            for raw in raw_tools:
                try:
                    spec = convert_mcp_tool(server_id, raw)
                except GraphDefinitionError as exc:
                    logger.warning("MCP 工具转换跳过: %s: %s", server_id, exc)
                    continue
                if vetting is not None:
                    verdict = await vetting.vet(
                        build_mcp_manifest(
                            server_id, raw, source=source, signature=signature
                        )
                    )
                    if verdict.verdict is not VettingVerdict.VERIFIED:
                        logger.warning(
                            "MCP 工具经 vetting 未放行，不导入: %s/%s（%s: %s）",
                            server_id,
                            spec.name,
                            verdict.verdict.value,
                            verdict.reason,
                        )
                        continue
                    await self._observe_shadow(
                        vetting,
                        handle,
                        spec,
                        workdir=probe_workdir,
                    )
                specs.append(spec)
        finally:
            if shadow_template is not None:
                shutil.rmtree(shadow_template, ignore_errors=True)
        self._imported[server_id] = {spec.name for spec in specs}
        logger.info("MCP server 工具导入: %s（%d 个）", server_id, len(specs))
        return specs

    async def _observe_shadow(
        self,
        vetting: ToolVetting,
        handle: McpSessionHandle,
        spec: DeclarativeToolSpec,
        *,
        workdir: Path | None,
    ) -> None:
        """观察模式探针：影子执行（写虚拟化 + untrusted）→ 证据累积。

        探针 = 以空参/仅默认值参数经影子工作区执行一次工具调用——远端
        调用无法本地写虚拟化（副作用归 server 自身语义），观察结果恒标
        记 untrusted，仅作行为证据累积（信任进阶输入），不作信任依据。
        探针失败（如必填参数缺失）同样落证据（ok=False），不阻断导入。
        """
        server_id = spec.endpoint_config.get("server_id")
        probe_args = _probe_args_from_schema(spec.parameters)

        async def probe_executor(_args: dict[str, Any], _shadow_dir: Path) -> str:
            return await handle.call_tool(spec.name, probe_args)

        evidence: dict[str, Any]
        try:
            observation: ShadowRunResult
            if workdir is None:
                observation = ShadowRunResult(
                    ok=False, error="影子工作区未提供（探针跳过）"
                )
            else:
                observation = await vetting.shadow_run(
                    probe_executor, probe_args, workdir=workdir
                )
            evidence = {
                "ok": observation.ok,
                "writes": [
                    {"path": w.path, "operation": w.operation, "size": w.size}
                    for w in observation.writes
                ],
                "error": observation.error,
                "untrusted": observation.untrusted,
                "output_preview": observation.output[:500],
            }
        except Exception as exc:
            evidence = {"ok": False, "error": str(exc), "untrusted": True}
        self._shadow_evidence[f"{server_id}:{spec.name}"] = evidence
        logger.info(
            "MCP 工具观察探针完成（untrusted 行为证据）: %s/%s ok=%s",
            server_id,
            spec.name,
            evidence["ok"],
        )

    async def dispatch(
        self, ctx: Any, definition: DeclarativeToolSpec, args: dict, approval: Any = None
    ) -> str:
        """声明式工具执行体（端点 = MCP）：按 server_id 路由会话转发调用。

        Raises:
            GraphDefinitionError: server_id 缺失或会话未连接（fail-closed）。
        """
        server_id = definition.endpoint_config.get("server_id")
        if not isinstance(server_id, str) or not server_id:
            raise GraphDefinitionError(
                f"工具 {definition.name} 的 MCP 端点缺 server_id"
            )
        handle = self._sessions.get(server_id)
        if handle is None:
            raise GraphDefinitionError(
                f"MCP server 未连接，调用被拒: {server_id}（工具 {definition.name}）"
            )
        return await handle.call_tool(definition.name, args or {})


def register_mcp_executor(
    executors: DeclarativeToolExecutors, manager: McpClientManager
) -> None:
    """把 MCP 分发执行器注册进声明式执行体注册表（宿主装配时调用一次）。

    注册后所有 endpoint=MCP 的声明式工具经统一流水线分发——即插即用，
    声明式工具与执行体解耦（新增端点类型不改工具定义与执行路径）。
    """
    executors.register(EndpointType.MCP, manager.dispatch)


__all__ = [
    "BUILTIN_MCP_SERVERS",
    "McpClientManager",
    "McpServerConfig",
    "McpSessionHandle",
    "McpToolImportError",
    "McpTransport",
    "StdioRestartPolicy",
    "build_mcp_manifest",
    "builtin_mcp_server_config",
    "convert_mcp_tool",
    "register_mcp_executor",
]
