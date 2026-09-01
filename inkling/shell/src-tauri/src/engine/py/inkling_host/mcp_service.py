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
import os
import re
from collections.abc import Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from typing import Any

from ink_engine.core.declarative_tools import EndpointType
from ink_engine.core.mcp_client import (
    McpServerConfig,
    McpTransport,
    ToolSource,
)
from ink_engine.core.logging import get_logger
from ink_engine.core.self_application import AUDIT_STATUS_REVERTED
from ink_engine.core.self_proposal import PatchKind, SelfProposal

logger = get_logger(__name__)

# 地址形态前缀（resolve_address 的推导分支；npm/git 均只作提案）
_PREFIX_HTTP = ("http://", "https://")
_PREFIX_NPM = "npm:"
_PREFIX_GIT = "git:"

# stdio 命令推导模板参数（npx -y <包>，仅提案不执行）
# Windows 平台用 npx.cmd：asyncio.create_subprocess_exec 直接 exec 不
# 解析 .cmd/.ps1 扩展（npx 裸名在 Windows 上 WinError 2 启动失败），
# .cmd 变体经 CreateProcess 可解析；POSIX 平台保持 npx 裸名。
_NPX_COMMAND = "npx.cmd" if os.name == "nt" else "npx"
_NPX_ARGS_PREFIX = ("-y",)

# 包名合法性（npm 包名规则子集：小写字母数字/连字符/点，可带 @scope/ 前缀）
_PACKAGE_NAME_RE = re.compile(
    r"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$"
)

# 用户市场持久化集合与键（storage records；配置形态，不参与旁路写守卫）
_MARKETS_COLLECTION = "mcp_markets"
_MARKETS_KEY = "registry"
# 挂载 server 配置持久化（重启还原连接；配置往返保持明文——需还原重连）
_MOUNT_CONFIGS_COLLECTION = "mcp_mounts"
_MOUNT_CONFIGS_KEY = "server_configs"
# 市场目录抓取超时（秒）
_CATALOG_FETCH_TIMEOUT = 15.0
# 市场目录校验枚举
_VALID_RISKS = ("low", "medium", "high")
_VALID_TRANSPORTS = ("http", "stdio")


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


class _AutoAcceptCtx:
    """手动挂载合成审批上下文：用户在 UI 点击挂载即授权。

    回合外手动挂载没有 agent 回合 ctx；逐工具 TOOL 提案落补丁链时
    ``approve_before_execute`` 仍会挂卡——本上下文把决议恒置 accept，
    与「手动挂载免审批卡（方案 B）」语义一致：挂载动作本身就是用户
    授权，工具使用期的高风险闸门照旧由工具声明的权限档兜底。
    """

    __slots__ = ()

    async def interrupt(self, key: str, card: dict) -> dict:
        return {"decision": "accept"}

    async def get_interrupt_payload(self, key: str) -> None:
        return None


def _assert_public_http_host(link: str) -> None:
    """SSRF 防线：http(s) 市场链接仅允许解析到公网地址。

    拒绝私有（RFC1918）/回环/链路本地/保留/组播地址，防引擎进程被
    引导去抓取内网资源（云元数据 169.254.169.254、内部 API、localhost）。
    连接建立前的防御性校验（DNS 重绑仍需更严格的连接钉扎，桌面设置
    场景下本防线 + 用户预览确认已足够）。
    """
    import ipaddress as _ip
    import socket as _socket
    from urllib.parse import urlsplit as _urlsplit

    parts = _urlsplit(link)
    if parts.scheme not in ("http", "https"):
        raise McpMountError(f"仅支持 http(s) 市场链接: {link!r}")
    host = (parts.hostname or "").strip()
    if not host:
        raise McpMountError("市场链接缺主机名")
    try:
        infos = _socket.getaddrinfo(
            host, parts.port or (443 if parts.scheme == "https" else 80)
        )
    except OSError as exc:
        raise McpMountError(f"市场链接主机解析失败: {host!r}") from exc
    if not infos:
        raise McpMountError(f"市场链接主机无解析结果: {host!r}")
    for info in infos:
        address = info[4][0].split("%", 1)[0]
        try:
            addr = _ip.ip_address(address)
        except ValueError:
            continue
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_reserved
            or addr.is_multicast
        ):
            raise McpMountError(
                f"市场链接主机指向内网/保留地址: {host} ({address})"
            )


