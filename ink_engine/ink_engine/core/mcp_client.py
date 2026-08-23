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
- http：``streamablehttp_client(url)``（MCP v2 规范主传输）；
- stdio：``StdioServerParameters(command, args, env)`` 拉起本地进程；执行件
  的 stderr（结构化日志通道）捕获进引擎日志，不裸露到终端；
- in_memory：宿主注入 ``server_factory``（返回 (read, write) 流对的异步
  上下文管理器），用于内嵌 server 或测试桩，不依赖真实网络/进程。
"""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import inspect
import json
import logging
import os
import threading
from collections.abc import Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, TextIO

from .declarative_tools import (
    DeclarativeToolExecutors,
    DeclarativeToolSpec,
    EndpointType,
)
from .exceptions import GraphDefinitionError
from .logging import get_logger
from .tool_vetting import ToolManifest, ToolSource, ToolVetting, VettingVerdict

logger = get_logger(__name__)

# 连接/调用超时（秒）：MCP 握手与工具调用均须有上界，避免无限挂起拖垮回合
_CONNECT_TIMEOUT = 30.0
_CALL_TIMEOUT = 60.0

# stdio 进程监督的保守缺省值（重启策略是数据字段，缺省取此处）：
# 重启尝试 2 次、间隔 1s、连续 3 次「重试耗尽」即熔断（进程反复
# 秒崩是环境性故障，持续拉起只会拖垮回合——fail-closed 上报）。
_DEFAULT_STDIO_RESTART_RETRIES = 2
_DEFAULT_STDIO_RESTART_BACKOFF = 1.0
_DEFAULT_STDIO_CIRCUIT_BREAK_THRESHOLD = 3

# 工具调用结果文本截断上限（与引擎工具流水线默认一致，防大对象挤爆上下文）
_MAX_RESULT_CHARS = 100_000

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


# mcp SDK 1.x 与 2.x 的 http 客户端导入名与签名差异（2.x 改名
# streamable_http_client 且 headers 改经 http_client 注入）。仅解析可调用名，
# 实际形态以运行时签名检测（http_client 参数存在与否），不依赖函数名下划线
try:
    from mcp.client.streamable_http import streamablehttp_client
except ImportError:
    from mcp.client.streamable_http import (
        streamable_http_client as streamablehttp_client,  # type: ignore[no-redef]
    )

# 双版本兼容：以运行时签名检测 API 形态（不依赖函数名下划线）—— 含 http_client
# 参数即 2.x（headers 经 httpx 客户端注入），否则 1.x（streamablehttp_client(url, headers=...)）
_HTTP_CLIENT_2X = "http_client" in inspect.signature(streamablehttp_client).parameters


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

    字段映射：name/description/inputSchema → 同名；端点固定 MCP，
    路由密钥 ``server_id`` 写入 endpoint_config（定义期必填校验）；权限
    统一为 ``mcp:call:<server_id>``（按 server 粒度管控，宿主放行即整
    server 可信）。约定优于配置：MCP 工具无需逐个手工声明权限。

    Args:
        server_id: 来源 server 标识。
        tool: MCP SDK 的 Tool 对象（鸭子类型读取 name/description/
            inputSchema/input_schema 任一字段形态）或等价 dict。

    Raises:
        GraphDefinitionError: 工具缺 name（MCP 协议违规）。
    """
    if isinstance(tool, dict):
        name = tool.get("name")
        description = tool.get("description") or ""
        schema = tool.get("inputSchema")
        if schema is None:
            # SDK 2.x 的字段形态是 input_schema（inputSchema 只是声明时的
            # pydantic 别名，实例属性为 snake_case）——两形态等价读取，
            # 避免 SDK 升级后所有参数 schema 归一为空壳
            schema = tool.get("input_schema")
    else:
        name = getattr(tool, "name", None)
        description = getattr(tool, "description", "") or ""
        schema = getattr(tool, "inputSchema", None)
        if schema is None:
            schema = getattr(tool, "input_schema", None)
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
    """清理路径：资源回收失败不掩盖原始失败（原始异常优先，仅记日志）。"""
    try:
        await exit_stack.aclose()
    except BaseException as exc:
        logger.warning("MCP 连接清理失败（不掩盖原始错误）: %s", exc)


