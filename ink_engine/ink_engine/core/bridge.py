"""宿主接线桥（op 通道）：把 agent 可调工具操作映射到引擎既有管线。

本模块是「只追加」的接线面：新增 op = 新增函数 + 注册进 :data:`OP_DISPATCH`，
既有 op 不改不动。op 与 seed tools.json 的工具声明一一对应（工具名 = op 名），
执行器由宿主按 meta.executor 注册接线。

已登记 op：
- ``propose_patch``：自指演化提案——把 agent 工具参数整理为声明式补丁
  （kind 枚举覆盖 PatchKind 全量），按类型校验后复用
  :class:`~ink_engine.core.self_application.SelfApplicationPipeline` 的
  既有审批分级（L0 直过 / L1 弹卡 / L2 沙箱验证）与补丁链（vetting /
  落链 / 回退全部走既有实现，零重复发明），返回审批结果数据形态。
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .self_application import SelfApplicationPipeline

# op 派发表（工具名 → 处理函数；只追加不修改）
OP_DISPATCH: dict[str, Callable[..., Awaitable[dict[str, Any]]]] = {}


def register_op(name: str, fn: Callable[..., Awaitable[dict[str, Any]]]) -> None:
    """登记 op 处理函数（同名重复登记 = 显式拒绝，防静默覆盖）。"""
    if name in OP_DISPATCH:
        raise ValueError(f"op 重复登记: {name!r}（接线面只追加）")
    OP_DISPATCH[name] = fn


def op_names() -> tuple[str, ...]:
    """已登记 op 名清单（观察侧；与工具声明对齐校验用）。"""
    return tuple(sorted(OP_DISPATCH))


async def propose_patch(
    pipeline: SelfApplicationPipeline,
    params: dict[str, Any],
    *,
    ctx: Any = None,
    round_id: str | None = None,
) -> dict[str, Any]:
    """自指演化提案 op：参数 → 声明式补丁 → 既有审批链 → 结果数据。

    Args:
        pipeline: 自指应用管线（宿主注入；审批分级 / 补丁链 / 审计全部
            复用既有实现）。
        params: 工具参数（kind/payload/base_version/rationale）。
        ctx: 回合中断上下文（审批弹卡/注入用；宿主按回合接线）。
        round_id: 回合标识（审计留痕透传）。

    Returns:
        审批结果数据形态（patch_id/decision/status/reason/applied/
        apply_error 与引擎 PatchOutcome 同源）。
    """
    from .exceptions import GraphDefinitionError
    from .self_application import PatchOutcome
    from .self_proposal import PatchKind, SelfProposal

    raw_kind = params.get("kind")
    payload = params.get("payload")
    if not isinstance(raw_kind, str) or not isinstance(payload, dict):
        return _outcome_dict(
            PatchOutcome(
                decision="reject",
                status="invalid",
                reason="propose_patch 参数非法：kind（字符串枚举）与 payload（dict）必填",
            )
        )
    try:
        # 未知类型显式拒绝（不挂卡不落链）
        kind = PatchKind(raw_kind)
    except ValueError as exc:
        return _outcome_dict(
            PatchOutcome(decision="reject", status="invalid", reason=str(exc))
        )
    try:
        proposal = SelfProposal(
            kind=kind,
            payload=payload,
            base_version=int(params.get("base_version") or 1),
            rationale=str(params.get("rationale") or ""),
        )
    except GraphDefinitionError as exc:
        return _outcome_dict(
            PatchOutcome(decision="reject", status="invalid", reason=str(exc))
        )
    outcome = await pipeline.apply(ctx, proposal, round_id=round_id)
    return _outcome_dict(outcome)


def _outcome_dict(outcome: Any) -> dict[str, Any]:
    """审批结果 → 数据形态（与引擎 PatchOutcome 字段一一对应）。"""
    return {
        "patch_id": getattr(outcome, "patch_id", None),
        "decision": getattr(outcome, "decision", "reject"),
        "status": getattr(outcome, "status", "rejected"),
        "reason": getattr(outcome, "reason", None),
        "applied": bool(getattr(outcome, "applied", False)),
        "apply_error": getattr(outcome, "apply_error", None),
    }


register_op("propose_patch", propose_patch)


__all__ = [
    "OP_DISPATCH",
    "op_names",
    "propose_patch",
    "register_op",
]
