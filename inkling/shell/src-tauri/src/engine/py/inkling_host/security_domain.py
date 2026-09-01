"""工具安全纵深域装配（设计文档第六节模块 M3-2 工具安全纵深）。

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
- **网络策略**：http_fetch 出网经审批网关裁决（出厂 review 档弹卡），
  定义 ``network_policy.allow_domains`` 是装配提示（免审批快速路径）
  而非执行期网关——执行体不做域名二次硬拦（与 Rust 侧同口径）；
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
import fnmatch
import json
import os
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from ink_engine.core.approval import (
    DECISION_ACCEPT,
    DECISION_AUTO,
    DECISION_REJECT,
    DECISION_TERMINATE,
    approve_before_execute,
)
from ink_engine.core.declarative_tools import (
    DeclarativeToolExecutors,
    DeclarativeToolSpec,
    EndpointType,
    coerce_argv,
)
from ink_engine.core.exceptions import SandboxViolation
from ink_engine.core.logging import get_logger
from ink_engine.core.permissions import (
    ALLOW,
    DENY,
    REVIEW,
    GateResult,
    PermissionGate,
)
from ink_engine.core.review_card import GatingTier, gating_tier_of
from ink_engine.core.sandbox import FileSandbox
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.tool_pipeline import ToolPipeline

logger = get_logger("host.security")

# ── 错误码（结构化可观测：拒绝路径统一携带，防魔法字符串）──
# 对偶来源（S12）：错误码值域与 Rust 侧 domain/security.rs ErrorCode
# 同源（SEC_001-SEC_009 一一对应；Rust 另含 http_fetch 的 SEC_010/
# SEC_011——两端以 tools.json 声明与安全语义收敛，6c 批收敛校验）

# 占位符语义：file_ops 工具根目录在装配期由授权替换（见 WorkspaceAuthorizer）
# 对偶来源（S12）：常量值与 Rust 侧 domain/common.rs WORKSPACE_ROOT_PLACEHOLDER
# 同源（授权替换/越界拒绝两端同口径，6c 批收敛校验）
WORKSPACE_ROOT_PLACEHOLDER = "${workspace_root}"

# 大小上限缺省值（文件工具声明 sandbox_limits 缺项时的兜底，字节）
_DEFAULT_MAX_READ_BYTES = 1 << 20
_DEFAULT_MAX_WRITE_BYTES = 1 << 20


class ErrorCode:
    """安全拒绝/降级路径的结构化错误码（日志与结果文本共用）。

    对偶来源（S12）：值域与 Rust 侧 domain/security.rs ErrorCode 同源，
    SEC_001-SEC_009 一一对应（Rust 侧额外持有 http_fetch 重定向/大小
    上限的 SEC_010/SEC_011）；两端收敛由 6c 批校验，本侧不新增私有码。
    """

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
        auto_approvable: frozenset[str] = frozenset(),
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
        # 自动审批（用户预授权）：可登记集 = 声明标记 auto_approvable 的
        # 只读感知/测试构建类工具（登记边界在设置持久化层硬拒）；
        # 命中只跳过人审弹卡，deny/沙箱/审计环节不动。
        self._auto_approvable = frozenset(auto_approvable)
        self._auto_approve_tools: frozenset[str] = frozenset()
        self._auto_approve_all_review = False
        # 逐工具档位覆盖（权限矩阵写面：allow/review/deny；deny 出厂档
        # 不可覆盖）。运行期生效经 ``_gating_overrides``（l1/l2）下发。
        self._tier_overrides: dict[str, str] = {}

    def _review_needed(self, tool: str) -> bool:
        """弹卡判定（引擎门控分级为判据；未登记工具保持出厂直过语义）。"""
        if tool not in self._tiers and tool not in self._gating_overrides:
            return False  # 出厂契约：挂载/补丁新增工具按声明权限直过
        tier = gating_tier_of(
            tool,
            overrides=self._gating_overrides,
            registry=self._gating_registry,
        )
        if tier is not GatingTier.L2:
            return False
        return not self.auto_approved(tool)

    # ── 自动审批（用户预授权，仅跳过人审弹卡）──

    def configure_auto_approve(
        self, tools: Sequence[str], all_review: bool
    ) -> None:
        """按登记边界配置自动审批集（边界外工具硬拒，不静默过滤）。

        可登记集 = 声明标记 auto_approvable 的工具；请求含边界外
        工具 = 整体拒绝（持久化层在设置保存前已过滤，此处为纵深
        防御的二次校验——漏过的请求在这里必须失败）。
        """
        requested = frozenset(str(tool) for tool in tools if str(tool).strip())
        outside = sorted(requested - self._auto_approvable)
        if outside:
            raise ValueError(
                "自动审批登记边界外工具: "
                + ", ".join(outside)
                + "（仅只读感知/测试构建类可登记，OS 控制与文件写类不可）"
            )
        self._auto_approve_tools = requested
        self._auto_approve_all_review = bool(all_review)

    def auto_approved(self, tool: str) -> bool:
        """自动审批命中判定（边界外工具恒不命中，纵深防御）。"""
        if tool not in self._auto_approvable:
            return False
        return self._auto_approve_all_review or tool in self._auto_approve_tools

    def auto_approve_snapshot(self) -> tuple[list[str], bool]:
        """当前自动审批集快照（设置页装载形态）。"""
        return sorted(self._auto_approve_tools), self._auto_approve_all_review

    def auto_approvable_tools(self) -> list[str]:
        """可登记清单（设置页勾选项的单一来源）。"""
        return sorted(self._auto_approvable)

    # ── 逐工具档位覆盖（权限矩阵写面：allow/review/deny）──

    def set_tier_override(self, tool: str, tier: str) -> None:
        """设置单工具档位覆盖（allow→l1 直过 / review→l2 弹卡）。

        约束：工具须在出厂档位表（挂载/补丁新增工具按声明权限直过，
        无需覆盖）；deny 出厂档默认拒绝，权限变更须经补丁链审批转正，
        不提供档位覆盖；档位覆盖等于出厂档 = 撤销覆盖。
        """
        if tool not in self._tiers:
            raise ValueError(
                f"工具不在出厂档位表: {tool}（挂载/补丁工具按声明权限直过，无需覆盖）"
            )
        if tier not in (ALLOW, REVIEW, DENY):
            raise ValueError(f"非法档位: {tier}（仅 allow/review/deny）")
        if self._tiers[tool] == DENY:
            raise ValueError(
                "出厂 deny 档工具默认拒绝（权限变更须经补丁链审批转正，不提供档位覆盖）"
            )
        if tier == self._tiers[tool]:
            self._tier_overrides.pop(tool, None)
            self._gating_overrides.pop(tool, None)
            return
        self._tier_overrides[tool] = tier
        self._gating_overrides[tool] = (
            GatingTier.L1.value if tier == ALLOW else GatingTier.L2.value
        )

    def set_tier_overrides(self, overrides: Mapping[str, str]) -> None:
        """批量档位覆盖（逐工具校验；任一非法 = 整体拒绝不落盘）。"""
        for tool, tier in overrides.items():
            self.set_tier_override(str(tool), str(tier))

    def tier_overrides(self) -> dict[str, str]:
        """当前档位覆盖（能力记录持久化形态：工具名 → allow/review/deny）。"""
        return dict(self._tier_overrides)

    def effective_tier(self, tool: str) -> str:
        """当前生效档位（覆盖优先于出厂档位表；未登记工具 = review 保守档）。"""
        return self._tier_overrides.get(tool, self._tiers.get(tool, REVIEW))

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
                # 混合 shell（声明 meta.escalation）：白名单外命令不再
                # fail-closed 拒绝，升级为审批弹卡（L2 升级卡）——审批
                # 通过后一次性系统级放行；审批卡为唯一防线（无二次白名单）。
                if (
                    (definition.meta or {}).get("escalation") is True
                    and definition.endpoint is EndpointType.PROCESS_EXEC
                    and operation == "exec"
                ):
                    allowlist = tuple(
                        definition.endpoint_config.get("allowlist") or ()
                    )
                    if target not in allowlist:
                        return GateResult(
                            REVIEW, tool, operation, target,
                            "命令不在白名单，升级系统级审批（审批通过后一次性放行）",
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
        # fail-closed：无法 stat 的文件不当作 0 字节放行（大小上限会
        # 被绕过）；返回超限值触发拒绝，让沙箱给出明确错误
        raise SandboxViolation(f"无法获取文件大小: {path}")


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

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # 自动审批判定面（门禁同实例注入；缺省 = 无标记）
        self._auto_gate = getattr(kwargs.get("gate"), "auto_approved", None)

    async def execute(self, ctx: Any, spec: Any, args: dict) -> Any:
        token = _current_spec.set(spec.name)
        try:
            return await super().execute(ctx, spec, args)
        finally:
            _current_spec.reset(token)

    async def _audit(self, ctx: Any, record: dict) -> None:
        # 自动审批命中留痕：成功审计记录标 auto_approved_by_user
        # （审计可回溯——跳过的只是人审弹卡，留痕不跳过）
        tool = str(record.get("tool") or "")
        if (
            tool
            and record.get("decision") == "ok"
            and self._auto_gate is not None
            and self._auto_gate(tool)
        ):
            record = dict(record)
            record["auto_approved_by_user"] = True
        return await super()._audit(ctx, record)


class DeclarativeSandboxProxy:
    """声明式工具沙箱守卫（网络/进程/文件三类端点按定义现取守卫）。

    守卫域（guards_operation）覆盖 exec / 文件操作 / connect；但只在
    调用工具确为声明式定义时才判定——内省/自指/MCP 挂载工具无本地
    沙箱语义（会话/装配边界），不误伤。
    """

    _FS_OPS = frozenset(("read", "write", "edit", "delete", "search", "search_paths"))

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
                if (definition.meta or {}).get("escalation") is True:
                    # 混合 shell：白名单外命令放行到审批闸（门禁已升级
                    # REVIEW 弹卡，审批通过才执行——审批即网关，此处
                    # 不再二次硬拦；命令是否放行由审批卡裁决）
                    return target
                raise SandboxViolation(
                    f"命令不在端点白名单: {target!r}（{ErrorCode.PROCESS_NOT_ALLOWLISTED}）"
                )
            return target
        if definition.endpoint is EndpointType.FILE_OPS and operation in self._FS_OPS:
            if operation == "read":
                max_bytes = _size_limit(
                    definition, "max_read_bytes", _DEFAULT_MAX_READ_BYTES
                )
            elif operation == "write":
                max_bytes = _size_limit(
                    definition, "max_write_bytes", _DEFAULT_MAX_WRITE_BYTES
                )
            else:
                # 检索操作只读不取整文件：仅解析边界，不做单文件大小上限
                max_bytes = None
            return self._workspace.validate_file(operation, target, max_bytes=max_bytes)
        if definition.endpoint is EndpointType.HTTP_FETCH and operation == "connect":
            # 联网出网经审批网关裁决（http_fetch 出厂 review 档弹卡 +
            # 记住域名直过），沙箱层不再按 allow_domains 二次硬拦——
            # 定义级 allow_domains 是装配提示而非执行期网关（审批即网关）。
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
        """授权确认卡 → 持久化 → 文件工具生效（结构化结果，失败不半挂）。

        gate 卡形态经 approval 统一构建（review_card.build_gate_card——
        E-P12 唯一卡形态源）；此处只提供 payload 数据。
        """
        root = Path(root).resolve()
        approval = await approve_before_execute(
            ctx,
            "workspace:authorize",
            {"tool": "workspace_authorize", "root": str(root), "reason": reason},
            payload={
                "review_type": "gate",
                "node_id": "workspace_authorize",
                "node_label": "工作区授权确认",
                "output_preview": f"授权工作区 {root}（文件工具将可读/写/编辑该目录）",
            },
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

    async def authorize_headless(self, root: Path, *, reason: str = "") -> dict[str, Any]:
        """headless 显式授权：生效路径与授权卡一致，但跳过审批卡。

        审批卡形态归交互宿主（桌面设置页）；headless 由调用方显式声明
        已获授权（等同 CLI --approve 语义）——记录落 storage + 文件工具
        重注册 + 引擎重建，重启后经 load 恢复同一根。
        """
        root = Path(root).resolve()
        await self._storage.put_record(
            self.AUTH_COLLECTION,
            self._AUTH_KEY,
            {
                "root": str(root),
                "granted_at": time.time(),
                "reason": reason,
                "decision": "accept",
            },
        )
        self._security.workspace.authorize(root)
        self._security.reregister_file_tools(root=root)
        await self._runtime.rebuild_engine()
        return {"ok": True, "root": str(root), "decision": "accept"}

    async def revoke(self, ctx: Any, *, reason: str = "") -> dict[str, Any]:
        """撤销授权（审批卡确认后回到未授权拒绝态）。"""
        approval = await approve_before_execute(
            ctx,
            "workspace:revoke",
            {"tool": "workspace_revoke", "reason": reason},
            payload={
                "review_type": "gate",
                "node_id": "workspace_revoke",
                "node_label": "工作区撤销确认",
                "output_preview": f"撤销工作区授权（{reason or '未说明原因'}）",
            },
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
    """http_fetch 端点执行体（出网经审批网关裁决 + 可选取回实现）。

    审批即网关：出网许可由门禁审批卡裁决（http_fetch 出厂 review 档
    弹卡），执行体不再按 allow_domains 二次硬拦（与 Rust 侧
    ``execute_http_fetch`` 同口径）——定义级 allow_domains 是装配提示
    而非执行期网关。执行体只做协议收口（仅 http/https 出网，越域 =
    结构化失败 NETWORK_DOMAIN_BLOCKED）。取回实现可注入（e2e 用 stub
    免真实出网；缺省 = httpx，可选依赖缺失时明确报错）。
    """

    async def execute(ctx: Any, definition: Any, args: dict, approval: Any) -> str:
        import urllib.parse

        url = str(args.get("url") or "")
        try:
            scheme = urllib.parse.urlsplit(url).scheme.lower()
        except ValueError:
            scheme = ""
        if scheme not in ("http", "https"):
            return json.dumps(
                {
                    "ok": False,
                    "status": "network_domain_blocked",
                    "error": (
                        f"http_fetch 仅支持 http/https 出网（{ErrorCode.NETWORK_DOMAIN_BLOCKED}）"
                    ),
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
        """回退一次写操作（快照存在 = 还原原内容；缺失 = False）。

        空快照（写前文件不存在 = 新建语义）回退 = 删除该文件，回到
        「写前不存在」状态（与写前快照语义严格一致）。
        """
        snapshot = self._snapshots.pop(str(path), None)
        if snapshot is None:
            return False
        if not snapshot:
            path.unlink(missing_ok=True)
            return True
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
            if operation == "search":
                return self._search(args, definition)
            if operation == "search_paths":
                return self._search_paths(args, definition)
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

    def _search_base(self, definition: Any) -> Path:
        """检索根目录（端点配置 root；沙箱已先行解析校验，此处防御归一）。"""
        root = Path(str((definition.endpoint_config or {}).get("root") or ""))
        return root

    def _search(self, args: dict, definition: Any) -> str:
        """grep：工作区文本内容检索（正则 + 路径 glob 过滤 + 类型过滤 +
        超限截断；只读，结果 = 命中文件/行号/摘要）。"""
        import re

        root = self._search_base(definition)
        if not root or not root.is_dir():
            return json.dumps(
                {"ok": False, "status": "no_root", "error": "检索根不可用（工作区未授权或目录缺失）"},
                ensure_ascii=False,
            )
        pattern = str(args.get("pattern") or "")
        if not pattern:
            return json.dumps(
                {"ok": False, "status": "missing_pattern", "error": "检索正则不能为空"},
                ensure_ascii=False,
            )
        try:
            regex = re.compile(pattern)
        except re.error as exc:
            return json.dumps(
                {"ok": False, "status": "invalid_pattern", "error": f"检索正则非法: {exc}"},
                ensure_ascii=False,
            )
        glob_pattern = str(args.get("glob") or "")
        include = str(args.get("include") or "")
        try:
            max_results = max(1, min(1000, int(args.get("max_results") or 100)))
        except (TypeError, ValueError):
            max_results = 100
        max_read = _size_limit(definition, "max_read_bytes", _DEFAULT_MAX_READ_BYTES)
        matches: list[dict[str, Any]] = []
        truncated = False
        try:
            for dirpath, dirnames, filenames in os.walk(root):
                if truncated:
                    break
                for name in sorted(filenames):
                    if len(matches) >= max_results:
                        truncated = True
                        break
                    full = Path(dirpath) / name
                    try:
                        rel = full.relative_to(root).as_posix()
                    except ValueError:
                        continue
                    if glob_pattern and not _glob_match(glob_pattern, rel):
                        continue
                    if include:
                        if include.startswith("."):
                            if not name.endswith(include):
                                continue
                        else:
                            inc = (
                                include
                                if include.startswith("*")
                                else ("*" + include if "." not in include else include)
                            )
                            if not fnmatch.fnmatch(name, inc):
                                continue
                    try:
                        size = full.stat().st_size
                    except OSError:
                        continue
                    if size > max_read:
                        continue  # 超限文件跳过（不读整文件，检索域受大小上限约束）
                    try:
                        text = full.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        continue
                    hit = regex.search(text)
                    if hit is None:
                        continue
                    line = text.count("\n", 0, hit.start()) + 1
                    line_start = text.rfind("\n", 0, hit.start()) + 1
                    line_end = text.find("\n", hit.start())
                    if line_end == -1:
                        line_end = len(text)
                    matches.append(
                        {
                            "path": rel,
                            "line": line,
                            "snippet": text[line_start:line_end].strip()[:200],
                        }
                    )
        except OSError:
            return json.dumps(
                {"ok": False, "status": "search_failed", "error": "检索失败（目录不可读或已删除）"},
                ensure_ascii=False,
            )
        if len(matches) >= max_results:
            truncated = True
        return json.dumps(
            {
                "ok": True,
                "matches": matches,
                "truncated": truncated,
                "total": len(matches),
            },
            ensure_ascii=False,
        )

    def _search_paths(self, args: dict, definition: Any) -> str:
        """glob：工作区路径检索（递归匹配；pattern 相对检索起点匹配，
        支持 ** 跨目录；只列路径不读内容）。"""
        import fnmatch

        root = self._search_base(definition)
        if not root or not root.is_dir():
            return json.dumps(
                {"ok": False, "status": "no_root", "error": "检索根不可用（工作区未授权或目录缺失）"},
                ensure_ascii=False,
            )
        pattern = str(args.get("pattern") or "")
        if not pattern:
            return json.dumps(
                {"ok": False, "status": "missing_pattern", "error": "路径模式不能为空"},
                ensure_ascii=False,
            )
        base = Path(str(args.get("path") or "")).resolve() if args.get("path") else root
        if not base.is_relative_to(root):
            return json.dumps(
                {"ok": False, "status": "out_of_root", "error": "检索起点越界（须在工作区根内）"},
                ensure_ascii=False,
            )
        try:
            max_results = max(1, min(1000, int(args.get("max_results") or 100)))
        except (TypeError, ValueError):
            max_results = 100
        pattern_norm = pattern.replace("\\", "/")
        matches: list[str] = []
        truncated = False
        try:
            for dirpath, dirnames, filenames in os.walk(base):
                if truncated:
                    break
                entries = sorted(
                    [Path(dirpath) / name for name in filenames]
                    + [Path(dirpath) / name for name in dirnames]
                )
                for entry in entries:
                    if len(matches) >= max_results:
                        truncated = True
                        break
                    try:
                        rel = entry.relative_to(base).as_posix()
                    except ValueError:
                        continue
                    if rel and _glob_match(pattern_norm, rel):
                        matches.append(entry.as_posix())
        except OSError:
            return json.dumps(
                {"ok": False, "status": "search_failed", "error": "检索失败（目录不可读或已删除）"},
                ensure_ascii=False,
            )
        if len(matches) >= max_results:
            truncated = True
        return json.dumps(
            {"ok": True, "paths": matches, "truncated": truncated, "total": len(matches)},
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
        # 写前快照统一（file_write/file_edit 同语义）：不论文件是否存在
        # 均记录写前原内容（新建文件 = 空快照，回退 = 删除该文件），
        # snapshot 恒 true——「写前快照已建立」与 file_edit 一致
        # （此前新建文件 snapshot: false 与 edit 的 true 语义不一致）。
        self._snapshots[str(path)] = path.read_bytes() if path.is_file() else b""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return json.dumps(
            {
                "ok": True,
                "path": str(path),
                "bytes": len(content.encode("utf-8")),
                "snapshot": True,
            },
            ensure_ascii=False,
        )


def make_file_ops_executor() -> FileOpsExecutor:
    """file_ops 端点执行体工厂（宿主注册；同一实例持有快照表）。"""
    return FileOpsExecutor()


def argv_program(args: Mapping[str, Any]) -> str | None:
    """argv 参数数组的首元素（命令名）；缺参/非数组/空 = None。"""
    argv = coerce_argv(args.get("argv"))
    if argv and isinstance(argv[0], str) and argv[0]:
        return argv[0]
    return None


def make_process_exec_executor(
    mount_service: Any,
    os_registry: OsControlRegistry,
    *,
    tiers: Mapping[str, str],
    require_approval: bool = True,
) -> Callable[..., Any]:
    """process_exec 端点执行体（宿主注册进声明式执行体表）。

    分发规则：propose_mcp_mount → 挂载服务；混合 shell（shell_exec，
    meta.escalation）白名单外命令经升级审批后带 _escalated 标记分发
    （白名单内命令照常）；其余 → OS 控制注册表分发。command 固定枚举
    与工具名不符 = 明确拒绝（COMMAND_ENUM_MISMATCH 语义，与端点操作
    判定同源）。
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
            outcome = await mount_service.propose_mount(
                ctx, address, require_approval=require_approval
            )
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
        # argv 参数规范化：模型可能把数组输出为 JSON 字符串（提取器已容错
        # 判定，执行体须同步收口为数组——命令面/白名单按 argv[0] 真实命令）
        if "argv" in args:
            argv = coerce_argv(args["argv"])
            if argv is not None:
                args = dict(args)
                args["argv"] = argv
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
        # 混合 shell（meta.escalation）：白名单外命令经审批升级放行。
        # 审批已通过（approval 决议 = accept/auto）且 argv[0] 不在白名单
        # → 给壳侧执行器打 escalated 标记（一次性系统级放行，cwd=主目录）；
        # 审批未通过 = 流水线在门禁阶段已拦截，不会走到执行体。
        if (
            (definition.meta or {}).get("escalation") is True
            and approval is not None
            and approval.decision in (DECISION_ACCEPT, DECISION_AUTO)
        ):
            program = argv_program(args)
            allowlist = tuple(definition.endpoint_config.get("allowlist") or ())
            if program and program not in allowlist:
                args = dict(args)
                args["_escalated"] = True
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
        # 自动审批可登记集（声明 meta.auto_approvable 标记的工具；
        # 只读感知/测试构建类出厂标记，其余工具一律不可登记）
        self.auto_approvable: frozenset[str] = frozenset(
            str(tool.get("name"))
            for tool in (tool_data.get("tools") or ())
            if (tool.get("meta") or {}).get("auto_approvable") is True
        )
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
        self.gate = TieredGate(
            self._tiers,
            executors=executors,
            auto_approvable=self.auto_approvable,
        )
        self.sandbox = DeclarativeSandboxProxy(executors, workspace=self.workspace)
        old = runtime.tool_pipeline
        runtime.tool_pipeline = SecurityToolPipeline(
            gate=self.gate,
            extractor=old.extractor,
            failure_reason=old.failure_reason,
            executor=old.executor,
            sandboxes=(self.sandbox,),
            guards=old.guards,
            audit=old.audit,
            max_result_chars=old.max_result_chars,
            allow_unchecked=old.allow_unchecked,
            trace_sink=old.trace_sink,
        )

    def set_auto_approve(self, tools: Sequence[str], all_review: bool) -> None:
        """自动审批配置（设置持久化层保存前调用；边界外硬拒）。"""
        self.gate.configure_auto_approve(tools, all_review)

    def set_tier_overrides(self, overrides: Mapping[str, str]) -> None:
        """逐工具档位覆盖（权限矩阵写面；deny 出厂档不可覆盖）。"""
        self.gate.set_tier_overrides(overrides)

    def tier_overrides(self) -> dict[str, str]:
        """当前档位覆盖（能力记录持久化形态）。"""
        return self.gate.tier_overrides()

    def effective_tiers(self) -> dict[str, str]:
        """全工具生效档位（覆盖优先；设置页权限矩阵展示面）。"""
        return {
            tool: self.gate.effective_tier(tool)
            for tool in self.tiers
        }

    def auto_approve_snapshot(self) -> dict[str, Any]:
        """自动审批快照（设置页装载形态：已勾选清单 + 全量开关）。"""
        tools, all_review = self.gate.auto_approve_snapshot()
        return {"tools": tools, "all_review": all_review}

    def auto_approvable_tools(self) -> list[str]:
        """自动审批可登记清单（设置页勾选项单一来源）。"""
        return self.gate.auto_approvable_tools()

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


