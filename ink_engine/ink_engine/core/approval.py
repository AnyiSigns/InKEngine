"""工具调用前挂卡审批的标准辅助。

审批唯一性原则的「唯一标准姿势」：宿主不得另写"工具调用前挂卡"实现——
本模块提供机制化封装：

- :func:`approve_before_execute`：单动作挂卡——interrupt 挂起 gate 卡 →
  注入决议（accept/edit/reject/terminate）→ 返回决议，宿主按决议执行/跳过/终止；
- :func:`approve_batch`：同回合多写操作聚合一张卡（合并卡，仍是 gate 卡形态）；
- :class:`InterruptPolicy` / :class:`DefaultInterruptPolicy`：决议策略钩子
  （auto-approve 直过、审批超时窗口；默认全挂起 + 不限时，宿主可替换）。

机制定在 core、语义归属审批卡协议（`review_card` 四类卡）——
不绑领域语义、跨域共用；挂起/重入走引擎 interrupt 原语（`core/interrupt.py`），
本模块不引入第二套挂起语义。

决议集合（对应注入值）：
- accept：按原动作执行；
- edit：用 edited_content 替换后执行（注入须带 edited_content）；
- reject：跳过执行（fail-closed 默认方向）；
- terminate：宿主终止本轮（宿主以 ctx.terminate 表达终止原因）；
- auto：策略直过（should_approve=False，不挂起，来源=policy）。

超时默认拒绝：policy.timeout_for 给出审批窗口（None = 不限时，默认），
挂起负载写入 expires_at（epoch 秒）；重入时已过期 → 一律返回 reject
（source=expired）——fail-closed 兜底，防"超时后补批"绕过。

取消语义（打断重定向）：挂起卡随 interrupt checkpoint 持久化，与执行中
新消息 cancel 语义互不干扰——卡保留可后批，重入仅由 inject 触发（引擎
既有语义，本模块不引入新状态）。
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from .logging import get_logger

logger = get_logger(__name__)

DECISION_ACCEPT = "accept"
DECISION_EDIT = "edit"
DECISION_REJECT = "reject"
DECISION_TERMINATE = "terminate"
DECISION_AUTO = "auto"

VALID_DECISIONS: tuple[str, ...] = (
    DECISION_ACCEPT,
    DECISION_EDIT,
    DECISION_REJECT,
    DECISION_TERMINATE,
    DECISION_AUTO,
)


@dataclass(frozen=True, slots=True)
class ApprovalDecision:
    """单动作的审批决议（宿主按决议执行/跳过/终止）。

    Attributes:
        decision: accept / edit / reject / terminate / auto。
        action: 对应动作（approve_batch 时逐条对应）。
        edited_content: edit 决议的替换内容（注入透传；其余决议为 None）。
        reason: reject/terminate 的原因（注入透传或超时/非法标记）。
        source: 决议来源（policy=策略直过 / inject=注入 / expired=超时
            默认拒绝 / invalid=注入值非法 fail-closed）。
    """

    decision: str
    action: dict
    edited_content: Any = None
    reason: str | None = None
    source: str = "inject"


class InterruptPolicy(Protocol):
    """决议策略钩子（可替换；默认实现见 :class:`DefaultInterruptPolicy`）。

    宿主按需定制：auto-approve 开关、按工具/卡类型放行、超时窗口。
    """

    def should_approve(self, key: str, action: dict) -> bool:
        """是否需挂起审批；False = 直过（决议 auto，不挂起）。"""
        ...

    def timeout_for(self, key: str, action: dict) -> float | None:
        """审批超时秒数（None = 不限时）；挂起负载据此写 expires_at。"""
        ...


@dataclass(frozen=True, slots=True)
class DefaultInterruptPolicy:
    """默认决议策略：全量挂起 + 可选直过名单 + 可选统一超时窗口。

    默认值由宿主构造时配置（auto-approve 的 key/工具集、超时秒数）；
    不配置 = 全挂起、不限时（最保守 fail-closed）。
    """

    auto_approve_keys: frozenset[str] = frozenset()
    auto_approve_tools: frozenset[str] = frozenset()
    timeout: float | None = None

    def should_approve(self, key: str, action: dict) -> bool:
        if key in self.auto_approve_keys:
            return False
        tool = action.get("tool") if isinstance(action, dict) else None
        return tool not in self.auto_approve_tools

    def timeout_for(self, key: str, action: dict) -> float | None:
        return self.timeout


async def approve_before_execute(
    ctx: Any,
    key: str,
    action: dict,
    payload: dict | None = None,
    policy: InterruptPolicy | None = None,
    *,
    clock: Callable[[], float] | None = None,
) -> ApprovalDecision:
    """单动作挂卡审批的标准姿势（gate 卡包装，宿主按决议执行/跳过/终止）。

    Args:
        ctx: 节点上下文（interrupt 原语入口，鸭子类型）。
        key: 中断点 key（与注入值对齐；同回合多动作请用 approve_batch）。
        action: 动作描述（{tool, args, summary, diff, ...}——渲染与策略
            分级判定用，宿主自定形态）。
        payload: gate 卡负载（宿主构造；缺省从 action 生成最小卡）。
            挂起负载 = payload 增强：review_type=gate + action + expires_at。
        policy: 决议策略钩子（默认 DefaultInterruptPolicy()：全挂起、不限时）。
        clock: 时钟注入（默认 time.time；测试可控，用于超时判定）。

    Returns:
        ApprovalDecision：宿主按决议执行（accept/edit）/ 跳过（reject）/
        终止（terminate）/ 直过（auto，source=policy）。
    """
    policy = policy or DefaultInterruptPolicy()
    clock = clock or time.time
    if not policy.should_approve(key, action):
        return ApprovalDecision(decision=DECISION_AUTO, action=action, source="policy")
    card = _build_gate_card(action, payload)
    timeout = policy.timeout_for(key, action)
    # 重入读回已挂卡的超时窗口（持久化在中断 checkpoint 的卡负载）：挂起
    # 时写入的 expires_at 才是超时判定的权威时钟——重算（now+timeout）会让
    # "超时默认拒绝"永不触发（重入时 now 恒小于 now+timeout），超时后补批
    # 照样通过。链尾无挂起卡（首次挂起/无存储）时按策略写 expires_at。
    saved_expires = None
    get_payload = getattr(ctx, "get_interrupt_payload", None)
    if get_payload is not None:
        saved = await get_payload(key)
        if isinstance(saved, dict):
            saved_expires = saved.get("expires_at")
    if saved_expires is not None:
        card["expires_at"] = saved_expires
    elif timeout is not None:
        card["expires_at"] = clock() + timeout
    injected = await ctx.interrupt(key, card)
    decision, contents, reason, source = _resolve_decision(
        injected, clock(), card, batch_count=None
    )
    return ApprovalDecision(
        decision=decision,
        action=action,
        edited_content=contents[0] if contents else None,
        reason=reason,
        source=source,
    )


async def approve_batch(
    ctx: Any,
    key: str,
    actions: list[dict],
    payload: dict | None = None,
    policy: InterruptPolicy | None = None,
    *,
    clock: Callable[[], float] | None = None,
) -> list[ApprovalDecision]:
    """同回合多写操作聚合一张卡（合并卡，仍是 gate 卡形态，宿主可选）。

    单次挂起（key 一次）；任一动作需审批 → 整批挂起，注入一个决议作用于
    全部动作（混合直过/挂起由宿主策略层保证 tool 判定一致性）：
    - accept：全部执行；
    - edit：注入 edited_contents（列表，与 actions 对齐）逐条替换；
    - reject / terminate：全部跳过 / 宿主终止；
    - 全部 auto（策略直过）：整批不挂起，逐条返回 auto。

    Args:
        ctx: 节点上下文（interrupt 原语入口，鸭子类型）。
        key: 中断点 key（合并卡挂起一次，注入对齐）。
        actions: 动作列表（每项与 approve_before_execute 的 action 同形态）。
        payload: gate 卡负载（宿主构造；缺省从 actions 生成最小卡）。
        policy: 决议策略钩子（默认全挂起、不限时）。
        clock: 时钟注入（默认 time.time；测试可控）。
    """
    policy = policy or DefaultInterruptPolicy()
    clock = clock or time.time
    if not any(policy.should_approve(key, action) for action in actions):
        return [
            ApprovalDecision(decision=DECISION_AUTO, action=a, source="policy")
            for a in actions
        ]
    card = _build_batch_card(actions, payload)
    timeouts = [policy.timeout_for(key, a) for a in actions]
    shortest = min((t for t in timeouts if t is not None), default=None)
    # 重入读回已挂卡的超时窗口（与 approve_before_execute 同语义：
    # 挂起时的 expires_at 才是超时判定的权威时钟）
    saved_expires = None
    get_payload = getattr(ctx, "get_interrupt_payload", None)
    if get_payload is not None:
        saved = await get_payload(key)
        if isinstance(saved, dict):
            saved_expires = saved.get("expires_at")
    if saved_expires is not None:
        card["expires_at"] = saved_expires
    elif shortest is not None:
        card["expires_at"] = clock() + shortest
    injected = await ctx.interrupt(key, card)
    decision, contents, reason, source = _resolve_decision(
        injected, clock(), card, batch_count=len(actions)
    )
    return [
        ApprovalDecision(
            decision=decision,
            action=a,
            edited_content=contents[i] if contents else None,
            reason=reason,
            source=source,
        )
        for i, a in enumerate(actions)
    ]


def _build_gate_card(action: dict, payload: dict | None) -> dict:
    """动作 → gate 卡（宿主 payload 优先，缺省字段从 action 补全）。"""
    card = dict(payload) if payload else {}
    card.setdefault("review_type", "gate")
    card.setdefault("node_id", str(action.get("tool") or "approval"))
    card.setdefault("node_label", str(action.get("tool") or "approval"))
    card.setdefault("action", dict(action))
    if "output_preview" not in card:
        card["output_preview"] = str(action.get("diff") or action.get("summary") or "")
    return card


def _build_batch_card(actions: list[dict], payload: dict | None) -> dict:
    """动作列表 → 合并卡（仍是 gate 卡形态，actions 列表供单卡渲染 diff 列表）。"""
    card = dict(payload) if payload else {}
    card.setdefault("review_type", "gate")
    card.setdefault("node_id", "approval_batch")
    card.setdefault("node_label", "批量审批")
    card.setdefault("actions", [dict(a) for a in actions])
    if "output_preview" not in card:
        card["output_preview"] = "\n".join(
            f"- {a.get('tool')}: {a.get('summary') or a.get('diff') or ''}"
            for a in actions
        )
    return card


def _resolve_decision(
    injected: Any,
    now: float,
    card: dict,
    *,
    batch_count: int | None,
) -> tuple[str, list | None, str | None, str]:
    """注入值 → (decision, contents, reason, source)（单动作与合并卡共用）。

    batch_count=None = 单动作（edit 需 edited_content 单值）；
    batch_count=N = 合并卡（edit 需 edited_contents 列表对齐 N）。
    超时/非法注入一律回落 reject（fail-closed）。
    """
    expires_at = card.get("expires_at")
    if isinstance(expires_at, (int, float)) and now > expires_at:
        return DECISION_REJECT, None, "审批已超时，默认拒绝", "expired"
    if isinstance(injected, str):
        # 字符串形态与 dict 形态同口径：auto 属策略直过来源，外部注入
        # 不得以字符串 "auto" 伪装直过（dict 分支已拒绝，此处对齐）
        if injected not in VALID_DECISIONS or injected in (DECISION_EDIT, DECISION_AUTO):
            return DECISION_REJECT, None, f"注入值非法: {injected!r}", "invalid"
        return injected, None, None, "inject"
    if isinstance(injected, dict):
        decision = injected.get("decision")
        if decision not in VALID_DECISIONS or decision == DECISION_AUTO:
            return DECISION_REJECT, None, f"注入值非法: {injected!r}", "invalid"
        if decision == DECISION_EDIT:
            if batch_count is None:
                if "edited_content" not in injected:
                    return (
                        DECISION_REJECT,
                        None,
                        "edit 决议需 edited_content",
                        "invalid",
                    )
                return (
                    decision,
                    [injected["edited_content"]],
                    injected.get("reason"),
                    "inject",
                )
            contents = injected.get("edited_contents")
            if not isinstance(contents, list) or len(contents) != batch_count:
                return (
                    DECISION_REJECT,
                    None,
                    "edit 决议需 edited_contents 与动作数对齐",
                    "invalid",
                )
            return decision, contents, injected.get("reason"), "inject"
        return decision, None, injected.get("reason"), "inject"
    return DECISION_REJECT, None, f"注入值非法: {injected!r}", "invalid"


__all__ = [
    "DECISION_ACCEPT",
    "DECISION_AUTO",
    "DECISION_EDIT",
    "DECISION_REJECT",
    "DECISION_TERMINATE",
    "VALID_DECISIONS",
    "ApprovalDecision",
    "DefaultInterruptPolicy",
    "InterruptPolicy",
    "approve_batch",
    "approve_before_execute",
]
