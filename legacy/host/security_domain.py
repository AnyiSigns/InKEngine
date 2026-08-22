"""工具安全纵深域装配（PLAN §6 M3-2 工具安全纵深）。

引擎零改动铁律下，工具安全纵深的宿主侧实现：

- **三档权限分级判定**：tools.json ``approval``（allow/review/deny）→
  :class:`TieredGate`——allow 直过 / review 弹卡审批 / deny 默认拒绝
  （deny 档无条件拒绝，与权限命中与否无关）；
- **声明式沙箱代理**：按调用时定义现取守卫——http_fetch 经定义
  ``network_policy.allow_domains`` 域名白名单、process_exec 经命令
  白名单、file_ops 经工作区根目录 + 授权门；非声明式工具（内省/
  自指/MCP 挂载）不误伤（守卫只对声明式端点生效）；
- **文件工具沙箱**：工作区授权（设置页「连接」授权确认卡形态）→
  根目录占位符替换 → 越界路径/符号链接逃逸/大小上限全部拒绝
  （fail-closed；路径边界由引擎 FileSandbox 解析，大小上限按工具
  声明在守卫期核对）；
- **网络策略**：定义 ``network_policy.allow_domains`` 在端点执行时
  核对（沙箱层先行判定，执行体二次核对，越域拒绝）；
- **vetting L2 影子运行**：挂载工具的清单一致性核对——影子记录 =
  导入期工具清单（不真执行），TOOL 补丁（MCP 端点类）落链前比对，
  不一致拒绝挂载；
- **shell 执行器进工具表**：OS 控制七件 + deny 档的 process_exec
  端点接线（执行器注册表插拔，stub 注入免真实桌面）。

安全判定与域装配模块化：新工具/新端点 = 注册新守卫/执行器，不动
机制代码。所有拒绝路径携带错误码（:data:`ErrorCode`）；trace_id 经
引擎 trace_id_var 自动透传（logger 结构化格式已含该字段）。
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from ink_engine.core.approval import DECISION_REJECT, DECISION_TERMINATE, approve_before_execute
from ink_engine.core.declarative_tools import (
    DeclarativeToolExecutors,
    DeclarativeToolSpec,
    EndpointType,
)
from ink_engine.core.exceptions import SandboxViolation
from ink_engine.core.logging import get_logger
from ink_engine.core.permissions import (
    DENY,
    REVIEW,
    GateResult,
    NetworkPolicySandbox,
    PermissionGate,
)
from ink_engine.core.review_card import GatingTier, gating_tier_of, validate_card
from ink_engine.core.sandbox import FileSandbox
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.tool_pipeline import ToolPipeline

logger = get_logger("host.security")

# ── 错误码（结构化可观测：拒绝路径统一携带，防魔法字符串）──

# 占位符语义：file_ops 工具根目录在装配期由授权替换（见 WorkspaceAuthorizer）
WORKSPACE_ROOT_PLACEHOLDER = "${workspace_root}"

# 大小上限缺省值（文件工具声明 sandbox_limits 缺项时的兜底，字节）
_DEFAULT_MAX_READ_BYTES = 1 << 20
_DEFAULT_MAX_WRITE_BYTES = 1 << 20


class ErrorCode:
    """安全拒绝/降级路径的结构化错误码（日志与结果文本共用）。"""

    PERMISSION_DENIED = "SEC_001"  # deny 档/权限未命中，默认拒绝
    SANDBOX_OUT_OF_ROOT = "SEC_002"  # 文件路径越出工作区根
    SANDBOX_SYMLINK_ESCAPE = "SEC_003"  # 符号链接逃逸出工作区根
    SANDBOX_SIZE_LIMIT = "SEC_004"  # 读/写超过大小上限
    SANDBOX_UNAUTHORIZED = "SEC_005"  # 工作区未授权
    NETWORK_DOMAIN_BLOCKED = "SEC_006"  # 目标域名不在白名单
    PROCESS_NOT_ALLOWLISTED = "SEC_007"  # 命令不在端点白名单
    VETTING_SHADOW_MISMATCH = "SEC_008"  # 影子清单比对不一致
    COMMAND_ENUM_MISMATCH = "SEC_009"  # 固定枚举参数与工具名不符
    CONTAINER_UNAVAILABLE = "ENV_004"  # Docker 客户端/守护进程不可用


def log_decision(
    *,
    tool: str,
    decision: str,
    operation: str,
    target: str,
    error_code: str | None = None,
    reason: str = "",
) -> None:
    """结构化记录一次权限/沙箱判定（trace_id 由引擎 logger 自动携带）。"""
    detail = f"tool={tool} op={operation} target={str(target)[:200]} -> {decision}"
    if error_code is not None:
        detail += f" code={error_code}"
    if reason:
        detail += f" reason={reason[:300]}"
    logger.info("security_decision %s", detail)


# ── 三档权限分级门禁 ──


class TieredGate:
    """tools.json approval 三档 → 引擎门禁的宿主接线。

    判定链：deny 档无条件拒绝 → 权限命中判定（按定义声明权限，调用方
    spec 权限不参与——与引擎 _DefinitionGate 同语义，封伪造宽松权限
    窗口）→ 命中且 review 档 = 弹卡审批 / allow 档 = 直过 / 未命中 =
    默认拒绝（fail-closed）。未在档位表的工具（挂载/补丁新增）= 按
    声明权限直过（与 M3-1 行为一致，档位表是出厂契约）。

    门控分级（引擎 review_card.GatingTier）共享机制接线：档位表
    allow/review → ``_gating_registry``（allow=l1 直落库 / review=l2
    弹卡），宿主设置经 ``gating_overrides`` 逐工具覆盖（白名单校验），
    未登记工具保持出厂直过语义。
    """

    def __init__(
        self,
        tiers: Mapping[str, str],
        *,
        executors: DeclarativeToolExecutors | None = None,
        default_policy: str = DENY,
        gating_overrides: Mapping[str, str] | None = None,
    ) -> None:
        self._tiers = dict(tiers)
        self._executors = executors
        self._gating_overrides = dict(gating_overrides or {})
        # allow 档 = l1（直落库，事后留痕）/ review 档 = l2（弹卡审批）
        self._gating_registry: dict[str, str] = {
            tool: (GatingTier.L2.value if tier == REVIEW else GatingTier.L1.value)
            for tool, tier in self._tiers.items()
            if tier in ("allow", "review") and tier != DENY
        }
        self._inner = PermissionGate(
            default_policy=default_policy,
            review_tier=lambda tool: self._review_needed(tool),
        )

    def _review_needed(self, tool: str) -> bool:
        """弹卡判定（引擎门控分级为判据；未登记工具保持出厂直过语义）。"""
        if tool not in self._tiers and tool not in self._gating_overrides:
            return False  # 出厂契约：挂载/补丁新增工具按声明权限直过
        tier = gating_tier_of(
            tool,
            overrides=self._gating_overrides,
            registry=self._gating_registry,
        )
        return tier is GatingTier.L2

    def check(
        self,
        tool: str,
        operation: str,
        target: str,
        *,
        permissions: tuple[str, ...] = (),
    ) -> GateResult:
        if self._tiers.get(tool) == DENY:
            return GateResult(
                DENY, tool, operation, target,
                "出厂 deny 档工具默认拒绝（权限变更须经补丁链审批转正）",
            )
        effective = permissions
        if self._executors is not None:
            definition = self._executors.definitions.get(tool)
            if definition is not None:
                effective = definition.permissions
                # 文件工具根目录占位符未解析（工作区未授权）：权限模式
                # 无法命中，给出明确拒绝原因（fail-closed + 可操作指引）
                if (
                    definition.endpoint is EndpointType.FILE_OPS
                    and WORKSPACE_ROOT_PLACEHOLDER
                    in str(definition.endpoint_config.get("root") or "")
                ):
                    return GateResult(
                        DENY, tool, operation, target,
                        "工作区未授权（请先在设置页「连接」完成工作区授权确认）",
                    )
        return self._inner.check(tool, operation, target, permissions=effective)


# ── 工作区授权门与文件沙箱守卫 ──


class WorkspaceGuard:
    """工作区授权门（文件工具沙箱的根目录权威来源）。

    未授权 = 占位符未解析 = 任何文件操作拒绝（fail-closed）；授权后
    根目录经 FileSandbox 解析（越界/符号链接逃逸拒绝），大小上限按
    调用时声明（sandbox_limits）在守卫期核对。
    """

    def __init__(self) -> None:
        self._root: Path | None = None
        self._authorized = False

    @property
    def authorized(self) -> bool:
        return self._authorized

    @property
    def root(self) -> Path | None:
        return self._root

    def authorize(self, root: Path) -> None:
        """授权根目录（幂等：重复授权同根 = 保持；换根 = 覆盖）。"""
        self._root = Path(root).resolve()
        self._authorized = True

    def revoke(self) -> None:
        """撤销授权（文件工具回到未授权拒绝态）。"""
        self._root = None
        self._authorized = False

    def validate_file(
        self, operation: str, target: str, *, max_bytes: int | None = None
    ) -> str:
        """文件操作守卫：授权门 + 根目录边界 + 符号链接逃逸 + 大小上限。

        Returns:
            解析后的绝对路径（执行参数回写，执行对象 = 校验对象）。
        """
        if not self._authorized or self._root is None:
            raise SandboxViolation(
                "工作区未授权（请先在设置页「连接」完成工作区授权确认）"
            )
        resolved = FileSandbox(root=self._root).validate(operation, target)
        if operation == "read" and max_bytes is not None:
            size = _file_size(resolved)
            if size > max_bytes:
                raise SandboxViolation(
                    f"文件大小超限: {size} > {max_bytes} 字节（{ErrorCode.SANDBOX_SIZE_LIMIT}）"
                )
        return str(resolved)


def _file_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _size_limit(definition: DeclarativeToolSpec, key: str, default: int) -> int:
    """工具声明的大小上限（sandbox_limits 数据驱动；缺项回落缺省值）。"""
    limits = (definition.meta or {}).get("sandbox_limits") or {}
    value = limits.get(key)
    return int(value) if isinstance(value, (int, float)) and value > 0 else default


# ── 声明式沙箱代理（按调用时定义现取守卫）──

# 当前调用工具名（SecurityToolPipeline.execute 注入；沙箱代理按名反查定义）
_current_spec: contextvars.ContextVar[str] = contextvars.ContextVar(
    "security_current_spec", default=""
)


class SecurityToolPipeline(ToolPipeline):
    """安全流水线：在引擎流水线之上透传调用工具名给沙箱代理。

    引擎 ToolPipeline 的沙箱环节只接收 ``(operation, target)``，无法
    区分调用方工具——代理按工具名反查声明式定义（守卫语义 = 定义即
    权威），本子类只做名字透传，机制环节（门禁/审计/编辑重校验/轨迹）
    全部沿用基类。
    """

    async def execute(self, ctx: Any, spec: Any, args: dict) -> Any:
        token = _current_spec.set(spec.name)
        try:
            return await super().execute(ctx, spec, args)
        finally:
            _current_spec.reset(token)


class DeclarativeSandboxProxy:
    """声明式工具沙箱守卫（网络/进程/文件三类端点按定义现取守卫）。

    守卫域（guards_operation）覆盖 exec / 文件操作 / connect；但只在
    调用工具确为声明式定义时才判定——内省/自指/MCP 挂载工具无本地
    沙箱语义（会话/装配边界），不误伤。
    """

    _FS_OPS = frozenset(("read", "write", "delete"))

    def __init__(
        self,
        executors: DeclarativeToolExecutors,
        *,
        workspace: WorkspaceGuard | None = None,
    ) -> None:
        self._executors = executors
        self._workspace = workspace or WorkspaceGuard()

    def guards_operation(self, operation: str) -> bool:
        return operation in ("exec",) or operation in self._FS_OPS or operation == "connect"

    def validate(self, operation: str, target: str) -> str | None:
        name = _current_spec.get()
        definition = self._executors.definitions.get(name)
        if definition is None:
            return target  # 非声明式工具（内省/自指/挂载）无本地沙箱语义
        if definition.endpoint is EndpointType.PROCESS_EXEC and operation == "exec":
            # 端点级守卫 = 命令白名单成员判定（声明式工具的执行体是宿主
            # 分发而非子进程 spawn，PATH 语义归实际执行通道——LocalProvider/
            # Builder 的 ProcessSandbox 各自注入 PATH）
            allowlist = tuple(definition.endpoint_config.get("allowlist") or ())
            if target not in allowlist:
                raise SandboxViolation(
                    f"命令不在端点白名单: {target!r}（{ErrorCode.PROCESS_NOT_ALLOWLISTED}）"
                )
            return target
        if definition.endpoint is EndpointType.FILE_OPS and operation in self._FS_OPS:
            max_bytes = (
                _size_limit(definition, "max_read_bytes", _DEFAULT_MAX_READ_BYTES)
                if operation == "read"
                else _size_limit(definition, "max_write_bytes", _DEFAULT_MAX_WRITE_BYTES)
            )
            return self._workspace.validate_file(operation, target, max_bytes=max_bytes)
        if definition.endpoint is EndpointType.HTTP_FETCH and operation == "connect":
            policy = (definition.meta or {}).get("network_policy") or {}
            allow_domains = frozenset(policy.get("allow_domains") or ())
            NetworkPolicySandbox(allow_domains=allow_domains).validate(operation, target)
            return target
        return target  # mcp 端点：会话级边界（挂载 vetting + 审批链）


# ── 工作区授权器（设置页授权确认卡形态）──


class WorkspaceAuthorizer:
    """工作区授权（持久化 + 审批卡 + 根目录替换生效）。

    授权流程：审批卡确认（review 档语义）→ 记录落 storage（重启可
    恢复）→ 文件工具重注册（根目录占位符替换为实际挂载点 + 权限
    模式同步替换）→ 引擎重建（下一回合生效）。撤销 = 反流程（回到
    占位符拒绝态）。
    """

    AUTH_COLLECTION = "workspace_auth"
    _AUTH_KEY = "authorized_root"

    def __init__(
        self,
        storage: Any,
        *,
        security: SecurityDomain,
        runtime: Any,
    ) -> None:
        self._storage = storage
        self._security = security
        self._runtime = runtime

    async def load(self) -> None:
        """从 storage 恢复授权态（重启后文件工具立即回到生效根）。"""
        record = await self._storage.get_record(self.AUTH_COLLECTION, self._AUTH_KEY)
        if isinstance(record, dict) and isinstance(record.get("root"), str):
            root = Path(record["root"])
            if root.is_dir():
                self._security.workspace.authorize(root)
                self._security.reregister_file_tools(root=root)
                await self._runtime.rebuild_engine()

    async def authorized_root(self) -> Path | None:
        record = await self._storage.get_record(self.AUTH_COLLECTION, self._AUTH_KEY)
        if isinstance(record, dict) and isinstance(record.get("root"), str):
            return Path(record["root"])
        return None

    async def authorize(self, ctx: Any, root: Path, *, reason: str = "") -> dict[str, Any]:
        """授权确认卡 → 持久化 → 文件工具生效（结构化结果，失败不半挂）。"""
        root = Path(root).resolve()
        approval = await approve_before_execute(
            ctx,
            "workspace:authorize",
            {"tool": "workspace_authorize", "root": str(root), "reason": reason},
            payload=validate_card(
                {
                    "review_type": "gate",
                    "node_id": "workspace_authorize",
                    "node_label": "工作区授权确认",
                    "output_preview": f"授权工作区 {root}（文件工具将可读/写/编辑该目录）",
                }
            ),
        )
        if approval.decision in (DECISION_REJECT, DECISION_TERMINATE):
            return {
                "ok": False,
                "decision": approval.decision,
                "reason": approval.reason or "授权未通过",
            }
        await self._storage.put_record(
            self.AUTH_COLLECTION,
            self._AUTH_KEY,
            {
                "root": str(root),
                "granted_at": time.time(),
                "reason": reason,
                "decision": approval.decision,
            },
        )
        self._security.workspace.authorize(root)
        self._security.reregister_file_tools(root=root)
        await self._runtime.rebuild_engine()
        return {"ok": True, "root": str(root), "decision": approval.decision}

    async def revoke(self, ctx: Any, *, reason: str = "") -> dict[str, Any]:
        """撤销授权（审批卡确认后回到未授权拒绝态）。"""
        approval = await approve_before_execute(
            ctx,
            "workspace:revoke",
            {"tool": "workspace_revoke", "reason": reason},
            payload=validate_card(
                {
                    "review_type": "gate",
                    "node_id": "workspace_revoke",
                    "node_label": "工作区撤销确认",
                    "output_preview": f"撤销工作区授权（{reason or '未说明原因'}）",
                }
            ),
        )
        if approval.decision in (DECISION_REJECT, DECISION_TERMINATE):
            return {
                "ok": False,
                "decision": approval.decision,
                "reason": approval.reason or "撤销未通过",
            }
        # 撤销 = 墓碑记录（root 置空；Storage 协议无删除原语，空 root 即
        # 未授权态，load/authorized_root 按空值回落）
        await self._storage.put_record(
            self.AUTH_COLLECTION,
            self._AUTH_KEY,
            {
                "root": "",
                "revoked": True,
                "revoked_at": time.time(),
                "reason": reason,
                "decision": approval.decision,
            },
        )
        self._security.workspace.revoke()
        self._security.reregister_file_tools(root=None)
        await self._runtime.rebuild_engine()
        return {"ok": True, "decision": approval.decision}


# ── OS 控制执行器注册表 ──


class OsControlRegistry:
    """OS 控制执行器注册表（process_exec 端点的宿主注入点）。

    工具声明 = 数据（tools.json），执行实现 = 宿主/桌面壳注册（插拔
    U 盘）：未注册命令 = 明确降级失败文本（不崩溃、不静默假装可用）。
    stub 注入供 e2e 免真实桌面闭环。
    """

    def __init__(self) -> None:
        self._impls: dict[str, Callable[..., Any]] = {}

    def register(self, command: str, impl: Callable[..., Any]) -> None:
        self._impls[command] = impl

    async def dispatch(self, command: str, ctx: Any, definition: Any, args: dict) -> str:
        impl = self._impls.get(command)
        if impl is None:
            return json.dumps(
                {
                    "ok": False,
                    "status": "executor_not_registered",
                    "error": f"OS 控制执行器未注册: {command}（桌面壳未挂载）",
                },
                ensure_ascii=False,
            )
        result = impl(ctx, definition, args)
        if asyncio.iscoroutine(result):
            result = await result
        return str(result)


def make_http_fetch_executor(
    *,
    fetch: Callable[..., Any] | None = None,
    max_chars: int = 100_000,
) -> Callable[..., Any]:
    """http_fetch 端点执行体（网络策略二次核对 + 可选取回实现）。

    执行体不自行决定出网：域名白名单在沙箱层先行判定，执行体按定义
    声明（meta.network_policy）再次核对（纵深防御），越域 = 结构化
    失败（NETWORK_DOMAIN_BLOCKED）。取回实现可注入（e2e 用 stub 免
    真实出网；缺省 = httpx，可选依赖缺失时明确报错）。
    """

    async def execute(ctx: Any, definition: Any, args: dict, approval: Any) -> str:
        import urllib.parse

        policy = (definition.meta or {}).get("network_policy") or {}
        allow_domains = frozenset(policy.get("allow_domains") or ())
        url = str(args.get("url") or "")
        try:
            host = urllib.parse.urlsplit(url).hostname
        except ValueError:
            host = None
        if not host or not _allowed_hosts(allow_domains, host):
            return json.dumps(
                {
                    "ok": False,
                    "status": "network_domain_blocked",
                    "error": f"域名不在网络策略白名单: {host!r}（越域拒绝）",
                },
                ensure_ascii=False,
            )
        if fetch is not None:
            text = fetch(definition, args)
            if asyncio.iscoroutine(text):
                text = await text
            return str(text)[:max_chars]
        try:
            import httpx
        except ImportError as exc:
            raise RuntimeError(
                "http_fetch 执行体依赖 httpx（pip install ink-engine[llm]），未安装"
            ) from exc
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
            response = await client.get(url)
        body = response.text[:max_chars]
        return f"HTTP {response.status_code}\n{body}"

    return execute


def _allowed_hosts(allow_domains: frozenset[str], host: str) -> bool:
    """白名单后缀匹配（与引擎 NetworkPolicy.network_matches 同语义）。"""
    from ink_engine.core.permissions import network_matches

    return any(network_matches(p, host) for p in allow_domains)


# ── 文件开发执行体（file_ops 端点）──


class FileOpsExecutor:
    """file_ops 端点执行体（工作区读/写/编辑，写前快照可回退）。

    执行体不做路径边界判定（沙箱层已先行解析，执行参数 = 校验后的
    绝对路径）；本层核对大小上限（声明 sandbox_limits，纵深防御）并
    实现写前快照（file_write/file_edit 写前记录原内容，可回退）。未
    注册工作区/文件缺失 = 结构化失败文本（不崩溃）。
    """

    def __init__(self) -> None:
        # 写前快照（绝对路径 → 原内容字节；写/编辑前记录，回退取用）
        self._snapshots: dict[str, bytes] = {}

    def rollback(self, path: Path) -> bool:
        """回退一次写操作（快照存在 = 还原原内容；缺失 = False）。"""
        snapshot = self._snapshots.pop(str(path), None)
        if snapshot is None:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(snapshot)
        return True

    async def __call__(self, ctx: Any, definition: Any, args: dict, approval: Any) -> str:
        operation = str(args.get("operation") or "")
        path_text = str(args.get("path") or "")
        max_write = _size_limit(definition, "max_write_bytes", _DEFAULT_MAX_WRITE_BYTES)
        try:
            if operation == "read":
                return self._read(path_text, definition)
            if operation == "write":
                if "old_text" in args:
                    return self._edit(
                        path_text,
                        str(args.get("old_text") or ""),
                        str(args.get("new_text") or ""),
                        max_write,
                    )
                content = str(args.get("content") or "")
                if len(content.encode("utf-8")) > max_write:
                    return json.dumps(
                        {
                            "ok": False,
                            "status": "size_limit",
                            "error": f"写入超限: {len(content.encode('utf-8'))} > {max_write} 字节"
                            f"（{ErrorCode.SANDBOX_SIZE_LIMIT}）",
                        },
                        ensure_ascii=False,
                    )
                return self._write(path_text, content)
        except FileNotFoundError as exc:
            return json.dumps(
                {"ok": False, "status": "not_found", "error": str(exc)},
                ensure_ascii=False,
            )
        except IsADirectoryError as exc:
            return json.dumps(
                {"ok": False, "status": "is_directory", "error": str(exc)},
                ensure_ascii=False,
            )
        return json.dumps(
            {
                "ok": False,
                "status": "invalid_operation",
                "error": f"不支持的文件操作: {operation!r}",
            },
            ensure_ascii=False,
        )

    def _edit(self, path_text: str, old_text: str, new_text: str, max_write: int) -> str:
        """精准编辑（替换段落）：原文须存在、替换后大小不超限、写前快照。"""
        path = Path(path_text)
        original = path.read_text(encoding="utf-8")
        if not old_text or old_text not in original:
            return json.dumps(
                {
                    "ok": False,
                    "status": "old_text_not_found",
                    "error": "待替换原文不存在（编辑目标未命中）",
                },
                ensure_ascii=False,
            )
        updated = original.replace(old_text, new_text, 1)
        if len(updated.encode("utf-8")) > max_write:
            return json.dumps(
                {
                    "ok": False,
                    "status": "size_limit",
                    "error": f"编辑结果超限: {len(updated.encode('utf-8'))} > {max_write} 字节"
                    f"（{ErrorCode.SANDBOX_SIZE_LIMIT}）",
                },
                ensure_ascii=False,
            )
        self._snapshots[str(path)] = original.encode("utf-8")
        path.write_text(updated, encoding="utf-8")
        return json.dumps(
            {
                "ok": True,
                "path": str(path),
                "bytes": len(updated.encode("utf-8")),
                "snapshot": True,
            },
            ensure_ascii=False,
        )

    def _read(self, path_text: str, definition: Any) -> str:
        path = Path(path_text)
        max_read = _size_limit(definition, "max_read_bytes", _DEFAULT_MAX_READ_BYTES)
        size = path.stat().st_size
        if size > max_read:
            return json.dumps(
                {
                    "ok": False,
                    "status": "size_limit",
                    "error": f"文件超限: {size} > {max_read} 字节（{ErrorCode.SANDBOX_SIZE_LIMIT}）",
                },
                ensure_ascii=False,
            )
        content = path.read_text(encoding="utf-8")
        return json.dumps(
            {"ok": True, "path": str(path), "bytes": size, "content": content},
            ensure_ascii=False,
        )

    def _write(self, path_text: str, content: str) -> str:
        path = Path(path_text)
        if path.is_file():
            self._snapshots[str(path)] = path.read_bytes()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return json.dumps(
            {
                "ok": True,
                "path": str(path),
                "bytes": len(content.encode("utf-8")),
                "snapshot": str(path) in self._snapshots,
            },
            ensure_ascii=False,
        )


def make_file_ops_executor() -> FileOpsExecutor:
    """file_ops 端点执行体工厂（宿主注册；同一实例持有快照表）。"""
    return FileOpsExecutor()


def make_process_exec_executor(
    mount_service: Any,
    os_registry: OsControlRegistry,
    *,
    tiers: Mapping[str, str],
) -> Callable[..., Any]:
    """process_exec 端点执行体（宿主注册进声明式执行体表）。

    分发规则：propose_mcp_mount → 挂载服务；deny 档（shell_exec）→
    守卫拒绝（纵深防御，门禁已拒，执行体再拒一次）；其余 → OS 控制
    注册表分发。command 固定枚举与工具名不符 = 明确拒绝
    （COMMAND_ENUM_MISMATCH 语义，与端点操作判定同源）。
    """

    async def execute(ctx: Any, definition: Any, args: dict[str, Any], approval: Any) -> str:
        name = definition.name
        if name == "propose_mcp_mount":
            address = str(args.get("address") or "").strip()
            if not address:
                return json.dumps(
                    {"ok": False, "status": "resolve_failed", "error": "挂载地址为空"},
                    ensure_ascii=False,
                )
            outcome = await mount_service.propose_mount(ctx, address)
            return json.dumps(
                {
                    "ok": outcome.ok,
                    "status": outcome.status,
                    "server_id": outcome.server_id,
                    "tools": list(outcome.tool_names),
                    "error": outcome.error,
                },
                ensure_ascii=False,
            )
        command = str(args.get("command") or "")
        if command != name:
            return json.dumps(
                {
                    "ok": False,
                    "status": "command_enum_mismatch",
                    "error": f"command 固定枚举不符: {command!r}（期望 {name!r}）",
                },
                ensure_ascii=False,
            )
        if tiers.get(name) == DENY:
            return json.dumps(
                {
                    "ok": False,
                    "status": "deny_tier",
                    "error": "出厂 deny 档工具默认拒绝（须经补丁链审批转正）",
                },
                ensure_ascii=False,
            )
        return await os_registry.dispatch(command, ctx, definition, args)

    return execute


# ── 影子 vetting（挂载工具清单一致性核对，不真执行）──


class ShadowVettingStore:
    """挂载影子记录（导入期工具清单；L2 钩子的比对依据）。

    影子 = 连接 server 后 tools/list 的清单快照（不执行任何工具调用）；
    TOOL 补丁落链前把声明的工具名/参数必填项与影子清单比对，不一致 =
    挂载拒绝（防改头换面/声明与实现漂移）。
    """

    def __init__(self) -> None:
        self._records: dict[str, dict[str, dict[str, Any]]] = {}

    def record(self, server_id: str, specs: Sequence[Any]) -> None:
        """记录一个 server 的影子清单（工具名 → 参数 schema 摘要）。"""
        record: dict[str, dict[str, Any]] = {}
        for spec in specs:
            name = getattr(spec, "name", None)
            if not isinstance(name, str):
                continue
            params = getattr(spec, "parameters", None) or {}
            record[name] = {
                "parameters": dict(params) if isinstance(params, dict) else {}
            }
        self._records[server_id] = record

    def server_tools(self, server_id: str) -> tuple[str, ...]:
        return tuple(self._records.get(server_id) or ())

    def check_tool(
        self, server_id: str, name: str, declared: dict | None = None
    ) -> list[str]:
        """声明工具 vs 影子清单（输出比对）：违规清单，空 = 一致。"""
        record = self._records.get(server_id)
        if record is None:
            return ["server 无影子记录（导入期工具清单缺失，无法核对）"]
        actual = record.get(name)
        if actual is None:
            return [f"工具 {name!r} 不在影子清单（server 实际未暴露该工具）"]
        if isinstance(declared, dict):
            declared_required = declared.get("required") or ()
            actual_props = (actual.get("parameters") or {}).get("properties") or {}
            missing = [r for r in declared_required if r not in actual_props]
            if missing:
                return [f"参数必填项与影子清单不符: {missing}"]
        return []


def build_security_l2_vetting_hook(
    shadow: ShadowVettingStore,
    *,
    inner: Callable[[Any], list[str]] | None = None,
) -> tuple[Callable[[Any], list[str]], Callable[..., None]]:
    """L2 验证钩子（TOOL 补丁部署前门禁）+ 影子登记器。

    钩子语义（fail-closed）：MCP 端点工具补丁须满足——server 已通过
    挂载 vetting（登记放行）且声明与影子清单一致；未登记/不一致 =
    拒绝落链。非 MCP 工具补丁交给 inner（缺省放行，交由审批分级）。
    登记器由挂载服务在 vetting 通过后调用（vetting → 审批 → L2 的
    顺序在机制上被强制执行）。
    """
    vetted: set[str] = set()

    def mark_vetted(server_id: str, specs: Sequence[Any] | None = None) -> None:
        vetted.add(server_id)
        if specs:
            shadow.record(server_id, specs)

    def hook(proposal: Any) -> list[str]:
        if getattr(proposal, "kind", None) is not PatchKind.TOOL:
            return [] if inner is None else inner(proposal)
        payload = proposal.payload or {}
        if payload.get("endpoint") != "mcp":
            return [] if inner is None else inner(proposal)
        server_id = (payload.get("endpoint_config") or {}).get("server_id")
        if not isinstance(server_id, str) or server_id not in vetted:
            return [
                f"MCP 挂载未经 vetting 核对（server 未登记放行: {server_id!r}）"
            ]
        violations = shadow.check_tool(
            server_id, str(payload.get("name") or ""), payload.get("parameters")
        )
        if violations:
            return [f"影子运行核对未通过: {'；'.join(violations)}"]
        return []

    return hook, mark_vetted


# ── 域装配门面 ──


class SecurityDomain:
    """工具安全纵深装配（boot 期创建，挂到宿主对象供运行期取用）。

    持有：三档门禁 + 沙箱代理 + 工作区门 + 影子存储 + OS 执行器注册表
    + 文件工具定义数据源。apply() 把安全流水线替换进 runtime（引擎
    装配点不动，只换宿主侧流水线实例——图配方每次建图实时取流水线
    持有者，替换后下一回合生效）。
    """

    def __init__(self, tool_data: dict[str, Any]) -> None:
        self._tiers: dict[str, str] = {
            str(tool["name"]): str(tool["approval"])
            for tool in (tool_data.get("tools") or ())
        }
        self.tiers = dict(self._tiers)
        self.workspace = WorkspaceGuard()
        self.shadow = ShadowVettingStore()
        self.os_registry = OsControlRegistry()
        # 文件开发工具定义（tools.json file_ops 工具，授权重注册的数据源）
        self.file_tool_defs = [
            DeclarativeToolSpec.from_dict(tool)
            for tool in (tool_data.get("tools") or ())
            if tool.get("endpoint") == "file_ops"
        ]
        self._runtime: Any | None = None
        self._executors: DeclarativeToolExecutors | None = None

    @property
    def executors(self) -> DeclarativeToolExecutors | None:
        return self._executors

    def apply(self, runtime: Any) -> None:
        """把安全流水线替换进运行时（gate + 沙箱代理；机制环节沿用引擎）。

        声明式执行体注册表在 runtime.boot 后才存在（boot 内部装配
        统一工具表），故门禁/沙箱在 apply 时按实时注册表构造——之后
        挂载的新工具同样被代理现取守卫（懒解析接线）。
        """
        self._runtime = runtime
        executors = runtime.harness_registry.declarative
        self._executors = executors
        self.gate = TieredGate(self._tiers, executors=executors)
        self.sandbox = DeclarativeSandboxProxy(executors, workspace=self.workspace)
        old = runtime.tool_pipeline
        runtime.tool_pipeline = SecurityToolPipeline(
            gate=self.gate,
            extractor=old.extractor,
            executor=old.executor,
            sandboxes=(self.sandbox,),
            guards=old.guards,
            audit=old.audit,
            max_result_chars=old.max_result_chars,
            allow_unchecked=old.allow_unchecked,
            trace_sink=old.trace_sink,
        )

    def reregister_file_tools(self, root: Path | None) -> None:
        """文件工具重注册（授权根替换占位符；撤销 = 回到占位符拒绝态）。

        注册表同名覆盖（宿主按配置装配语义）：定义与工具表同步更新，
        权限模式随根目录替换（``${workspace_root}/**`` → 实际根），
        未授权 = 占位符保留（沙箱守卫在调用时拒绝）。
        """
        if self._runtime is None:
            return
        resolved_root = str(root) if root is not None else WORKSPACE_ROOT_PLACEHOLDER
        for spec in self.file_tool_defs:
            permissions = tuple(
                _substitute_root(p, resolved_root) for p in spec.permissions
            )
            config = dict(spec.endpoint_config)
            if spec.endpoint is EndpointType.FILE_OPS:
                config["root"] = resolved_root
            rebuilt = DeclarativeToolSpec(
                name=spec.name,
                description=spec.description,
                parameters=spec.parameters,
                permissions=permissions,
                endpoint=spec.endpoint,
                endpoint_config=config,
                meta=spec.meta,
            )
            self._executors.register_definition(rebuilt)
            self._runtime.tool_registry[spec.name] = rebuilt.to_spec()
        self._runtime.introspection_service._sources.tools = (
            self._runtime.collect_specs()
        )


def _substitute_root(pattern: str, root: str) -> str:
    """权限模式占位符替换（路径统一正斜杠，与 rule_matches 归一一致）。"""
    return pattern.replace(WORKSPACE_ROOT_PLACEHOLDER, root.replace("\\", "/"))


__all__ = [
    "WORKSPACE_ROOT_PLACEHOLDER",
    "DeclarativeSandboxProxy",
    "ErrorCode",
    "FileOpsExecutor",
    "OsControlRegistry",
    "SecurityDomain",
    "SecurityToolPipeline",
    "ShadowVettingStore",
    "TieredGate",
    "WorkspaceAuthorizer",
    "WorkspaceGuard",
    "build_security_l2_vetting_hook",
    "log_decision",
    "make_file_ops_executor",
    "make_http_fetch_executor",
    "make_process_exec_executor",
]