# ── 自动审批设置持久化（能力记录通道：与壳 capability_get/put 同集合）──
# 对偶来源（S12）：集合/键与 Rust 侧 lib.rs CAPABILITY_COLLECTION/
# CAPABILITY_KEY 同源（命令面持久化与引擎侧恢复同键读写，6c 批收敛校验）

AUTO_APPROVE_COLLECTION = "app_capabilities"
AUTO_APPROVE_KEY = "capability"


async def restore_auto_approve(storage: Any, security: SecurityDomain) -> None:
    """从能力记录恢复自动审批设置与逐工具档位覆盖（启动装载）。

    记录字段：auto_approve_tools（工具名清单）/ auto_approve_all_review
    （全量开关）/ tier_overrides（工具名 → allow/review/deny）。
    装载失败只记日志，不阻断装配——出厂空集为最保守态。
    """
    try:
        record = await storage.get_record(AUTO_APPROVE_COLLECTION, AUTO_APPROVE_KEY)
    except Exception as exc:
        logger.warning("自动审批设置读取失败（回落出厂空集）: %s", exc)
        return
    if not isinstance(record, dict):
        return
    tools = record.get("auto_approve_tools")
    all_review = bool(record.get("auto_approve_all_review"))
    if isinstance(tools, (list, tuple)):
        try:
            security.set_auto_approve([str(t) for t in tools], all_review)
        except Exception as exc:
            logger.warning("自动审批设置装载被拒（按出厂空集启动）: %s", exc)
    overrides = record.get("tier_overrides")
    if isinstance(overrides, dict):
        try:
            security.set_tier_overrides(
                {str(k): str(v) for k, v in overrides.items()}
            )
        except Exception as exc:
            logger.warning("档位覆盖装载被拒（按出厂档位启动）: %s", exc)


