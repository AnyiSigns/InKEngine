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
- stdio：``StdioServerParameters(command, args, env)`` 拉起本地进程；
- in_memory：宿主注入 ``server_factory``（返回 (read, write) 流对的异步
  上下文管理器），用于内嵌 server 或测试桩，不依赖真实网络/进程。
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

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

# 工具调用结果文本截断上限（与引擎工具流水线默认一致，防大对象挤爆上下文）
_MAX_RESULT_CHARS = 100_000

# 内存传输的 server 工厂签名：() -> 异步上下文管理器，产出 (read, write) 流对
ServerFactory = Callable[[], Any]


class McpTransport(StrEnum):
    """MCP 连接传输形态（HTTP 为主，stdio 次之，内存用于内嵌/测试）。"""

    HTTP = "http"
    STDIO = "stdio"
    IN_MEMORY = "in_memory"


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

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "transport": self.transport.value,
            "source": self.source.value,
        }
        if self.url:
            data["url"] = self.url
        if self.headers:
            data["headers"] = dict(self.headers)
        if self.command:
            data["command"] = self.command
        if self.args:
            data["args"] = list(self.args)
        if self.env:
            data["env"] = dict(self.env)
        if self.signature:
            data["signature"] = self.signature
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
            inputSchema）或等价 dict。

    Raises:
        GraphDefinitionError: 工具缺 name（MCP 协议违规）。
    """
    if isinstance(tool, dict):
        name = tool.get("name")
        description = tool.get("description") or ""
        schema = tool.get("inputSchema")
    else:
        name = getattr(tool, "name", None)
        description = getattr(tool, "description", "") or ""
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
                宿主只处理一个失败类型。
        """
        exit_stack: AsyncExitStack = AsyncExitStack()
        try:
            _require_mcp()
            if config.transport is McpTransport.HTTP:
                if not config.url:
                    raise McpToolImportError(
                        f"MCP server {config.id} 的 http 传输缺 url"
                    )
                from mcp.client.streamable_http import streamablehttp_client

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
            await exit_stack.aclose()
            raise
        except Exception as exc:
            await exit_stack.aclose()
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
    "build_mcp_manifest",
    "convert_mcp_tool",
    "register_mcp_executor",
]