def _fetch_catalog(link: str) -> dict[str, Any]:
    """拉取市场目录：http(s) url / file:// 路径 / 本地文件路径 → dict。

    仅拉取不执行；目录内容后续经 ``_vet_catalog`` 静态核对后才可落
    注册表（外部目录摄入不可信，任何市场条目都不是出厂预挂）。
    http(s) 链接先过 SSRF 防线（仅公网地址）；file:// 与本地路径由
    用户在设置页显式提供（本机文件），不联网。
    """
    import json as _json
    import urllib.request as _url
    from pathlib import Path as _Path

    if link.startswith(("http://", "https://")):
        _assert_public_http_host(link)
        with _url.urlopen(link, timeout=_CATALOG_FETCH_TIMEOUT) as resp:
            text = resp.read().decode("utf-8")
    elif link.startswith("file://"):
        text = _Path(link[len("file://"):]).read_text(encoding="utf-8")
    else:
        text = _Path(link).read_text(encoding="utf-8")
    catalog = _json.loads(text)
    if not isinstance(catalog, dict):
        raise McpMountError("市场目录须为 JSON 对象")
    return catalog


def _vet_catalog(catalog: dict[str, Any]) -> list[str]:
    """市场目录静态核对（vetting）：结构/字段/枚举越界 → 违规清单。

    核对项：servers 非空数组；每条目须带 id/name；transport ∈
    {http, stdio}（in_memory 须嵌入式工厂，外部目录不可携带）；
    http 须 http(s) url、stdio 须 command；risk/args 枚举与形态。
    命令白名单属挂载期核对（vetting_checks），此处不判——新市场
    命令加入注册表后并入白名单并集。
    """
    violations: list[str] = []
    servers = catalog.get("servers")
    if not isinstance(servers, list):
        return ["市场目录缺 servers 数组"]
    if not servers:
        return ["市场目录 servers 为空"]
    for idx, server in enumerate(servers):
        prefix = f"servers[{idx}]"
        if not isinstance(server, dict):
            violations.append(f"{prefix} 须为对象")
            continue
        sid = server.get("id")
        if not sid or not isinstance(sid, str) or not sid.strip():
            violations.append(f"{prefix} 缺 id")
        name = server.get("name")
        if not name or not isinstance(name, str) or not name.strip():
            violations.append(f"{prefix} 缺 name")
        transport = str(server.get("transport") or "http")
        if transport not in _VALID_TRANSPORTS:
            violations.append(f"{prefix} transport 非法: {transport!r}")
        if transport == "http":
            url = server.get("url")
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                violations.append(f"{prefix} http 传输须携带 http(s) url")
        else:
            command = server.get("command")
            if not isinstance(command, str) or not command:
                violations.append(f"{prefix} stdio 传输缺 command")
        risk = server.get("risk")
        if risk is not None and risk not in _VALID_RISKS:
            violations.append(f"{prefix} risk 非法: {risk!r}")
        args = server.get("args")
        if args is not None and not isinstance(args, list):
            violations.append(f"{prefix} args 须为数组")
    return violations


def _market_name_from_link(link: str) -> str:
    """市场链接 → 展示名（URL 尾段或原样）。"""
    cleaned = re.sub(r"^https?://", "", link).rstrip("/")
    tail = cleaned.rsplit("/", 1)[-1] if "/" in cleaned else cleaned
    return tail or cleaned or "MCP 市场"


