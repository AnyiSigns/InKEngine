"""演化收敛管制域（数据驱动：review.json 收敛配置 → ConvergenceHook）。

收敛管制 = 演化方向的前置闸门（引擎 ConvergenceHook 协议，宿主实现
assess 语义）：同一演化目标（补丁类型 × 落点路径）在近期审计窗口内
的变更次数达到收敛上限（review.json max_rounds）后进入冷却期——目标
冻结，AI 据此换方向而非反复撞闸（演化不收敛 = 反复折腾同一目标）。

数据来源 = 评审配置（max_rounds：评审轮次上限的演化侧复用——评审
与演化共用同一「有界收敛」语义：反复折腾有限次后必须换方向/收口）。

冷却判定基于集演化审计（append-only，历史不撒谎）：记录即证据，回退
不删记录——被回退的目标同样计入变更次数（折腾过就是折腾过）。
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ink_engine.core.self_application import patch_path
from ink_engine.core.self_proposal import PatchKind

# 审计扫描窗口（与自指工具 propose_patch 的前置扫描同量级：只看近期
# 记录，防长跑审计膨胀拖慢冷却判定）
_AUDIT_SCAN_LIMIT = 100


@dataclass(frozen=True, slots=True)
class ConvergenceAssessment:
    """收敛判定结果（ConvergenceHook 鸭子协议的 Assessment 形态）。

    Attributes:
        allowed: True = 放行提案；False = 目标处于冷却期，拒绝。
        state: 判定状态（ok = 正常放行；cooling = 冷却期拒绝）。
        target: 命中的演化目标键（类型 × 落点路径，可读可审计）。
        reason: 判定说明（冷却时含恢复条件，AI 据此换策略）。
    """

    allowed: bool
    state: str = "ok"
    target: str = ""
    reason: str = ""


class DataConvergenceHook:
    """数据驱动收敛管制钩子：同目标近期变更 ≥ max_rounds → 冷却拒绝。

    assess 语义（引擎协议）：records = 集演化审计（audit_log 产物）、
    kind/payload = 提案的类型与内容——同目标计数含被回退的变更（审计
    append-only，历史不撒谎）。
    """

    def __init__(self, max_rounds: int = 2) -> None:
        self.max_rounds = max_rounds

    async def assess(
        self, records: list[dict[str, Any]], kind: Any, payload: dict[str, Any]
    ) -> ConvergenceAssessment:
        target = _target_key(kind, payload)
        touched = sum(
            1
            for record in records[-_AUDIT_SCAN_LIMIT:]
            if record.get("kind") == _kind_value(kind)
            and _target_key_from_record(record) == target
        )
        if touched >= self.max_rounds:
            return ConvergenceAssessment(
                allowed=False,
                state="cooling",
                target=target,
                reason=(
                    f"目标 {target} 近期变更 {touched} 次（收敛上限 "
                    f"{self.max_rounds}，见评审收敛配置）——冷却期拒绝，"
                    "请换方向或等收敛窗口重置"
                ),
            )
        return ConvergenceAssessment(allowed=True, state="ok", target=target)

    def __repr__(self) -> str:  # pragma: no cover - 调试可读性
        return f"DataConvergenceHook(max_rounds={self.max_rounds})"


def build_convergence_provider(
    review_data: dict[str, Any],
) -> Callable[[], DataConvergenceHook | None]:
    """review.json → 收敛钩子提供者（配方 convergence_provider 数据形态）。

    数据源 = 评审收敛配置（max_rounds）；数据缺失/非法 = 回落引擎默认
    （2 次），不击穿装配。
    """

    def provider() -> DataConvergenceHook:
        raw = int(review_data.get("max_rounds") or 2)
        return DataConvergenceHook(max_rounds=max(raw, 1))

    return provider


def _kind_value(kind: Any) -> str:
    if isinstance(kind, PatchKind):
        return kind.value
    return str(kind)


def _as_kind(kind: Any) -> PatchKind | None:
    """补丁类型归一化（工具路径传字符串、管线路径传枚举——统一枚举）。"""
    if isinstance(kind, PatchKind):
        return kind
    try:
        return PatchKind(str(kind))
    except ValueError:
        return None


def _target_key(kind: Any, payload: dict[str, Any]) -> str:
    """提案 → 演化目标键（补丁类型 × 落点路径；payload 非法 = 类型级键）。

    复用补丁落点推导（patch_path）——目标键与链路径同源，冷却判定与
    链落点不会两套口径。
    """
    normalized = _as_kind(kind)
    if normalized is None:
        return f"{_kind_value(kind)}/*"
    try:
        path, _value = patch_path(normalized, payload)
        return "/".join(str(segment) for segment in path)
    except Exception:
        return f"{normalized.value}/*"


def _target_key_from_record(record: dict[str, Any]) -> str:
    """审计记录 → 演化目标键（记录 kind/payload 重算，与提案同口径）。"""
    raw_kind = record.get("kind")
    payload = record.get("payload")
    if not isinstance(raw_kind, str) or not isinstance(payload, dict):
        return ""
    kind = _as_kind(raw_kind)
    if kind is None:
        return ""
    return _target_key(kind, payload)


__all__ = [
    "ConvergenceAssessment",
    "DataConvergenceHook",
    "build_convergence_provider",
]
