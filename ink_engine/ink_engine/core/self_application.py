"""自指层应用管线：集补丁链 + 审批分级落链 + 回退 + 旁路写防护。

应用 = 提案落地的唯一路径：校验（ProposalValidator）→ 基准冲突
检测（并发提案 base 不匹配拒绝重提）→ 审批分级（L0 策略直过 /
L1 弹卡 / L2 沙箱验证 + 人工）→ 补丁链 append → 审计留痕 →
活跃态应用（ApplyTarget 钩子）。回退 = 链级操作：仅允许回退链尾
补丁（其上存在后继补丁 = 拒绝，保持链完整性），回退后集状态由
宿主从链组装恢复。

集补丁链（SetPatchChain）：集状态 = base + 有序补丁列表（内容型
补丁链，与 harness 仓库同哲学）——补丁按类型落路径（ui/theme/
tools/rules/knowledge/harness/event_types/environments/artifacts），
组装 = 集状态全量（权威记录），回退/版本化 = 链级操作不物理删除
历史。审计（set_audit 集合）append-only：历史不撒谎，回退不删
记录——回退动作本身也落审计。

旁路写防护（GuardedStorage）：storage 包装——集内可演化资产集合
（界面/工具注册/事件类型/环境/产物/补丁链本身）的唯一写入路径 =
本管线；未携带补丁链上下文的直写被拒绝（防 AI 生成代码绕过审批
直改数据）。机制通道（checkpoint/事件日志/用户位置感知/设置）与
引擎机制内部写入（启动装配/种子注入）不受此限——启动装配路径经
显式豁免上下文（allow_mechanism）放行，其余直写一律 fail-closed。
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol, runtime_checkable

from .approval import (
    DECISION_EDIT,
    DECISION_REJECT,
    ApprovalDecision,
    DefaultInterruptPolicy,
    InterruptPolicy,
    approve_before_execute,
)
from .exceptions import GraphDefinitionError
from .logging import get_logger
from .patch_chain import AssembleMode, Patch, PatchChain, PatchOp
from .self_proposal import PatchKind, ProposalValidator, SelfProposal
from .storage import Storage

logger = get_logger(__name__)

# 集补丁链持久化集合与键（通用存储服务 records 通道）
_SET_CHAIN_COLLECTION = "set_patch_chain"
_SET_CHAIN_KEY = "chain"
# 集演化审计集合（append-only，历史不撒谎）；公开别名供宿主观察侧
# （孵化/指标聚合）复用同一权威集合名，避免双份字面量漂移
_SET_AUDIT_COLLECTION = "set_audit"
SET_AUDIT_COLLECTION = _SET_AUDIT_COLLECTION

# 补丁落点路径段（集状态结构：组装产物即集状态全量）
_PATH_UI = "ui"
_PATH_THEME = "theme"
_PATH_TOOLS = "tools"
_PATH_RULES = "rules"
_PATH_KNOWLEDGE = "knowledge"
_PATH_HARNESS = "harness"
_PATH_EVENT_TYPES = "event_types"
_PATH_ENVIRONMENTS = "environments"
_PATH_ARTIFACTS = "artifacts"

# 补丁路径段 → 补丁类型（回退审计的 last_patch 路径段反推类型用）。
# 与上方落点路径段同源单一维护（宿主观察侧复用，避免第二份映射漂移）
SEGMENT_TO_KIND: dict[str, str] = {
    _PATH_UI: "ui",
    _PATH_THEME: "theme",
    _PATH_TOOLS: "tool",
    _PATH_RULES: "rule",
    _PATH_KNOWLEDGE: "knowledge",
    _PATH_HARNESS: "harness",
    _PATH_EVENT_TYPES: "event_type",
    _PATH_ENVIRONMENTS: "environment",
    _PATH_ARTIFACTS: "artifact",
}

# 旁路写防护的演化资产集合（唯一写入路径 = 本管线）。
# 精确集合 + 前缀集合两类：知识/规则条目落 knowledge:<user_id> 集合
# （动态前缀，见 knowledge_set 的集合命名），前缀匹配兜底——规则以
# kind=rule 知识条目同落此集合，一并受守卫
_GUARDED_COLLECTIONS: frozenset[str] = frozenset(
    {
        _SET_CHAIN_COLLECTION,
        _SET_AUDIT_COLLECTION,
        "ui",
        "tool_defs",
        "event_types",
        "environments",
        "artifacts",
        "harness",
    }
)
_GUARDED_PREFIXES: tuple[str, ...] = ("knowledge:",)

# 审批动作 key 前缀（挂卡/直过的依据；L0 名单按 key 注入策略）
_APPROVAL_KEY_PREFIX = "patch"

# 审计状态（声明式枚举，防魔法字符串）
AUDIT_STATUS_APPLIED = "applied"
AUDIT_STATUS_REJECTED = "rejected"
AUDIT_STATUS_CONFLICT = "conflict"
AUDIT_STATUS_INVALID = "invalid"
AUDIT_STATUS_REVERTED = "reverted"


class ApprovalLevel(StrEnum):
    """审批分级（产品层语义，映射引擎既有策略）：
    L0 = 策略直过（auto_approve_keys 白名单）；
    L1 = 弹卡快速确认（approve_before_execute）；
    L2 = 沙箱验证 + 人工审批（vetting 通过才弹卡）。
    """

    L0 = "L0"
    L1 = "L1"
    L2 = "L2"


# 默认分级：低风险形态（主题/界面微调）L0 直过；工具/规则/知识/
# harness/事件/环境 L1 弹卡；构建产物引用（哈希+冒烟门禁语义）L2
# 沙箱验证 + 人工审批。宿主可整体替换（如把 artifact promote 提升 L2）
DEFAULT_APPROVAL_LEVELS: dict[PatchKind, ApprovalLevel] = {
    PatchKind.THEME: ApprovalLevel.L0,
    PatchKind.UI: ApprovalLevel.L0,
    PatchKind.TOOL: ApprovalLevel.L1,
    PatchKind.RULE: ApprovalLevel.L1,
    PatchKind.KNOWLEDGE: ApprovalLevel.L1,
    PatchKind.HARNESS: ApprovalLevel.L1,
    PatchKind.EVENT_TYPE: ApprovalLevel.L1,
    PatchKind.ENVIRONMENT: ApprovalLevel.L1,
    PatchKind.ARTIFACT: ApprovalLevel.L2,
}

# 审批挂起窗口（默认 7 天）：超时未决自动过期回滚（approval 机制
# 按 expires_at 判定，过期重入一律 reject + 留痕，fail-closed）
APPROVAL_TIMEOUT_SECONDS: float = 7 * 24 * 3600

# L2 额外校验钩子签名：提案 → 违规清单（空 = 通过沙箱验证）
L2VettingHook = Callable[[SelfProposal], list[str]]


def patch_path(kind: PatchKind, payload: dict[str, Any]) -> tuple[tuple[str, ...], Any]:
    """补丁落点推导：类型 × payload → 集状态路径与落链值。

    每类补丁落集状态的一个路径段（同名键整体替换）——组装结果即
    集状态全量，回退/版本化天然覆盖全部演化对象。
    """
    if kind is PatchKind.UI:
        spec = payload.get("spec") or {}
        name = spec.get("name") or "boot.panel"
        return (_PATH_UI, name), spec
    if kind is PatchKind.THEME:
        return (_PATH_THEME,), payload.get("tokens") or {}
    if kind is PatchKind.TOOL:
        name = payload.get("name")
        if not name:
            raise GraphDefinitionError("tool 补丁缺 name（工具注册名）")
        return (_PATH_TOOLS, name), payload
    if kind is PatchKind.RULE:
        rule = payload.get("rule") or {}
        rule_id = rule.get("id") or payload.get("rule_id")
        if not rule_id:
            raise GraphDefinitionError("rule 补丁缺规则 id")
        return (_PATH_RULES, str(rule_id)), rule
    if kind is PatchKind.KNOWLEDGE:
        entry = payload.get("entry") or {}
        entry_id = entry.get("id") or payload.get("entry_id")
        if not entry_id:
            raise GraphDefinitionError("knowledge 补丁缺条目 id")
        return (_PATH_KNOWLEDGE, str(entry_id)), entry
    if kind is PatchKind.HARNESS:
        definition = payload.get("definition") or {}
        name = definition.get("name")
        if not name:
            raise GraphDefinitionError("harness 补丁缺定义 name")
        return (_PATH_HARNESS, name), definition
    if kind is PatchKind.EVENT_TYPE:
        name = payload.get("name")
        if not name:
            raise GraphDefinitionError("event_type 补丁缺 name")
        return (_PATH_EVENT_TYPES, name), payload
    if kind is PatchKind.ENVIRONMENT:
        name = payload.get("name")
        if not name:
            raise GraphDefinitionError("environment 补丁缺 name")
        return (_PATH_ENVIRONMENTS, name), payload
    if kind is PatchKind.ARTIFACT:
        artifact_id = payload.get("artifact_id")
        if not artifact_id:
            raise GraphDefinitionError("artifact 补丁缺 artifact_id")
        return (_PATH_ARTIFACTS, artifact_id), payload
    raise GraphDefinitionError(f"未知补丁类型: {kind.value!r}")


class SetPatchChain:
    """集补丁链（storage records 持久化：权威记录 = 链本身）。

    版本语义（与 harness 仓库同哲学）：版本号 = 补丁数 + 1（首版 =
    base 无补丁）；组装（assemble）支持任意版本（回退/审计取用）；
    回退 = 组装到目标版本为新的 base、清空补丁（链长收敛，旧链在
    审计中完整保留）；并发检测 = 提案基准版本与当前版本比对。
    """

    def __init__(self, storage: Storage, *, guard_token: str | None = None) -> None:
        self._storage = storage
        self._guard_token = guard_token

    async def _load(self) -> PatchChain:
        record = await self._storage.get_record(
            _SET_CHAIN_COLLECTION, _SET_CHAIN_KEY
        )
        return PatchChain.from_dict(record) if record else PatchChain()

    async def current_version(self) -> int:
        """当前版本（= 补丁数 + 1；空集 = 版本 1）。"""
        chain = await self._load()
        return len(chain.patches) + 1

    async def _put_record(self, collection: str, key: str, data: dict) -> None:
        """链写入（持有守卫令牌时随调用透传——Storage 协议无该参数，
        普通后端不传即透传）。"""
        if self._guard_token is not None:
            await self._storage.put_record(
                collection, key, data, guard_token=self._guard_token
            )
        else:
            await self._storage.put_record(collection, key, data)

    async def append(self, patch: Patch) -> int:
        """追加一条补丁（append-only）：链记录整体写回（单次存储事务）。

        Returns:
            新版本号。
        """
        chain = await self._load()
        chain.apply(patch)
        await self._put_record(
            _SET_CHAIN_COLLECTION, _SET_CHAIN_KEY, chain.to_dict()
        )
        return len(chain.patches) + 1

    async def assemble(self, version: int | None = None) -> dict:
        """组装集状态（缺省最新版本；version = 回退/审计指定版本）。"""
        chain = await self._load()
        if version is None:
            return chain.assemble()
        if version < 1 or version > len(chain.patches) + 1:
            raise GraphDefinitionError(
                f"集版本越界: {version}（当前 {len(chain.patches) + 1}）"
            )
        if version == 1:
            return chain.assemble(mode=AssembleMode.BASE_ONLY)
        return chain.assemble(mode=AssembleMode.PARTIAL, end=version - 1)

    async def revert_to(self, version: int) -> dict:
        """回退到指定版本：仅允许回退链尾（当前版本 - 1，单步回退）。

        链完整性在存储层强制：回退目标是「已应用的链尾补丁」本身——
        其上有后继补丁 = 拒绝（宿主先回退后继，保持链有序）。回退 =
        组装到目标版本为新的 base、清空补丁（新链独立，旧链数据在
        审计中完整保留——append-only，历史不撒谎）。调用方负责落
        审计记录（回退动作本身留痕）。

        Args:
            version: 回退目标版本（当前版本 - 1；版本 1 = 回退全部补丁）。

        Returns:
            回退后的集状态。
        """
        chain = await self._load()
        current = len(chain.patches) + 1
        if version < 1 or version > current:
            raise GraphDefinitionError(
                f"回退目标版本越界: {version}（当前 {current}）"
            )
        if version == current:
            raise GraphDefinitionError(
                f"回退目标须低于当前版本: {version} == {current}"
                "（回退的是已应用补丁，不是链尾本身）"
            )
        if version != current - 1:
            raise GraphDefinitionError(
                f"仅允许回退链尾补丁: 目标版本 {version}，当前 {current}"
                f"（一次回退一步——其上存在后继补丁，先回退后继，"
                "保持链完整性）"
            )
        # 组装到目标版本 = 目标形态（链尾补丁被回退，其余补丁原样保留）
        doc = chain.assemble(mode=AssembleMode.PARTIAL, end=version - 1)
        await self._put_record(
            _SET_CHAIN_COLLECTION,
            _SET_CHAIN_KEY,
            PatchChain(base=doc, patches=[]).to_dict(),
        )
        return doc

    async def last_patch(self) -> dict | None:
        """链尾补丁摘要（回退审计的内容来源；空链 = None）。"""
        chain = await self._load()
        if not chain.patches:
            return None
        last = chain.patches[-1]
        return {
            "op": last.op.value,
            "path": list(last.path),
            "value": last.value,
        }


@dataclass(frozen=True, slots=True)
class PatchOutcome:
    """单次提案的处理结果（决议/落链/应用状态）。

    Attributes:
        patch_id: 补丁版本号（批准落链后；未落链 = None）。
        decision: 审批决议（accept/auto/edit/reject/terminate）。
        status: 处理状态（applied/rejected/conflict/invalid/reverted/
            pending）。
        reason: 拒绝/冲突/非法原因（展示与留痕）。
        applied: 是否已生效（落链且目标应用成功）。
        apply_error: 活跃态应用失败原因（链已落但运行时未生效；None =
            应用成功或无目标钩子）。审计载荷同步携带——「链已落」与
            「运行时未生效」明确区分，不默认为成功。
    """

    patch_id: int | None = None
    decision: str = DECISION_REJECT
    status: str = AUDIT_STATUS_REJECTED
    reason: str | None = None
    applied: bool = False
    apply_error: str | None = None


@runtime_checkable
class ApplyTarget(Protocol):
    """活跃态应用目标（宿主注册：补丁落链后的运行时生效钩子）。

    钩子按补丁类型注册（如 ui → 更新渲染器数据源；tool → 注册进
    工具表；event_type → 事件类型注册表登记）；幂等可重放——重启
    装配从链组装恢复活跃态，不依赖钩子重放。
    """

    name: str

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None: ...


class SelfApplicationPipeline:
    """自指应用管线：提案 → 校验 → 分级审批 → 落链 → 应用 → 审计。

    装配（依赖注入）：storage（集补丁链后盾）、validator（按类型
    校验）、policy（审批策略，L0 = auto_approve_keys 白名单）、
    分级表（kind → L0/L1/L2）、l2_vetting（L2 的沙箱验证钩子）、
    targets（活跃态应用目标注册表）。
    """

    def __init__(
        self,
        storage: Storage,
        *,
        validator: ProposalValidator | None = None,
        policy: InterruptPolicy | None = None,
        approval_levels: dict[PatchKind, ApprovalLevel] | None = None,
        l2_vetting: L2VettingHook | None = None,
        on_reverted: Callable[[int, str], Any] | None = None,
        guard_token: str | None = None,
    ) -> None:
        self.chain = SetPatchChain(storage, guard_token=guard_token)
        self._storage = storage
        self._guard_token = guard_token
        self._validator = validator or ProposalValidator()
        auto_keys = frozenset(
            f"{_APPROVAL_KEY_PREFIX}:{kind.value}"
            for kind, level in (approval_levels or DEFAULT_APPROVAL_LEVELS).items()
            if level is ApprovalLevel.L0
        )
        self._policy = policy or DefaultInterruptPolicy(
            auto_approve_keys=auto_keys, timeout=APPROVAL_TIMEOUT_SECONDS
        )
        self._levels = dict(approval_levels or DEFAULT_APPROVAL_LEVELS)
        self._l2_vetting = l2_vetting
        self._on_reverted = on_reverted
        self._targets: dict[PatchKind, ApplyTarget] = {}

    @property
    def validator(self) -> ProposalValidator:
        """按类型校验器（提案校验入口；propose 阶段复用，零冗余）。"""
        return self._validator

    def register_target(self, kind: PatchKind, target: ApplyTarget) -> None:
        """注册活跃态应用目标（同名覆盖 = 宿主按配置装配）。"""
        self._targets[kind] = target

    async def _put_record(self, collection: str, key: str, data: dict) -> None:
        """审计写入（持有守卫令牌时随调用透传——Storage 协议无该参数，
        普通后端不传即透传）。"""
        if self._guard_token is not None:
            await self._storage.put_record(
                collection, key, data, guard_token=self._guard_token
            )
        else:
            await self._storage.put_record(collection, key, data)

    def approval_key(self, kind: PatchKind) -> str:
        return f"{_APPROVAL_KEY_PREFIX}:{kind.value}"

    async def apply(
        self,
        ctx: Any,
        proposal: SelfProposal,
        *,
        round_id: str | None = None,
    ) -> PatchOutcome:
        """应用一条提案：校验 → 冲突 → 分级审批 → 落链 → 应用 → 审计。

        决议语义（对齐 approval 机制）：
        - accept/auto：落链并应用；
        - edit：edited_content 作为新 payload **重新过一遍校验**，
          通过才落链（失败 = 拒绝并留痕，不半途落链）；
        - reject/terminate：拒绝并留痕（fail-closed 方向）。
        """
        # ① 形态校验：非法 payload 在闸门口拒绝（不挂卡不落链）
        violations = self._validator.validate(proposal)
        if violations:
            await self._audit(
                proposal,
                status=AUDIT_STATUS_INVALID,
                reason="；".join(violations),
                round_id=round_id,
            )
            return PatchOutcome(
                decision=DECISION_REJECT,
                status=AUDIT_STATUS_INVALID,
                reason="；".join(violations),
            )
        # ② 并发冲突：基准版本 ≠ 当前版本 = 拒绝并要求基于最新态重提
        current = await self.chain.current_version()
        if proposal.base_version != current:
            reason = (
                f"并发冲突: 提案基于版本 {proposal.base_version}，"
                f"当前版本 {current}——请基于最新集状态重提"
            )
            await self._audit(
                proposal,
                status=AUDIT_STATUS_CONFLICT,
                reason=reason,
                round_id=round_id,
            )
            return PatchOutcome(
                decision=DECISION_REJECT,
                status=AUDIT_STATUS_CONFLICT,
                reason=reason,
            )
        # ③ 分级审批：L0 直过（策略 auto_approve_keys）/ L1 弹卡 /
        #    L2 沙箱验证通过后才弹卡。L2 未装配验证钩子 = 显式拒绝
        #    （fail-closed——L2 的沙箱验证不是可选项，缺验证不静默降级）
        level = self._levels.get(proposal.kind, ApprovalLevel.L1)
        if level is ApprovalLevel.L2:
            if self._l2_vetting is None:
                reason = f"L2 沙箱验证未装配（{proposal.kind.value} 补丁须人工验证）"
                await self._audit(
                    proposal,
                    status=AUDIT_STATUS_REJECTED,
                    reason=reason,
                    round_id=round_id,
                )
                return PatchOutcome(
                    decision=DECISION_REJECT,
                    status=AUDIT_STATUS_REJECTED,
                    reason=reason,
                )
            vetting_violations = self._l2_vetting(proposal)
            if vetting_violations:
                reason = f"L2 沙箱验证未通过: {'；'.join(vetting_violations)}"
                await self._audit(
                    proposal,
                    status=AUDIT_STATUS_REJECTED,
                    reason=reason,
                    round_id=round_id,
                )
                return PatchOutcome(
                    decision=DECISION_REJECT,
                    status=AUDIT_STATUS_REJECTED,
                    reason=reason,
                )
        action = self._build_action(proposal)
        approval = await approve_before_execute(
            ctx,
            self.approval_key(proposal.kind),
            action,
            payload=self._build_card(proposal),
            policy=self._policy,
        )
        if approval.decision in (DECISION_REJECT, "terminate"):
            await self._audit(
                proposal,
                status=AUDIT_STATUS_REJECTED,
                reason=approval.reason or "审批未通过",
                decision=approval.decision,
                round_id=round_id,
            )
            return PatchOutcome(
                decision=approval.decision,
                status=AUDIT_STATUS_REJECTED,
                reason=approval.reason or "审批未通过",
            )
        if approval.decision == DECISION_EDIT:
            edited = self._resolve_edited(approval, proposal)
            if edited is None:
                reason = "编辑决议内容非法（重新校验未通过），未落链"
                await self._audit(
                    proposal,
                    status=AUDIT_STATUS_REJECTED,
                    reason=reason,
                    decision=DECISION_EDIT,
                    round_id=round_id,
                )
                return PatchOutcome(
                    decision=DECISION_EDIT,
                    status=AUDIT_STATUS_REJECTED,
                    reason=reason,
                )
            proposal = edited
        # ④ 落链前复验并发基准：审批（L1 弹卡等）可能异步挂起，期间链
        #    可能已被其他提案推进——基于过期基准落链会静默覆盖等待期内
        #    已批准的变更。复验不匹配 = 拒绝并要求基于最新态重提（与
        #    ② 的初始校验同语义，审批等待不再是并发窗口）。
        current = await self.chain.current_version()
        if proposal.base_version != current:
            reason = (
                f"并发冲突: 审批等待期间集已前进（提案基于版本 "
                f"{proposal.base_version}，当前 {current}）——"
                f"请基于最新集状态重提"
            )
            await self._audit(
                proposal,
                status=AUDIT_STATUS_CONFLICT,
                reason=reason,
                decision=approval.decision,
                round_id=round_id,
            )
            return PatchOutcome(
                decision=DECISION_REJECT,
                status=AUDIT_STATUS_CONFLICT,
                reason=reason,
            )
        # ⑤ 落链（单次存储事务）+ ⑥ 活跃态应用（幂等钩子）
        try:
            path, value = patch_path(proposal.kind, proposal.payload)
            patch_id = await self.chain.append(
                Patch(op=PatchOp.REPLACE, path=path, value=value)
            )
        except GraphDefinitionError as exc:
            reason = f"落链失败: {exc}"
            await self._audit(
                proposal,
                status=AUDIT_STATUS_REJECTED,
                reason=reason,
                decision=approval.decision,
                round_id=round_id,
            )
            return PatchOutcome(
                decision=approval.decision,
                status=AUDIT_STATUS_REJECTED,
                reason=reason,
            )
        target = self._targets.get(proposal.kind)
        apply_error: str | None = None
        if target is not None:
            try:
                await target.apply(proposal.payload, patch_id)
            except Exception as exc:
                apply_error = str(exc)
                logger.warning(f"补丁 {patch_id} 活跃态应用失败（链已落，重启装配恢复）: {exc}")
        await self._audit(
            proposal,
            status=AUDIT_STATUS_APPLIED,
            patch_id=patch_id,
            decision=approval.decision,
            round_id=round_id,
            apply_error=apply_error,
        )
        return PatchOutcome(
            patch_id=patch_id,
            decision=approval.decision,
            status=AUDIT_STATUS_APPLIED,
            applied=True,
            apply_error=apply_error,
        )

    async def revert(
        self,
        ctx: Any,
        patch_id: int,
        *,
        reason: str = "",
        round_id: str | None = None,
    ) -> PatchOutcome:
        """回退指定补丁（仅链尾）：审批确认后落审计 + 链级回退。

        回退 = 组装到目标版本为新的 base（append-only：旧链数据在
        审计中完整保留）。链尾补丁 = 版本 N，回退 N = 组装到 N-1。
        """
        current = await self.chain.current_version()
        if patch_id != current:
            raise GraphDefinitionError(
                f"仅允许回退链尾补丁: 目标 #{patch_id}，链尾 #{current}"
                "（其上存在后继补丁或越界——先回退后继，保持链完整性）"
            )
        target_version = patch_id - 1
        if target_version < 1:
            raise GraphDefinitionError(
                "回退目标越界: 版本 1 为集基线，不可回退"
            )
        # 回退是形态变更：与提案同走审批（默认 L1 弹卡）
        action = {
            "tool": "revert_patch",
            "patch_id": patch_id,
            "summary": f"回退补丁 #{patch_id}",
            "reason": reason,
        }
        approval = await approve_before_execute(
            ctx,
            f"revert:{patch_id}",
            action,
            payload={
                "review_type": "gate",
                "node_id": "revert_patch",
                "node_label": f"回退补丁 #{patch_id}",
                "output_preview": f"回退补丁 #{patch_id}（{reason or '未说明原因'}）",
            },
            policy=self._policy,
        )
        if approval.decision in (DECISION_REJECT, "terminate"):
            return PatchOutcome(
                decision=approval.decision,
                status=AUDIT_STATUS_REJECTED,
                reason=approval.reason or "回退审批未通过",
            )
        last = await self.chain.last_patch()
        # 审批批准后、落回退前复验：审批异步挂起期间链可能已前进（他方
        # 落链），链尾不再是我们批准的补丁——直接 revert_to 会回退到
        # 错误的版本语义。复验失败 = 明确拒绝 + 审计留痕（批准动作不
        # 可无记录）。
        current = await self.chain.current_version()
        if patch_id != current:
            reason_msg = (
                f"回退冲突: 审批等待期间链已前进（目标 #{patch_id}，"
                f"当前链尾 #{current}）——请基于最新链尾重新发起回退"
            )
            await self._put_record(
                _SET_AUDIT_COLLECTION,
                self._audit_key(),
                {
                    "kind": "revert",
                    "patch_id": patch_id,
                    "reason": reason,
                    "decision": approval.decision,
                    "round_id": round_id,
                    "last_patch": last,
                    "status": AUDIT_STATUS_CONFLICT,
                    "conflict_reason": reason_msg,
                    "created_at": time.time(),
                },
            )
            return PatchOutcome(
                decision=DECISION_REJECT,
                status=AUDIT_STATUS_CONFLICT,
                reason=reason_msg,
            )
        await self.chain.revert_to(target_version)
        if self._on_reverted is not None:
            try:
                result = self._on_reverted(patch_id, reason)
                if hasattr(result, "__await__"):
                    await result
            except Exception as exc:
                logger.warning(f"回退通知失败（忽略）: {exc}")
        audit_record = {
            "kind": "revert",
            "patch_id": patch_id,
            "base_version": target_version,
            "reason": reason,
            "decision": approval.decision,
            "round_id": round_id,
            "last_patch": last,
            "status": AUDIT_STATUS_REVERTED,
            "created_at": time.time(),
        }
        await self._put_record(_SET_AUDIT_COLLECTION, self._audit_key(), audit_record)
        return PatchOutcome(
            patch_id=patch_id,
            decision=approval.decision,
            status=AUDIT_STATUS_REVERTED,
            reason=reason or None,
            applied=False,
        )

    async def audit_log(self, *, limit: int = 100) -> list[dict]:
        """集演化审计日志（append-only，按时间倒序；limit 截取尾部）。"""
        records = await self._storage.list_records(_SET_AUDIT_COLLECTION)
        ordered = sorted(records, key=lambda r: float(r.get("created_at") or 0))
        return ordered[-limit:]

    def _build_action(self, proposal: SelfProposal) -> dict:
        return {
            "tool": f"apply_patch:{proposal.kind.value}",
            "kind": proposal.kind.value,
            "summary": proposal.rationale or f"应用 {proposal.kind.value} 补丁",
            "payload": proposal.payload,
            "base_version": proposal.base_version,
        }

    def _build_card(self, proposal: SelfProposal) -> dict:
        """审批卡负载（展示补丁类型/理由/payload 预览；前端按此渲染）。"""
        return {
            "review_type": "gate",
            "node_id": f"apply_patch:{proposal.kind.value}",
            "node_label": f"应用{proposal.kind.value}补丁",
            "output_preview": (
                f"类型: {proposal.kind.value}\n"
                f"理由: {proposal.rationale or '（未说明）'}"
            ),
            "patch": {
                "kind": proposal.kind.value,
                "payload": proposal.payload,
                "base_version": proposal.base_version,
            },
        }

    def _resolve_edited(
        self, approval: ApprovalDecision, proposal: SelfProposal
    ) -> SelfProposal | None:
        """编辑决议内容落地：重新过校验，通过才采用（不半途落链）。"""
        edited = approval.edited_content
        if not isinstance(edited, dict):
            return None
        reworked = SelfProposal(
            kind=proposal.kind,
            payload=edited,
            base_version=proposal.base_version,
            rationale=proposal.rationale,
            meta=proposal.meta,
        )
        if self._validator.validate(reworked):
            return None
        return reworked

    async def _audit(
        self,
        proposal: SelfProposal,
        *,
        status: str,
        reason: str | None = None,
        decision: str = DECISION_REJECT,
        patch_id: int | None = None,
        round_id: str | None = None,
        apply_error: str | None = None,
    ) -> None:
        """落审计记录（append-only，历史不撒谎）。

        apply_error 非 None 时记录活跃态应用失败（链已落但运行时未
        生效——「链已落」与「运行时生效」在审计中明确区分，不默认为
        成功）。
        """
        record = {
            "kind": proposal.kind.value,
            "patch_id": patch_id,
            "base_version": proposal.base_version,
            "rationale": proposal.rationale,
            "reason": reason,
            "decision": decision,
            "status": status,
            "round_id": round_id,
            "payload": proposal.payload,
            "meta": dict(proposal.meta),
            "apply_error": apply_error,
            "created_at": time.time(),
        }
        await self._put_record(_SET_AUDIT_COLLECTION, self._audit_key(), record)

    @staticmethod
    def _audit_key() -> str:
        """审计记录键：时间戳 + 随机后缀（同秒多记录不冲突）。"""
        import uuid

        return f"{time.time():.3f}-{uuid.uuid4().hex[:8]}"


class GuardedStorage:
    """旁路写防护：storage 包装（演化资产集合的直写被拒绝）。

    判定语义：collection ∈ 演化资产集合（界面/工具注册/事件类型/
    环境/产物/补丁链/审计）AND 不在显式豁免中 = 拒绝（fail-closed）。
    放行路径（二选一）：
    - 守卫令牌（guard_token）：应用管线内部写入携带与包装一致的
      令牌——补丁链/审计的自身写入经令牌放行（唯一写入路径的
      机制侧）；
    - 机制豁免上下文（allow_mechanism）：启动装配与引擎机制内部
      写入使用（退出上下文即收回）。
    AI 生成代码在运行期拿到的 storage 引用默认全拦截，演化写入
    唯一路径 = 应用管线。
    """

    def __init__(
        self, inner: Storage, *, guarded: bool = True, guard_token: str | None = None
    ) -> None:
        self._inner = inner
        self._guarded = guarded
        self._guard_token = guard_token
        self._mechanism_allows: set[str] = set()

    @property
    def inner(self) -> Storage:
        return self._inner

    def allow_mechanism(self, collection: str | None = None):
        """启动装配/引擎机制的显式豁免上下文（离开上下文即收回）。

        用法：``async with guarded.allow_mechanism("harness"): ...``
        未指定集合 = 全豁免（启动装配一次性用）；上下文退出后恢复拦截。
        """

        class _Allow:
            def __init__(self, owner: GuardedStorage) -> None:
                self._owner = owner

            def __enter__(self) -> None:
                if collection is None:
                    self._owner._mechanism_allows.add("*")
                else:
                    self._owner._mechanism_allows.add(collection)

            def __exit__(self, *exc: Any) -> None:
                if collection is None:
                    self._owner._mechanism_allows.discard("*")
                else:
                    self._owner._mechanism_allows.discard(collection)

        return _Allow(self)

    @staticmethod
    def _is_guarded(collection: str) -> bool:
        """演化资产集合判定：精确命中或前缀命中（knowledge:<id> 动态集合）。"""
        if collection in _GUARDED_COLLECTIONS:
            return True
        return any(collection.startswith(prefix) for prefix in _GUARDED_PREFIXES)

    async def put_record(
        self, collection: str, key: str, data: dict, *, guard_token: str | None = None
    ) -> None:
        """写拦截判定：演化资产集合直写拒绝（携带守卫令牌/豁免上下文除外）。"""
        token_ok = (
            guard_token is not None
            and self._guard_token is not None
            and guard_token == self._guard_token
        )
        if (
            self._guarded
            and self._is_guarded(collection)
            and not token_ok
            and "*" not in self._mechanism_allows
            and collection not in self._mechanism_allows
        ):
            raise GraphDefinitionError(
                f"旁路写拦截: 集合 {collection} 为集内可演化资产，"
                "唯一写入路径 = 自指应用管线（self_application）"
            )
        await self._inner.put_record(collection, key, data)

    # ── 其余 Storage 协议方法透传（checkpoint/事件日志/读取全放行）──
    async def get_checkpoint(self, checkpoint_id: int):
        return await self._inner.get_checkpoint(checkpoint_id)

    async def get_latest_checkpoint(self, thread_id: str):
        return await self._inner.get_latest_checkpoint(thread_id)

    async def put_checkpoint(self, record, *, expected_version=None, fork=False):
        return await self._inner.put_checkpoint(
            record, expected_version=expected_version, fork=fork
        )

    async def list_checkpoints(self, thread_id: str, *, limit: int = 100):
        return await self._inner.list_checkpoints(thread_id, limit=limit)

    async def chain_index(self, thread_id: str):
        return await self._inner.chain_index(thread_id)

    async def delete_checkpoints(self, thread_id: str, ids: list[int]):
        return await self._inner.delete_checkpoints(thread_id, ids)

    async def set_checkpoint_parent(
        self, thread_id: str, checkpoint_id: int, parent_id: int | None
    ):
        return await self._inner.set_checkpoint_parent(
            thread_id, checkpoint_id, parent_id
        )

    async def append_event(self, thread_id: str, event) -> int:
        return await self._inner.append_event(thread_id, event)

    async def events_after(self, thread_id: str, seq: int):
        return await self._inner.events_after(thread_id, seq)

    async def truncate_events(self, thread_id: str, after_seq: int) -> None:
        await self._inner.truncate_events(thread_id, after_seq)

    async def trim_events(self, thread_id: str, before_seq: int) -> int:
        return await self._inner.trim_events(thread_id, before_seq)

    async def latest_event_seq(self, thread_id: str) -> int:
        return await self._inner.latest_event_seq(thread_id)

    async def get_record(self, collection: str, key: str):
        return await self._inner.get_record(collection, key)

    async def list_records(self, collection: str):
        return await self._inner.list_records(collection)

    async def close(self) -> None:
        await self._inner.close()


__all__ = [
    "APPROVAL_TIMEOUT_SECONDS",
    "AUDIT_STATUS_APPLIED",
    "AUDIT_STATUS_CONFLICT",
    "AUDIT_STATUS_INVALID",
    "AUDIT_STATUS_REJECTED",
    "AUDIT_STATUS_REVERTED",
    "DEFAULT_APPROVAL_LEVELS",
    "SEGMENT_TO_KIND",
    "SET_AUDIT_COLLECTION",
    "ApplyTarget",
    "ApprovalLevel",
    "GuardedStorage",
    "L2VettingHook",
    "PatchOutcome",
    "SelfApplicationPipeline",
    "SetPatchChain",
    "patch_path",
]