def _preview_from_catalog(catalog: dict[str, Any], link: str) -> dict[str, Any]:
    """目录 → 审批预览（名称/来源/服务数/风险分布/条目摘要）。"""
    servers = catalog.get("servers") or ()
    risk_summary: dict[str, int] = {"low": 0, "medium": 0, "high": 0}
    rows: list[dict[str, Any]] = []
    for server in servers:
        if not isinstance(server, dict):
            continue
        risk = str(server.get("risk") or "medium")
        risk_summary[risk] = risk_summary.get(risk, 0) + 1
        rows.append(
            {
                "id": str(server.get("id") or server.get("name") or ""),
                "name": server.get("name") or server.get("id") or "",
                "transport": server.get("transport") or "http",
                "risk": risk,
                "risk_note": server.get("risk_note") or "",
            }
        )
    return {
        "name": catalog.get("name") or _market_name_from_link(link),
        "source": link,
        "server_count": len(servers),
        "risk_summary": risk_summary,
        "servers": rows,
    }


class McpMountService:
    """MCP 挂载编排服务（宿主装配期创建，运行时挂载/卸载/回退入口）。

    多市场注册表：内置种子市场（缺省 id "market"，出厂零预挂）∪ 用户
    持久化市场（连接页「添加链接挂载新市场」摄入，storage 落库）。命令
    白名单 = 全部市场声明命令 ∪ npx 提案推导的并集。
    """

    def __init__(
        self,
        runtime: Any,
        *,
        markets: list[dict[str, Any]] | dict[str, Any] | None = None,
        external_mark_vetted: Callable[[str], None] | None = None,
    ) -> None:
        self._runtime = runtime
        # 市场注册表：market_id → 市场目录（含归一化后的 servers）。
        self._markets: dict[str, dict[str, Any]] = {}
        self._external_mark_vetted = external_mark_vetted
        # 已通过 vetting 的 server 集合（L2 钩子据此放行，vetting → 审批
        # → L2 的顺序在机制上被强制执行）
        self._vetted_set: set[str] = set()
        # 命令白名单：数据驱动（全市场条目声明的 stdio 命令 + npx 提案）
        self._allowed_commands: frozenset[str] = frozenset()
        # 挂载登记（server_id → 补丁 id 序；卸载/回退按链尾倒序还原）
        self._mount_log: dict[str, list[int]] = {}
        # 嵌入式 server 工厂登记（in_memory 传输的宿主注入点：宿主把
        # 自带能力/测试 server 的工厂按 id 登记，市场条目无需携带工厂）
        self._server_factories: dict[str, Any] = {}
        builtins = (
            markets
            if isinstance(markets, list)
            else ([markets] if markets else [])
        )
        for catalog in builtins:
            if isinstance(catalog, dict):
                self._markets[catalog.get("id") or "market"] = self._ingest_market(
                    catalog, builtin=True
                )
        self._rebuild_allowed_commands()

    # ── 市场注册表（多市场：内置 ∪ 用户持久化）──

    @staticmethod
    def _normalize_server_id(market_id: str, raw: str) -> str:
        """市场内条目 id 归一：加市场前缀防跨市场碰撞（内置 market.* 保持）。"""
        if raw.startswith(f"{market_id}."):
            return raw
        return f"{market_id}.{raw}"

    def _ingest_market(self, catalog: dict[str, Any], *, builtin: bool) -> dict[str, Any]:
        """目录 → 注册表形态：市场 id 归一 + 条目 id 加前缀 + builtin 标记。

        市场 id：显式 ``id`` 字段优先；缺省由来源（链接/名称）推导
        ``mk.<hash>``（内置市场由宿主装配显式带 ``id: "market"``）。
        """
        market = dict(catalog or {})
        mid = str(market.get("id") or "").strip()
        if not mid or not re.match(r"^[a-zA-Z0-9._-]+$", mid):
            mid = (
                f"mk.{self._derive_server_id(str(market.get('source') or market.get('name') or 'catalog'))}"
            )
        market["id"] = mid
        market["builtin"] = bool(builtin)
        servers = []
        for server in market.get("servers") or ():
            if not isinstance(server, dict):
                continue
            entry = dict(server)
            raw_id = str(entry.get("id") or entry.get("name") or "server")
            entry["id"] = self._normalize_server_id(mid, raw_id)
            servers.append(entry)
        market["servers"] = servers
        return market

    def _rebuild_allowed_commands(self) -> None:
        """命令白名单重建：全部市场条目声明命令 ∪ npx 提案推导。"""
        commands: set[str] = {_NPX_COMMAND}
        for market in self._markets.values():
            for server in market.get("servers") or ():
                command = server.get("command")
                if isinstance(command, str) and command:
                    commands.add(command)
        self._allowed_commands = frozenset(commands)

    def _market_summary(self, market: dict[str, Any]) -> dict[str, Any]:
        """市场摘要（前端列表/审批预览消费；servers 为条目摘要形态）。"""
        return {
            "id": market["id"],
            "name": market.get("name") or market["id"],
            "source": market.get("source") or "",
            "builtin": bool(market.get("builtin")),
            "servers": [self._server_summary(s) for s in market.get("servers") or ()],
        }

    def _server_summary(self, server: dict[str, Any]) -> dict[str, Any]:
        """市场条目摘要（对齐前端 McpMarketEntry 形态）。"""
        return {
            "id": str(server.get("id") or ""),
            "name": server.get("name") or server.get("id") or "",
            "source": server.get("source") or "",
            "transport": str(server.get("transport") or "http"),
            "url": server.get("url"),
            "command": server.get("command"),
            "args": list(server.get("args") or ()),
            "credentials": server.get("credentials")
            or {"required": False, "note": ""},
            "risk": str(server.get("risk") or "medium"),
            "risk_note": server.get("risk_note") or "",
            "category": server.get("category") or "",
            "premounted": bool(server.get("premounted")),
        }

    async def load_persisted_markets(self) -> None:
        """启动装载用户市场（storage 单记录；集合不参与守卫=配置形态）。

        装载失败（存储异常/记录损坏）只记日志不击穿启动——内置市场照常
        可用，用户市场下次写入时以新态覆盖。
        """
        try:
            record = await self._runtime.storage.get_record(
                _MARKETS_COLLECTION, _MARKETS_KEY
            )
        except Exception as exc:
            logger.warning("用户 MCP 市场装载失败（忽略，仅内置市场）: %s", exc)
            record = None
        markets = (record or {}).get("markets") or {}
        for market in markets.values():
            if not isinstance(market, dict):
                continue
            try:
                ingested = self._ingest_market(market, builtin=False)
                self._markets[ingested["id"]] = ingested
            except Exception:
                continue
        self._rebuild_allowed_commands()

    async def _persist_markets(self) -> None:
        """用户市场落库（单记录 {markets: {id: market}}；内置不落库）。"""
        user_markets = {
            mid: {k: v for k, v in m.items() if k != "builtin"}
            for mid, m in self._markets.items()
            if not m.get("builtin")
        }
        await self._runtime.storage.put_record(
            _MARKETS_COLLECTION, _MARKETS_KEY, {"markets": user_markets}
        )

    def list_markets(self) -> list[dict[str, Any]]:
        return [self._market_summary(m) for m in self._markets.values()]

    def status(self) -> dict[str, Any]:
        """挂载状态快照（设置「连接」/「市场」视图数据源）。"""
        markets = self.list_markets()
        mounted = {
            sid: {
                "server_id": sid,
                "tools": list(self._mounted_server_tools(sid)),
            }
            for sid in self._mount_log
        }
        return {"markets": markets, "mounted": mounted}

    def _mounted_server_tools(self, server_id: str) -> tuple[str, ...]:
        """某 server 挂载工具名（活跃态声明式定义按 meta.mcp_server 判定）。"""
        names: list[str] = []
        definitions = getattr(
            getattr(self._runtime, "harness_registry", None), "declarative", None
        )
        if definitions is not None:
            for name, definition in getattr(definitions, "definitions", {}).items():
                if (getattr(definition, "meta", None) or {}).get("mcp_server") == server_id:
                    names.append(name)
        return tuple(names)

    def restore_mount_log(self, assembled: dict[str, Any]) -> None:
        """重启恢复挂载登记：链内 mcp 端点工具按 server 回填（补丁序占位）。

        与 Rust 侧 boot.rs 的 ``plan_mcp_mount_restore`` 同口径：挂载
        登记是会话态内存数据，补丁 id 序重启丢失——占位空序供卸载判定
        （链尾归属检查兜底，见 ``unmount``）。
        """
        tools = (assembled or {}).get("tools") or {}
        for payload in tools.values():
            if not isinstance(payload, dict):
                continue
            if payload.get("endpoint") != "mcp":
                continue
            server_id = (payload.get("endpoint_config") or {}).get("server_id")
            if isinstance(server_id, str) and server_id:
                self._mount_log.setdefault(server_id, [])

    async def load_persisted_mount_configs(self) -> None:
        """启动还原挂载 server 连接（storage 持久化的配置；失败只记日志）。

        挂载 = 持久授权：重启后工具注册已随链恢复（restore_mount_log），
        连接的 server 会话按持久化配置重建——stdio 拉起进程（npx/git）、
        http 直连。连接失败不击穿启动：工具照常注册，执行时在线判定
        （离线降级与未挂载 server 一致）。
        """
        try:
            record = await self._runtime.storage.get_record(
                _MOUNT_CONFIGS_COLLECTION, _MOUNT_CONFIGS_KEY
            )
        except Exception as exc:
            logger.warning("挂载 server 配置装载失败（忽略）: %s", exc)
            return
        configs = (record or {}).get("configs") or {}
        manager = self._runtime.mcp_manager
        for server_id, payload in configs.items():
            if not isinstance(payload, dict):
                continue
            try:
                config = McpServerConfig.from_dict(payload)
            except Exception as exc:
                logger.warning("挂载配置还原失败（跳过 %s）: %s", server_id, exc)
                continue
            try:
                await manager.connect(config)
                logger.info("挂载 server 连接还原: %s", server_id)
            except Exception as exc:
                logger.warning("挂载 server 重连失败（离线降级）: %s: %s", server_id, exc)

    async def _persist_mount_configs(self) -> None:
        """挂载 server 配置落库（单记录 {configs: {server_id: config}}）。"""
        configs = {}
        for server_id in self._mount_log:
            resolved = self._resolve_persisted_config(server_id)
            if resolved is not None:
                configs[server_id] = resolved
        await self._runtime.storage.put_record(
            _MOUNT_CONFIGS_COLLECTION, _MOUNT_CONFIGS_KEY, {"configs": configs}
        )

    def _resolve_persisted_config(self, server_id: str) -> dict | None:
        """按 server_id 反推可重连配置（npm/git stdio 或市场内条目）。

        不可反推（非 npm/git/http 形态）返回 None——不落库，重启后该
        server 以「注册在、连接离线」降级（卸载判定仍可用）。
        """
        if server_id.startswith("npm."):
            return self.resolve_address(f"npm:{server_id[4:]}").to_dict()
        if server_id.startswith("git."):
            return self.resolve_address(f"git:{server_id[4:]}").to_dict()
        if server_id.startswith("http://") or server_id.startswith("https://"):
            return self.resolve_address(server_id).to_dict()
        for market in self._markets.values():
            for server in market.get("servers") or ():
                if str(server.get("id") or "") == server_id:
                    return self._config_from_market_entry(server).to_dict()
        return None

    async def preview_market(self, link: str) -> dict[str, Any]:
        """市场摄入预览（vetting 静态核对 + 摘要；不落注册表）。"""
        try:
            catalog = _fetch_catalog(link)
        except McpMountError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:  # URL 拉取/文件解析失败
            return {"ok": False, "error": f"目录拉取失败: {exc}"}
        violations = _vet_catalog(catalog)
        if violations:
            return {"ok": False, "violations": violations}
        return {"ok": True, "preview": _preview_from_catalog(catalog, link)}

    async def add_market(
        self, link: str, *, name: str | None = None
    ) -> dict[str, Any]:
        """添加市场（外部目录摄入）：拉取 → vetting → 落注册表持久化。

        审批语义：连接页展示 vetting 通过的预览（名称/服务数/风险分布）
        并要求用户确认后才调用本方法——预览即审批卡，确认即授权。
        """
        catalog = _fetch_catalog(link)
        violations = _vet_catalog(catalog)
        if violations:
            raise McpMountError("；".join(violations))
        market = dict(catalog or {})
        market.setdefault("source", link)
        market.setdefault("name", name or market.get("name") or _market_name_from_link(link))
        ingested = self._ingest_market(market, builtin=False)
        mid = ingested["id"]
        if mid in self._markets:
            raise McpMountError(f"市场已存在: {mid}")
        self._markets[mid] = ingested
        self._rebuild_allowed_commands()
        await self._persist_markets()
        return self._market_summary(ingested)

    async def remove_market(self, market_id: str) -> dict[str, Any]:
        """删除市场：内置市场不可删；用户市场级联卸载其下已挂载服务。

        任一已挂载服务的卸载失败 = 整体拒绝删除（fail-closed）——已卸载
        的服务保持卸载态，市场保留，避免「市场没了、工具还挂着」的孤儿态。
        """
        market = self._markets.get(market_id)
        if market is None:
            raise McpMountError(f"市场不存在: {market_id}")
        if market.get("builtin"):
            raise McpMountError("内置市场不可删除")
        unmounted: list[dict[str, Any]] = []
        for server in market.get("servers") or ():
            sid = str(server.get("id") or "")
            if sid in self._mount_log:
                outcome = await self.unmount(_AutoAcceptCtx(), sid)
                if not outcome.ok:
                    raise McpMountError(
                        f"市场 {market_id} 级联卸载失败（已回退删除）: "
                        f"{sid} [{outcome.status}] {outcome.error or ''}"
                    )
                unmounted.append(
                    {"server_id": sid, "ok": True, "status": outcome.status}
                )
        del self._markets[market_id]
        self._rebuild_allowed_commands()
        await self._persist_markets()
        return {"unmounted": unmounted}

    def register_server_factory(self, server_id: str, factory: Any) -> None:
        """登记嵌入式 server 工厂（in_memory 传输的宿主注入点）。"""
        self._server_factories[server_id] = factory

    # ── 地址解析与配置推导 ──

    def _market_entry(self, server_id: str) -> dict[str, Any] | None:
        for market in self._markets.values():
            for server in market.get("servers") or ():
                if str(server.get("id")) == server_id:
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
        """地址解析：市场条目 / 市场名+条目 / http(s) url / npm / git → 配置。

        仅推导不执行：npx 命令只是提案形态，实际运行前必经
        vetting → 审批 → 补丁链（出厂零预挂，任何挂载都走既有链路）。

        市场条目解析跨全部市场按完整 id 匹配；``{market_id}:{entry_id}``
        限定在某市场内解析（多市场下防同名条目歧义）。
        """
        address = address.strip()
        if not address:
            raise McpMountError("挂载地址为空")
        entry = self._market_entry(address)
        if entry is not None:
            return self._config_from_market_entry(entry)
        if ":" in address:
            maybe_market, _, maybe_entry = address.partition(":")
            market = self._markets.get(maybe_market)
            if market is not None:
                for server in market.get("servers") or ():
                    sid = str(server.get("id") or "")
                    if sid in (maybe_entry, f"{maybe_market}.{maybe_entry}"):
                        return self._config_from_market_entry(server)
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
        require_approval: bool = True,
    ) -> MountOutcome:
        """对话式安装链路：地址解析 → 配置推导 → vetting → 审批 → 落链。

        require_approval=False = 手动挂载（连接页/市场页一键挂载）：
        跳过挂载审批卡，逐工具补丁经 ``_AutoAcceptCtx`` 自动放行
        （方案 B：用户点击即授权；工具使用期闸门照旧）。
        """
        try:
            config = self.resolve_address(address)
        except McpMountError as exc:
            return MountOutcome(
                ok=False, status="resolve_failed", error=str(exc)
            )
        return await self.mount_config(
            ctx,
            config,
            server_factory=server_factory,
            round_id=round_id,
            require_approval=require_approval,
        )

    async def mount_config(
        self,
        ctx: Any,
        config: McpServerConfig,
        *,
        server_factory: Any = None,
        round_id: str | None = None,
        require_approval: bool = True,
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

        require_approval=False（手动挂载）：跳过挂载审批卡，逐工具
        补丁经 ``_AutoAcceptCtx`` 恒放行——用户 UI 点击即授权。
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
        if require_approval:
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
        else:
            # 手动挂载：跳过挂载审批卡；逐工具补丁用合成上下文恒放行。
            ctx = _AutoAcceptCtx()
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
            # 双闸门（S-4 接线）：引擎 ToolVetting 并入挂载导入路径（逐
            # 工具清单 vet + 影子观察探针），与宿主侧 vetting 链叠加
            specs = await manager.import_tools(
                config.id, vetting=getattr(self._runtime, "vetting", None)
            )
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
        self._sync_introspection()
        with suppress(Exception):
            await self._persist_mount_configs()
        try:
            await self._runtime.rebuild_engine()
        except BaseException:
            # 引擎重建失败：不登记 _mount_log（卸载回退按它走链尾——
            # 登记了但链态异常会导致卸载找不到对应链尾），回滚已落补丁
            # 后原样上抛，调用方收到失败结果
            await self._rollback_patches(ctx, patch_ids, round_id=round_id)
            await manager.disconnect(config.id)
            raise
        self._mount_log[config.id] = list(patch_ids)
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

        注（E-P12 遗留）：本卡为挂载域专有形态（review_type="mount"，
        与 Rust domain/mcp.rs mount_approval_card 共享协议、Rust 侧断言
        钉死该字面量），未并入 review_card 四类卡统一构建源——统一需
        跨 Rust 修改，由 MCP 域批次跟进。
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
            # edit 决议可能改写传输/url/command：除静态核对外，http 传输
            # 改后的 url 必须重走 SSRF 防线（公网地址校验）——vetting_checks
            # 只核对清单一致性与命令白名单，不覆盖可达性/SSRF 防护
            if edited_config.transport is McpTransport.HTTP:
                try:
                    _assert_public_http_host(edited_config.url)
                except McpMountError:
                    return "vetting_rejected"
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
        # 回合外手动卸载（UI 触发，无 agent ctx）：合成上下文恒放行回退审批
        ctx = ctx or _AutoAcceptCtx()
        patch_ids = list(self._mount_log.get(server_id) or ())
        tail = await self._runtime.self_pipeline.chain.last_patch()
        if not patch_ids and (
            tail is None or not _patch_belongs_to_server(tail, server_id)
        ):
            return MountOutcome(
                ok=False, server_id=server_id,
                status="not_mounted", error="该 server 无挂载记录",
            )
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
        # 卸载清理 vetting 登记：重挂载须重新过 vetting（影子比对防
        # 复用旧工具集的放行状态）
        self._vetted_set.discard(server_id)
        with suppress(Exception):
            await self._persist_mount_configs()
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
            # 端点守卫：仅移除确为 MCP 端点且归属该 server 的工具
            # （meta.mcp_server 单独匹配会被污染的定义误删本地工具）
            if (
                definition.meta.get("mcp_server") == server_id
                and definition.endpoint is EndpointType.MCP
            ):
                removed.append(name)
                self._runtime.tool_registry.pop(name, None)
                self._runtime.harness_registry.declarative.unregister_definition(name)
        if removed:
            # 单源 + 标签：工具表移除后刷新检索索引（卸载即从检索面消失）
            self._runtime.refresh_tool_index()
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