def _glob_translate(pattern: str) -> str:
    """fnmatch 通配翻译（与 Rust 侧 translate_pattern 同语义；``*`` →
    ``.*`` / ``?`` → ``.`` / ``[seq]`` 字符类）。``**`` 段间拼接用。"""
    import re

    res: list[str] = []
    i, n = 0, len(pattern)
    while i < n:
        c = pattern[i]
        i += 1
        if c == "*":
            res.append(".*")
        elif c == "?":
            res.append(".")
        elif c == "[":
            j = i
            if j < n and pattern[j] == "!":
                j += 1
            if j < n and pattern[j] == "]":
                j += 1
            while j < n and pattern[j] != "]":
                j += 1
            if j >= n:
                res.append(r"\[")
            else:
                stuff = pattern[i:j]
                if stuff.startswith("!"):
                    stuff = "^" + stuff[1:]
                elif stuff.startswith("^"):
                    stuff = "\\" + stuff
                res.append("[" + stuff + "]")
                i = j + 1
        else:
            res.append(re.escape(c))
    return "".join(res)


def _glob_match(pattern: str, text: str) -> bool:
    """glob 路径匹配（``**`` 跨目录分隔符；无 ``**`` 时与 fnmatch 等价）。

    路径统一正斜杠后匹配：``**/*.json`` 匹配任意深度 json（含基址直下
    文件），``src/**`` 匹配 src 下任意路径；段内 ``*``/``?`` 通配与
    fnmatch 同语义。
    """
    import fnmatch
    import re

    if "**" not in pattern:
        return fnmatch.fnmatch(text, pattern)
    regex = ""
    for idx, part in enumerate(pattern.split("**")):
        if not idx:
            regex += _glob_translate(part)
        elif part.startswith("/"):
            regex += "(?:.*/)?"
            regex += _glob_translate(part[1:])
        else:
            regex += ".*"
            regex += _glob_translate(part)
    return re.fullmatch(regex, text) is not None


__all__ = [
    "AUTO_APPROVE_COLLECTION",
    "AUTO_APPROVE_KEY",
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
    "restore_auto_approve",
]
