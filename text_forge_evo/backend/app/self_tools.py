"""自指元工具：提案/应用/回退（观察之后的演化通道）。

观察工具让 AI 看清自己；这三把工具让 AI 合法地修改产品形态——
提案（propose_patch）校验形态与基准版本但不落链；应用（apply_patch）
走完整管线（校验 → 审批分级 → 补丁链落库 → 活跃态生效），L1/L2
挂卡等待用户决议；回退（revert_patch）仅允许链尾补丁，同样须审批。
全部输出为 JSON 文本（工具流水线结果契约），供 AI 回合内决策。

权限形态：``self:propose:*``（提案）/ ``self:apply:*``（应用与回退）——
自定义权限域，经 PermissionGate fail-closed 判定；审批分级在应用
管线内完成（approve_before_execute），工具流水线不做二次挂卡。
"""
from __future__ import annotations

import json
from typing import Any

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.permissions import PermissionGate
from ink_engine.core.self_application import SelfApplicationPipeline
from ink_engine.core.self_proposal import PatchKind, SelfProposal
from ink_engine.core.tool_pipeline import ToolPipeline

# 权限声明（自定义域：self:propose / self:apply）
PERMISSION_PROPOSE = "self:propose:*"
PERMISSION_APPLY = "self:apply:*"

# 判定动作（与权限声明的 action 配对）
_OPERATION_PROPOSE = "propose"
_OPERATION_APPLY = "apply"
_OPERATION_REVERT = "revert"

# 结果文本截断上限（与引擎工具流水线默认一致）
_MAX_RESULT_CHARS = 100_000


def self_tool_specs() -> list[ToolSpec]:
    """自指元工具的工具描述清单（注册进引擎工具表走标准流水线）。"""
    return [
        ToolSpec(
            name="propose_patch",
            description="提出产品演化补丁（只校验不落链）：按类型校验 payload 形态与"
            "基准版本，返回校验结果与当前集版本——合法提案的下一步是 apply_patch",
            parameters={
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": [k.value for k in PatchKind],
                        "description": "补丁类型（ui/theme/tool/rule/knowledge/"
                        "harness/event_type/environment/artifact）",
                    },
                    "payload": {
                        "type": "object",
                        "description": "补丁内容（按类型校验：界面描述/工具定义/"
                        "规则声明/知识条目/harness 定义/事件类型/环境声明/产物声明）",
                    },
                    "rationale": {
                        "type": "string",
                        "description": "提案理由（审批卡展示与审计留痕）",
                    },
                },
                "required": ["kind", "payload"],
            },
            permissions=(PERMISSION_PROPOSE,),
        ),
        ToolSpec(
            name="apply_patch",
            description="应用演化补丁：校验 → 审批分级（L0 直过/L1 弹卡/L2 沙箱验证"
            "+人工）→ 补丁链落库 → 活跃态生效；审批卡等待用户决议时回合挂起",
            parameters={
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": [k.value for k in PatchKind],
                        "description": "补丁类型（与 propose_patch 同口径）",
                    },
                    "payload": {
                        "type": "object",
                        "description": "补丁内容（与 propose_patch 同口径）",
                    },
                    "base_version": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "提案时的集版本（缺省 = 当前版本；"
                        "基准不匹配 = 并发冲突，拒绝并要求重提）",
                    },
                    "rationale": {
                        "type": "string",
                        "description": "提案理由（审批卡展示与审计留痕）",
                    },
                },
                "required": ["kind", "payload"],
            },
            permissions=(PERMISSION_APPLY,),
        ),
        ToolSpec(
            name="revert_patch",
            description="回退已应用补丁（仅链尾，须审批）：回退后集状态回到目标版本，"
            "审计保留完整历史（append-only）",
            parameters={
                "type": "object",
                "properties": {
                    "patch_id": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "要回退的补丁版本号（须为当前链尾）",
                    },
                    "reason": {
                        "type": "string",
                        "description": "回退原因（审计留痕）",
                    },
                },
                "required": ["patch_id"],
            },
            permissions=(PERMISSION_APPLY,),
        ),
    ]


def _operation_of(spec: ToolSpec) -> tuple[str, str]:
    """操作提取：按工具名定动作（propose/apply/revert × patch 目标）。"""
    if spec.name == "propose_patch":
        return (_OPERATION_PROPOSE, "patch")
    if spec.name in ("apply_patch", "revert_patch"):
        return (_OPERATION_APPLY, "patch")
    return (_OPERATION_PROPOSE, "patch")


