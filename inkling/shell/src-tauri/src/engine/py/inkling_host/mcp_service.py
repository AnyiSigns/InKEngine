"""MCP 挂载服务：地址解析 → 配置推导 → vetting 核对 → 审批 → 补丁链。

三传输闭环（http/stdio/in_memory）全走引擎 McpClientManager（mcp SDK
2.x 兼容）；本服务只做挂载流程编排与数据推导（设计文档第六节模块 M3 挂载双入口
的共用链路）：

- 一键挂载（设置页「连接」）：市场条目 id → 市场配置落市场形态；
- 对话式安装（propose_mcp_mount 声明式工具）：任意地址 → 数据推导
  McpServerConfig（市场内落市场配置；Git/npm 推导 stdio 命令
  ``npx -y <pkg>``，仅作提案不直接执行）→ vetting 静态核对（清单
  一致性/命令白名单守卫）→ 审批卡预览（可 edit 改传输/命令，重走
  校验链）→ L2 批准 → 补丁链挂载可回退。

失败降级路径：任何一步失败都返回结构化 MountOutcome（不抛未包装
异常、不半挂载——失败时清理已连接会话与已落补丁，fail-closed）。
"""
from __future__ import annotations

import asyncio
import re
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from typing import Any

from ink_engine.core.mcp_client import (
    McpServerConfig,
    McpTransport,
    ToolSource,
)
from ink_engine.core.self_application import AUDIT_STATUS_REVERTED
from ink_engine.core.self_proposal import PatchKind, SelfProposal

# 地址形态前缀（resolve_address 的推导分支；npm/git 均只作提案）
_PREFIX_HTTP = ("http://", "https://")
_PREFIX_NPM = "npm:"
_PREFIX_GIT = "git:"

# stdio 命令推导模板参数（npx -y <包>，仅提案不执行）
_NPX_COMMAND = "npx"
_NPX_ARGS_PREFIX = ("-y",)

# 包名合法性（npm 包名规则子集：小写字母数字/连字符/点，可带 @scope/ 前缀）
_PACKAGE_NAME_RE = re.compile(
    r"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$"
)


@dataclass(frozen=True, slots=True)
class MountOutcome:
    """一次挂载尝试的结构化结果（失败也结构化，绝不裸抛）。"""

    ok: bool
    server_id: str = ""
    patch_ids: tuple[int, ...] = ()
    tool_names: tuple[str, ...] = ()
    status: str = ""
    error: str | None = None

    def render(self) -> str:
        """结果文本（工具调用回执/审批卡预览消费）。"""
        if self.ok:
            return (
                f"挂载成功：{self.server_id}（工具 "
                + ", ".join(self.tool_names)
                + f"，补丁 #{', '.join(map(str, self.patch_ids))}）"
            )
        return (
            f"挂载未完成：{self.server_id or '未知'} [{self.status}]"
            f" {self.error or ''}"
        )


class McpMountError(Exception):
    """挂载流程错误（地址解析失败等确定性错误）。"""