class _ExecStderrBridge:
    """stdio 执行件 stderr → 引擎日志通道桥（结构化行逐行转发）。

    执行件把 stderr 当结构化日志通道（JSON 行：事件/请求 id/耗时/成败），
    宿主连接方捕获该流逐行转发进引擎日志——执行件日志不再裸露到终端，
    并随引擎日志通道统一获得 trace_id 注入与敏感形态遮蔽；等级按行内
    ``level`` 字段映射，非结构化行（告警/panic 文本）按 info 落明不丢失。
    """

    def __init__(self, log: logging.Logger) -> None:
        self._log = log
        self._read_fd: int | None = None
        self._writer: TextIO | None = None
        self._thread: threading.Thread | None = None

    async def __aenter__(self) -> TextIO:
        """创建管道与阻塞读线程，返回写端文件对象（交给 stdio_client 当 errlog）。

        读线程复制进入时的上下文（含当前 trace_id），转发行与连接
        时刻的链路语义一致。
        """
        read_fd, write_fd = os.pipe()
        self._read_fd = read_fd
        self._writer = os.fdopen(write_fd, "w", encoding="utf-8", errors="replace")
        context = contextvars.copy_context()
        self._thread = threading.Thread(
            target=lambda: context.run(_drain_exec_stderr, read_fd, self._log),
            name=f"exec-stderr-{id(self)}",
            daemon=True,
        )
        self._thread.start()
        return self._writer

    async def __aexit__(self, *exc: Any) -> None:
        """关闭写端并等待读线程退出。

        子进程已随连接关闭终止 → 管道 EOF → 读线程自然结束；关闭写端
        清理失败不掩盖退出路径。
        """
        writer, self._writer = self._writer, None
        if writer is not None:
            with contextlib.suppress(OSError):
                writer.close()
        thread = self._thread
        if thread is not None:
            self._thread = None
            thread.join(timeout=2.0)