def make_self_executor(
    pipeline: SelfApplicationPipeline, app_getter: Any
) -> Any:
    """自指工具执行器（统一流水线分发用；ctx/spec/args/approval → 文本）。"""

    async def executor(ctx: Any, spec: ToolSpec, args: dict, approval: Any) -> str:
        app = app_getter()
        if spec.name == "propose_patch":
            return await _propose(ctx, app, args)
        if spec.name == "apply_patch":
            return await _apply(ctx, app, args)
        if spec.name == "revert_patch":
            return await _revert(ctx, app, args)
        raise GraphDefinitionError(f"未知自指工具: {spec.name}")

    return executor


def build_self_pipeline(
    pipeline: SelfApplicationPipeline,
    app_getter: Any,
    *,
    gate: PermissionGate | None = None,
) -> ToolPipeline:
    """装配自指元工具流水线（权限门禁 fail-closed + 执行器分发）。

    gate 缺省为 fail-closed 的 PermissionGate——工具声明了
    ``self:propose:*`` / ``self:apply:*`` 权限即可直过；未声明/未命中
    权限的工具调用被拒绝并留痕。审批分级在应用管线内完成，工具
    流水线不做二次挂卡。
    """
    return ToolPipeline(
        gate=gate or PermissionGate(),
        extractor=_operation_of,
        executor=make_self_executor(pipeline, app_getter),
        max_result_chars=_MAX_RESULT_CHARS,
    )


async def _propose(ctx: Any, app: Any, args: dict) -> str:
    """提案校验：形态非法/未知类型显式报错，合法返回集版本供应用用。"""
    try:
        proposal = _build_proposal(ctx, args, base_version_hint=None)
    except GraphDefinitionError as exc:
        return _json({"ok": False, "violations": [str(exc)]})
    violations = app.self_pipeline.validator.validate(proposal)
    if violations:
        return _json({"ok": False, "violations": violations})
    return _json(
        {
            "ok": True,
            "kind": proposal.kind.value,
            "violations": [],
            "current_version": await app.self_pipeline.chain.current_version(),
            "hint": "调用 apply_patch 应用本提案（base_version = 上述 current_version）",
        }
    )


async def _apply(ctx: Any, app: Any, args: dict) -> str:
    """应用提案：完整管线（校验 → 审批分级 → 落链 → 活跃态生效）。"""
    try:
        proposal = _build_proposal(ctx, args, base_version_hint=args.get("base_version"))
    except GraphDefinitionError as exc:
        return _json({"ok": False, "status": "invalid", "reason": str(exc)})
    outcome = await app.self_pipeline.apply(ctx, proposal)
    return _json(
        {
            "ok": outcome.applied,
            "status": outcome.status,
            "decision": outcome.decision,
            "patch_id": outcome.patch_id,
            "reason": outcome.reason,
        }
    )


async def _revert(ctx: Any, app: Any, args: dict) -> str:
    """回退链尾补丁（审批确认后落地，审计保留历史）。"""
    try:
        patch_id = int(args["patch_id"])
    except (KeyError, TypeError, ValueError):
        return _json({"ok": False, "status": "invalid", "reason": "patch_id 须为整数"})
    try:
        outcome = await app.self_pipeline.revert(
            ctx, patch_id, reason=str(args.get("reason") or "")
        )
    except GraphDefinitionError as exc:
        return _json({"ok": False, "status": "rejected", "reason": str(exc)})
    return _json(
        {
            "ok": outcome.status == "reverted",
            "status": outcome.status,
            "decision": outcome.decision,
            "patch_id": patch_id,
            "reason": outcome.reason,
        }
    )


def _build_proposal(ctx: Any, args: dict, *, base_version_hint: Any) -> SelfProposal:
    """从工具入参构造提案（类型/形态非法显式报错）。"""
    raw_kind = args.get("kind")
    try:
        kind = PatchKind(raw_kind)
    except ValueError as exc:
        raise GraphDefinitionError(
            f"补丁类型非法: {raw_kind!r}（仅 {[k.value for k in PatchKind]}）"
        ) from exc
    payload = args.get("payload")
    if not isinstance(payload, dict):
        raise GraphDefinitionError("payload 须为对象（dict）")
    if base_version_hint is None:
        base_version = 1  # propose 阶段不校验基准（仅形态校验）
    else:
        try:
            base_version = int(base_version_hint)
        except (TypeError, ValueError) as exc:
            raise GraphDefinitionError("base_version 须为整数") from exc
    return SelfProposal(
        kind=kind,
        payload=payload,
        base_version=base_version,
        rationale=str(args.get("rationale") or ""),
        meta={"round_id": getattr(ctx, "round_id", None)},
    )


def _json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False)


__all__ = [
    "PERMISSION_APPLY",
    "PERMISSION_PROPOSE",
    "build_self_pipeline",
    "make_self_executor",
    "self_tool_specs",
]