class McpMountService:
    """MCP 挂载编排服务（宿主装配期创建，运行时挂载/卸载/回退入口）。"""

    def __init__(
        self,
        runtime: Any,
        *,
        market: dict[str, Any],
        external_mark_vetted: Callable[[str], None] | None = None,
    ) -> None:
        self._runtime = runtime
        self._market = market
        self._external_mark_vetted = external_mark_vetted
        # 已通过 vetting 的 server 集合（L2 钩子据此放行，vetting → 审批
        # → L2 的顺序在机制上被强制执行）
        self._vetted_set: set[str] = set()
        # 命令白名单：数据驱动（市场条目声明的 stdio 命令 + 提案推导的 npx）
        self._allowed_commands: frozenset[str] = frozenset(
            {
                str(server.get("command"))
                for server in market.get("servers") or ()
                if server.get("command")
            }
            | {_NPX_COMMAND}
        )
        # 挂载登记（server_id → 补丁 id 序；卸载/回退按链尾倒序还原）
        self._mount_log: dict[str, list[int]] = {}
        # 嵌入式 server 工厂登记（in_memory 传输的宿主注入点：宿主把
        # 自带能力/测试 server 的工厂按 id 登记，市场条目无需携带工厂）
        self._server_factories: dict[str, Any] = {}

    def register_server_factory(self, server_id: str, factory: Any) -> None:
        """登记嵌入式 server 工厂（in_memory 传输的宿主注入点）。"""
        self._server_factories[server_id] = factory

    # ── 地址解析与配置推导 ──

    def _market_entry(self, server_id: str) -> dict[str, Any] | None:
        for server in self._market.get("servers") or ():
            if server.get("id") == server_id:
                return server
        return None

    def _config_from_market_entry(
        self, entry: dict[str, Any], *, server_factory: Any = None
    ) -> McpServerConfig:
        """市场条目 → McpServerConfig（市场内落市场配置，字段原样映射）。"""
        return McpServerConfig(
            id=str(entry["id"]),
            transport=McpTransport(str(entry.get("transport") or "http")),
            url=str(entry.get("url")) if entry.get("url") else None,
            command=str(entry.get("command")) if entry.get("command") else None,
            args=tuple(entry.get("args") or ()),
            source=ToolSource.UNKNOWN,
            server_factory=server_factory,
        )

    @staticmethod
    def _derive_server_id(address: str) -> str:
        """地址 → 稳定 server id（非字母数字折叠为点，防 id 漂移）。"""
        cleaned = re.sub(r"[^a-zA-Z0-9]+", ".", address).strip(".")
        return f"addr.{cleaned[:64]}"

    def resolve_address(self, address: str) -> McpServerConfig:
        """地址解析：市场条目 / http(s) url / npm 包 / git 仓库 → 配置。

        仅推导不执行：npx 命令只是提案形态，实际运行前必经
        vetting → 审批 → 补丁链（出厂零预挂，任何挂载都走既有链路）。
        """
        address = address.strip()
        if not address:
            raise McpMountError("挂载地址为空")
        entry = self._market_entry(address)
        if entry is not None:
            return self._config_from_market_entry(entry)
        if address.startswith(_PREFIX_HTTP):
            return McpServerConfig(
                id=self._derive_server_id(address),
                transport=McpTransport.HTTP,
                url=address,
                source=ToolSource.UNKNOWN,
            )
        if address.startswith(_PREFIX_NPM):
            package = address[len(_PREFIX_NPM):].strip()
            if not _PACKAGE_NAME_RE.match(package):
                raise McpMountError(f"npm 包名非法: {package!r}")
            return McpServerConfig(
                id=f"npm.{package}",
                transport=McpTransport.STDIO,
                command=_NPX_COMMAND,
                args=(*_NPX_ARGS_PREFIX, package),
                source=ToolSource.UNKNOWN,
            )
        if address.startswith(_PREFIX_GIT):
            repo = address[len(_PREFIX_GIT):].strip()
            if not repo or " " in repo:
                raise McpMountError(f"git 仓库地址非法: {address!r}")
            return McpServerConfig(
                id=f"git.{self._derive_server_id(repo)}",
                transport=McpTransport.STDIO,
                command=_NPX_COMMAND,
                args=(*_NPX_ARGS_PREFIX, repo),
                source=ToolSource.UNKNOWN,
            )
        raise McpMountError(
            f"无法解析挂载地址: {address!r}"
            "（支持市场条目 id / http(s) url / npm:包名 / git:仓库）"
        )

    # ── vetting 静态核对 ──

    def vetting_checks(self, config: McpServerConfig) -> list[str]:
        """挂载前静态核对（清单一致性 + 命令白名单守卫），返回违规清单。

        核对项（与 mcp_market.json mount_policy.required 对齐）：
        - 传输形态与配置字段匹配（http 须 url、stdio 须 command、
          in_memory 须嵌入式工厂）；
        - stdio 命令 ∈ 白名单（市场条目声明命令 ∪ npx 提案推导）；
        - 市场内条目与目录声明一致（防改头换面挂载）。
        """
        violations: list[str] = []
        if config.transport is McpTransport.HTTP:
            scheme = config.url.split("://", 1)[0] if config.url else ""
            if scheme not in ("http", "https"):
                violations.append("http 传输须携带 http(s) url")
        elif config.transport is McpTransport.STDIO:
            if not config.command:
                violations.append("stdio 传输缺命令")
            elif config.command not in self._allowed_commands:
                violations.append(f"stdio 命令不在白名单: {config.command}")
            if config.command == _NPX_COMMAND and not any(
                arg and not arg.startswith("-") for arg in config.args
            ):
                violations.append("npx 提案须携带包名参数")
        elif config.transport is McpTransport.IN_MEMORY:
            if config.server_factory is None:
                violations.append("in_memory 传输须注入嵌入式 server 工厂")
        entry = self._market_entry(config.id)
        if entry is not None:
            declared = {
                "transport": str(entry.get("transport") or "http"),
                "url": entry.get("url"),
                "command": entry.get("command"),
                "args": tuple(entry.get("args") or ()),
            }
            actual = {
                "transport": config.transport.value,
                "url": config.url,
                "command": config.command,
                "args": config.args,
            }
            if declared != actual:
                violations.append("清单一致性：与市场目录声明不符")
        return violations

    # ── 挂载 / 卸载 / 回退 ──

    async def propose_mount(
        self,
        ctx: Any,
        address: str,
        *,
        server_factory: Any = None,
        round_id: str | None = None,
    ) -> MountOutcome:
        """对话式安装链路：地址解析 → 配置推导 → vetting → 审批 → 落链。"""
        try:
            config = self.resolve_address(address)
        except McpMountError as exc:
            return MountOutcome(
                ok=False, status="resolve_failed", error=str(exc)
            )
        return await self.mount_config(
            ctx, config, server_factory=server_factory, round_id=round_id
        )

    async def mount_config(
        self,
        ctx: Any,
        config: McpServerConfig,
        *,
        server_factory: Any = None,
        round_id: str | None = None,
    ) -> MountOutcome:
        """挂载一个 server 配置（市场一键挂载与对话式安装共用）。

        两阶段流程（「仅提案不直接执行」的机制保障）：
        1. 提案阶段：vetting 静态核对 → 挂载审批卡预览（可 edit 改
           传输/命令，重走校验链）——Git/npm 推导的 stdio 命令在此
           阶段不产生任何进程，批准后才进入执行阶段；
        2. 执行阶段：connect → 工具导入 → 逐工具 TOOL 提案（L2 审批）
           → 补丁链落链 → 引擎重建。

        任一步失败清理已建立的会话/补丁（不半挂载），失败原因结构化
        返回（SDK 边界异常也按降级路径处理，不击穿挂载流程）。
        """
        if server_factory is not None:
            config = _with_factory(config, server_factory)
        elif (
            config.transport is McpTransport.IN_MEMORY
            and config.server_factory is None
        ):
            embedded = self._server_factories.get(config.id)
            if embedded is not None:
                config = _with_factory(config, embedded)
        violations = self.vetting_checks(config)
        if violations:
            return MountOutcome(
                ok=False, server_id=config.id,
                status="vetting_rejected", error="；".join(violations),
            )
        decision = await self._mount_approval(ctx, config)
        if decision == "vetting_rejected":
            return MountOutcome(
                ok=False, server_id=config.id,
                status="vetting_rejected",
                error="编辑后的配置未通过校验链（重走 vetting 核对）",
            )
        if decision in ("reject", "terminate"):
            return MountOutcome(
                ok=False, server_id=config.id,
                status="rejected", error="挂载审批未通过",
            )
        manager = self._runtime.mcp_manager
        try:
            await manager.connect(config)
        except asyncio.CancelledError:
            # SDK 连接失败路径会把内部取消扩散到调用方（mcp 2.x 边缘
            # 行为）：区分「本任务被外部取消」（正常取消语义，继续传播）
            # 与「SDK 内部取消泄漏」（按连接失败降级处理，fail-closed）。
            task = asyncio.current_task()
            if task is not None and task.cancelling() > 0:
                raise
            return MountOutcome(
                ok=False, server_id=config.id,
                status="connect_failed",
                error="连接失败: 传输层异常（连接被拒绝或初始化未完成）",
            )
        except BaseException as exc:
            return MountOutcome(
                ok=False, server_id=config.id,
                status="connect_failed", error=f"连接失败: {exc}",
            )
        try:
            specs = await manager.import_tools(config.id)
        except asyncio.CancelledError:
            await manager.disconnect(config.id)
            raise
        except BaseException as exc:
            await manager.disconnect(config.id)
            return MountOutcome(
                ok=False, server_id=config.id,
                status="import_failed", error=f"工具导入失败: {exc}",
            )
        if not specs:
            await manager.disconnect(config.id)
            return MountOutcome(
                ok=False, server_id=config.id,
                status="import_failed", error="server 未暴露任何工具",
            )
        self.mark_vetted(config.id, specs)
        patch_ids: list[int] = []
        tool_names: list[str] = []
        base_version = await self._runtime.self_pipeline.chain.current_version()
        for spec in specs:
            proposal = SelfProposal(
                kind=PatchKind.TOOL,
                payload=spec.to_dict(),
                base_version=base_version,
                rationale=f"MCP 挂载：{config.id}",
                meta={"mcp_server": config.id, "mcp_tool": spec.name},
            )
            outcome = await self._runtime.self_pipeline.apply(
                ctx, proposal, round_id=round_id
            )
            if not outcome.applied:
                # 部分失败回滚：已落补丁按链尾倒序还原（revert 只支持链尾）
                await self._rollback_patches(ctx, patch_ids, round_id=round_id)
                await manager.disconnect(config.id)
                return MountOutcome(
                    ok=False, server_id=config.id, status=outcome.status,
                    error=outcome.reason or "审批未通过",
                )
            patch_ids.append(outcome.patch_id)
            tool_names.append(spec.name)
            base_version = outcome.patch_id
        self._mount_log[config.id] = list(patch_ids)
        self._sync_introspection()
        await self._runtime.rebuild_engine()
        return MountOutcome(
            ok=True, server_id=config.id,
            patch_ids=tuple(patch_ids), tool_names=tuple(tool_names),
            status="mounted",
        )

    async def _mount_approval(self, ctx: Any, config: McpServerConfig) -> str:
        """挂载审批卡预览（提案阶段）：可 edit 改传输/命令，重走校验链。

        卡负载 = 派生配置的可读形态（transport/url/command/args）；
        edit 决议的 edited_content 作为新配置重跑 vetting 核对
        （重走校验链 = 编辑内容与提案同门禁）。返回决议：
        accept / reject / terminate / vetting_rejected。
        """
        card = {
            "review_type": "mount",
            "server_id": config.id,
            "transport": config.transport.value,
            "url": config.url,
            "command": config.command,
            "args": list(config.args),
            "note": "挂载提案预览：可 edit 修改传输/命令后重走校验链",
        }
        injected = await ctx.interrupt(f"mount:{config.id}", card)
        if isinstance(injected, str):
            return injected
        if isinstance(injected, dict) and injected.get("decision") == "edit":
            edited = injected.get("edited_content")
            if not isinstance(edited, dict):
                return "vetting_rejected"
            edited_config = _config_from_edited(config, edited)
            if self.vetting_checks(edited_config):
                return "vetting_rejected"
            return "accept"
        return "reject"

    async def unmount(
        self,
        ctx: Any,
        server_id: str,
        *,
        reason: str = "",
        round_id: str | None = None,
    ) -> MountOutcome:
        """卸载（补丁链回退）：回退该 server 的挂载补丁 → 活跃态移除 → 会话断开。

        引擎链回退语义：revert 只支持链尾单步，且回退后剩余补丁折叠
        进新 base（版本复位）——因此一次卸载 = 回退链尾补丁（须属于
        该 server，否则拒绝并要求先回退后继）。回退完成后活跃态移除
        （工具表/声明式定义）+ 会话断开 + 引擎重建——挂载/回退成对，
        任一步失败都结构化返回。
        """
        patch_ids = list(self._mount_log.get(server_id) or ())
        if not patch_ids:
            return MountOutcome(
                ok=False, server_id=server_id,
                status="not_mounted", error="该 server 无挂载记录",
            )
        tail = await self._runtime.self_pipeline.chain.last_patch()
        if tail is None or not _patch_belongs_to_server(tail, server_id):
            return MountOutcome(
                ok=False, server_id=server_id, status="tail_conflict",
                error="链尾补丁不属于该 server（先回退后继补丁）",
            )
        current = await self._runtime.self_pipeline.chain.current_version()
        outcome = await self._runtime.self_pipeline.revert(
            ctx, current, reason=reason or "卸载", round_id=round_id
        )
        if outcome.status != AUDIT_STATUS_REVERTED:
            return MountOutcome(
                ok=False, server_id=server_id, status=outcome.status,
                error=outcome.reason or "回退未完成",
            )
        removed = self._remove_server_tools(server_id)
        self._mount_log.pop(server_id, None)
        manager = self._runtime.mcp_manager
        if manager is not None:
            await manager.disconnect(server_id)
        self._sync_introspection()
        await self._runtime.rebuild_engine()
        return MountOutcome(
            ok=True, server_id=server_id,
            patch_ids=(current,), tool_names=tuple(removed),
            status="unmounted",
        )

    async def _rollback_patches(
        self,
        ctx: Any,
        patch_ids: list[int],
        *,
        round_id: str | None = None,
    ) -> None:
        """部分失败回滚（链尾倒序还原已落补丁，尽力而为不抛错）。"""
        for patch_id in reversed(patch_ids):
            with suppress(Exception):
                await self._runtime.self_pipeline.revert(
                    ctx, patch_id, reason="挂载部分失败回滚", round_id=round_id
                )

    def mark_vetted(self, server_id: str, specs: Any = None) -> None:
        """登记已通过 vetting 的 server（L2 钩子放行依据）。

        specs（导入期工具清单，可选）随登记透传——影子 vetting 的
        比对依据（工具名/参数必填项在 L2 钩子核对，不真执行）。
        """
        self._vetted_set.add(server_id)
        if self._external_mark_vetted is not None:
            self._external_mark_vetted(server_id, specs)

    def _remove_server_tools(self, server_id: str) -> tuple[str, ...]:
        """移除某 server 挂载工具的活跃态（声明式定义 + 统一工具表）。"""
        removed: list[str] = []
        for name, definition in list(
            self._runtime.harness_registry.declarative.definitions.items()
        ):
            if definition.meta.get("mcp_server") == server_id:
                removed.append(name)
                self._runtime.tool_registry.pop(name, None)
                self._runtime.harness_registry.declarative.unregister_definition(name)
        return tuple(removed)

    def _sync_introspection(self) -> None:
        """刷新内省快照的工具清单来源（补丁链为权威，重启自动恢复）。"""
        self._runtime.introspection_service._sources.tools = (
            self._runtime.collect_specs()
        )

    # ── L2 验证钩子 ──

    def l2_vetting_hook(self) -> Callable[[Any], list[str]]:
        """L2 验证钩子（补丁链 deploy 前门禁）：MCP 挂载须已过 vetting。

        与 recipe_loader 的默认钩子同语义；本钩子由宿主装配时提供给
        配方（mark_vetted 由本服务持有，vetting → 审批 → L2 的顺序
        在同一实例内闭环）。
        """

        def hook(proposal: Any) -> list[str]:
            if getattr(proposal, "kind", None) is not PatchKind.TOOL:
                return []
            payload = proposal.payload or {}
            if payload.get("endpoint") != "mcp":
                return []
            server_id = (payload.get("endpoint_config") or {}).get("server_id")
            if not isinstance(server_id, str) or server_id not in self._vetted_set:
                return [
                    f"MCP 挂载未经 vetting 核对（server 未登记放行: {server_id!r}）"
                ]
            return []

        return hook

    @property
    def mounted_servers(self) -> tuple[str, ...]:
        """当前挂载登记（设置页「连接」视图数据源）。"""
        return tuple(self._mount_log)