def _drain_exec_stderr(read_fd: int, log: logging.Logger) -> None:
    """阻塞读执行件 stderr 管道直到 EOF，逐行转发进引擎日志通道。

    在 daemon 线程内运行：子进程死 → 管道写端全关 → EOF → 自然退出；
    极端情况下挂住也不阻断解释器退出。
    """
    with os.fdopen(read_fd, "r", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                is_error = json.loads(line).get("level") == "error"
            except ValueError:
                is_error = False
            if is_error:
                log.error("执行件: %s", line)
            else:
                log.info("执行件: %s", line)


class _SdkSession(McpSessionHandle):
    """基于官方 mcp SDK 的会话句柄（惰性 import，未安装即报错）。

    持有两个资源：``ClientSession``（协议会话）与 ``AsyncExitStack``
    （传输流/会话的异步上下文，关闭时统一回收）。文本提取兼容 TextContent
    与未知内容类型（非文本内容按类型标注落明，不静默丢弃）。
    """

    def __init__(self, session: Any, exit_stack: AsyncExitStack) -> None:
        self._session = session
        self._exit_stack = exit_stack

    @classmethod
    async def open(cls, config: McpServerConfig) -> _SdkSession:
        """按配置打开真实会话（惰性 import mcp，感知各传输形态）。

        Raises:
            McpToolImportError: 配置与传输形态不匹配（如 http 缺 url）、
                SDK 缺失、连接/初始化异常——全部统一包装为导入错误，
                宿主只处理一个失败类型；SDK 内部取消（连接拒绝等失败
                路径的表达方式）同样收敛；外层任务真被取消时原样传播。
        """
        exit_stack: AsyncExitStack = AsyncExitStack()
        try:
            _require_mcp()
            if config.transport is McpTransport.HTTP:
                if not config.url:
                    raise McpToolImportError(
                        f"MCP server {config.id} 的 http 传输缺 url"
                    )
                # 双版本兼容：以运行时签名检测 API 形态（不依赖函数名下划线）
                # —— 含 http_client 参数即 2.x（headers 经 httpx 客户端注入），
                # 否则 1.x（streamablehttp_client(url, headers=...)）
                sig = inspect.signature(streamablehttp_client)
                if "http_client" in sig.parameters:
                    import httpx

                    http_client = (
                        httpx.AsyncClient(headers=dict(config.headers))
                        if config.headers
                        else None
                    )
                    if http_client is not None:
                        exit_stack.push_async_callback(http_client.aclose)
                    read, write = await exit_stack.enter_async_context(
                        streamablehttp_client(config.url, http_client=http_client)
                    )
                else:
                    client_kwargs: dict[str, Any] = {}
                    if config.headers:
                        client_kwargs["headers"] = config.headers
                    read, write = await exit_stack.enter_async_context(
                        streamablehttp_client(config.url, **client_kwargs)
                    )
            elif config.transport is McpTransport.STDIO:
                if not config.command:
                    raise McpToolImportError(
                        f"MCP server {config.id} 的 stdio 传输缺 command"
                    )
                from mcp import StdioServerParameters
                from mcp.client.stdio import stdio_client

                params = StdioServerParameters(
                    command=config.command,
                    args=list(config.args),
                    env=config.env,
                )
                if "errlog" in inspect.signature(stdio_client).parameters:
                    # SDK 支持 stderr 定向：执行件 stderr 捕获进引擎日志通道，
                    # 不再继承终端（执行件把 stderr 当结构化日志通道）
                    bridge = _ExecStderrBridge(get_logger(f"{__name__}.exec"))
                    errlog = await exit_stack.enter_async_context(bridge)
                    read, write = await exit_stack.enter_async_context(
                        stdio_client(params, errlog=errlog)
                    )
                else:
                    read, write = await exit_stack.enter_async_context(
                        stdio_client(params)
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
            result = await asyncio.wait_for(
                self._session.call_tool(name, arguments=args or {}),
                timeout=_CALL_TIMEOUT,
            )
        except TimeoutError as exc:
            raise GraphDefinitionError(
                f"MCP 工具调用超时: {name}（{_CALL_TIMEOUT} 秒）"
            ) from exc
        if getattr(result, "isError", False):
            raise GraphDefinitionError(
                f"MCP 工具执行失败: {name}: {_extract_text(result)}"
            )
        return _extract_text(result)

    async def aclose(self) -> None:
        await self._exit_stack.aclose()


class _SupervisedStdioSession(McpSessionHandle):
    """stdio 进程会话的受监督句柄：崩溃探测 + 按重启策略拉起。

    在既有 spawn/退出清理/stderr 桥（``_SdkSession.open``）之上只补
    监督，不重写底层：本句柄持有当前 ``_SdkSession``，调用失败视为
    进程崩溃（stdio 传输 = 进程生命周期绑定，协议失败即进程死了），
    走「拉起 → 回到服务」路径——拉起成功后**不透传重试原操作**：
    失败的工具调用可能已在崩溃前被部分执行，重试有非幂等副作用
    风险（fail-safe：诚实失败，下个调用命中新会话）。

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
        """会话调用 + 崩溃拉起（失败不上抛原操作重试——见类注释）。

        按进程粒度串行（会话即进程：监督路径需要单一所有者，并发
        崩溃会双重拉起且失败互踩）。会话建立失败（进程秒崩）与
        调用期失败同走拉起路径——两者都是「进程不可用」。
        """
        async with self._lock:
            try:
                session = await self._ensure_open()
                try:
                    return await op(session)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    await self._respawn(exc)
                    raise McpToolImportError(
                        f"MCP server {self._config.id} 的 stdio 进程在 {op_name} 期间崩溃"
                        f"（已按策略拉起，本次调用未重试——防非幂等副作用）: {exc}"
                    ) from exc
            except McpToolImportError:
                raise  # 熔断打开：直接拒绝
            except asyncio.CancelledError:
                raise  # 外层取消原样穿透（不误判为进程崩溃）
            except Exception as exc:
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
        client = getattr(session, "_session", None)
        ping = getattr(client, "send_ping", None)
        if ping is None:
            return  # SDK 该版本无 ping 能力 → 无法探测，按存活判定
        await asyncio.wait_for(ping(), timeout=_CALL_TIMEOUT)

    async def aclose(self) -> None:
        """释放句柄（切断监督：后续访问按 ensure_open 重新拉起）。"""
        async with self._lock:
            self._circuit_open = False
            self._consecutive_failures = 0
            await self._teardown()


def _extract_text(result: Any) -> str:
    """从 MCP 调用结果提取文本（兼容 TextContent 与结构化内容）。

    结果体 ``content`` 为内容项列表；内容项兼容 SDK 对象与 dict 两种
    形态（dict 形态常见于经 JSON 往返的代理/测试桩）；文本项按 text
    拼接并统一强转字符串，非文本项标注类型（``[<type>]``）后落明——
    不静默丢弃任何回执信息，也不把二进制/资源内容伪装成纯文本。
    """
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
        self._lock = asyncio.Lock()

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
    ) -> list[DeclarativeToolSpec]:
        """列出并转换 server 工具为声明式定义（必经 vetting 闸门过滤）。

        vetting 为 None = 跳过审查（挂载审批已在提案流程完成）；提供时
        逐工具生成清单并 vet，仅 VERIFIED 判定通过——REVIEW（静态审查
        命中，语义 = 需人工确认，不自动放行）与 REJECTED 同样不进入
        工具表（fail-closed：信任靠审查证据，不静默放行）。签名取显式
        传入值，缺省回落到 ``connect`` 时登记的连接签名。

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
            specs.append(spec)
        self._imported[server_id] = {spec.name for spec in specs}
        logger.info("MCP server 工具导入: %s（%d 个）", server_id, len(specs))
        return specs

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
    "McpClientManager",
    "McpServerConfig",
    "McpSessionHandle",
    "McpToolImportError",
    "McpTransport",
    "StdioRestartPolicy",
    "build_mcp_manifest",
    "convert_mcp_tool",
    "register_mcp_executor",
]