def _patch_belongs_to_server(tail: dict[str, Any], server_id: str) -> bool:
    """链尾补丁是否属于该 server（按挂载工具声明的 meta.mcp_server 判定）。"""
    value = tail.get("value")
    if not isinstance(value, dict):
        return False
    return value.get("meta", {}).get("mcp_server") == server_id


def _config_from_edited(
    original: McpServerConfig, edited: dict[str, Any]
) -> McpServerConfig:
    """审批卡 edit 决议 → 新配置（编辑字段覆盖，未编辑字段保留）。"""
    return McpServerConfig(
        id=str(edited.get("server_id") or original.id),
        transport=McpTransport(str(edited.get("transport") or original.transport.value)),
        url=edited.get("url") if edited.get("url") is not None else original.url,
        command=edited.get("command") if edited.get("command") is not None else original.command,
        args=tuple(edited.get("args") or original.args),
        headers=original.headers,
        env=original.env,
        source=original.source,
        signature=original.signature,
        server_factory=original.server_factory,
    )


def _with_factory(config: McpServerConfig, factory: Any) -> McpServerConfig:
    """配置注入嵌入式 server 工厂（in_memory 传输的宿主注入点）。"""
    return McpServerConfig(
        id=config.id,
        transport=config.transport,
        url=config.url,
        headers=config.headers,
        command=config.command,
        args=config.args,
        env=config.env,
        source=config.source,
        signature=config.signature,
        server_factory=factory,
    )


def in_memory_server_factory(server: Any):
    """嵌入式 MCP server 工厂（in_memory 传输）：宿主/开发者注入。

    返回工厂可调用（引擎按 ``config.server_factory()`` 打开会话）：
    基于 mcp SDK 的内存双向流（create_client_server_memory_streams），
    客户端流交给引擎会话，服务端流在后台任务运行——http/stdio 之外
    的第三种传输形态，测试与嵌入式 server（宿主自带能力）共用。
    """
    from mcp.shared.memory import create_client_server_memory_streams

    @asynccontextmanager
    async def factory():
        async with create_client_server_memory_streams() as (
            client_streams,
            server_streams,
        ):
            read, write = server_streams
            task = asyncio.create_task(_run_server_until_closed(server, read, write))
            try:
                yield client_streams
            finally:
                task.cancel()
                # 取消是正常收尾路径（会话关闭触发），不向上传播
                with suppress(BaseException):
                    await task

    return factory


async def _run_server_until_closed(server: Any, read: Any, write: Any) -> None:
    """后台运行 MCP server（客户端断开/取消是正常结束路径，不抛错）。"""
    try:
        async with write:
            await server.run(read, write, server.create_initialization_options())
    except BaseException:
        pass


__all__ = [
    "McpMountError",
    "McpMountService",
    "MountOutcome",
    "in_memory_server_factory",
]
