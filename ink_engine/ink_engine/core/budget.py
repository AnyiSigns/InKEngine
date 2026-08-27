"""执行预算检查钩子（引擎在节点边界检查并终止）。

机制在内核：引擎定义预算检查点（节点完成/边选择前调用已注册的策略），
策略由业务注册（GROUP_STEP_CAPS/tool_round_limit/字符预算等硬编码常量
改声明式配置，全局/书籍级）。策略抛 BudgetExceededError → 引擎终止本轮
并记录终止原因 budget_exceeded（入轨迹与审计）。

预算余量只读查询（评审决议下沉）：``BudgetManager.query_remaining``
提供只读预检口——现状 ``check`` 为 fail-closed 终止式无查询口；预检
语义 fail-closed（查询故障/超预算 = 不可放行，见 ``can_afford``）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .exceptions import BudgetExceededError


@runtime_checkable
class BudgetPolicy(Protocol):
    """预算策略接口：业务实现并注册，引擎在节点边界调用。

    实现示例：``async def check(ctx): if ctx.step_count >= 10: raise
    BudgetExceededError("steps", 10, ctx.step_count)``
    """

    async def check(self, ctx: Any) -> None: ...


@dataclass(frozen=True, slots=True)
class BudgetRemaining:
    """单个预算维度的余量只读结果（预检输入；查询故障 = 不可用）。

    Attributes:
        policy: 预算维度名（策略身份，审计可读）。
        limit: 预算上限（0 = 不可用维度）。
        used: 已用量。
        remaining: 余量（limit - used；不可用 = 0）。
        unavailable: 查询故障/维度无余量概念（fail-closed：余量视为 0）。
    """

    policy: str
    limit: float
    used: float
    remaining: float
    unavailable: bool = False


@runtime_checkable
class BudgetQuery(Protocol):
    """预算余量只读查询接口（策略可选的第二协议；不要求实现）。

    与 ``check`` 的分工：check = 终止式硬检查（超限抛异常）；remaining =
    只读预检（不抛异常、不影响执行）。实现 check 的策略可同时实现
    remaining 提供余量口。
    """

    async def remaining(self, ctx: Any) -> BudgetRemaining | None: ...


@dataclass(slots=True)
class BudgetManager:
    """预算管理器：策略注册表 + 节点边界检查入口 + 余量只读查询。

    注册 = 插拔 U 盘：新增预算维度 = 注册新策略类，引擎核心零改动。
    """

    policies: list[BudgetPolicy] = field(default_factory=list)

    def register(self, policy: BudgetPolicy) -> None:
        self.policies.append(policy)

    async def check(self, ctx: Any) -> None:
        """执行全部已注册策略（fail-closed：策略异常包装为 BudgetExceededError 终止）。"""
        for policy in self.policies:
            try:
                await policy.check(ctx)
            except BudgetExceededError:
                raise
            except Exception as exc:
                # 预算策略自身故障不能拖垮主流程：按超限终止并保留原始异常
                # 类型信息到 kind（区分「策略执行故障」与「预算超限」），
                # 原始异常消息并入 reason 便于宿主直接定位故障策略，
                # 仍 fail-closed
                raise BudgetExceededError(
                    f"policy_error:{type(exc).__name__}", 0, 0, detail=str(exc)
                ) from exc

    async def query_remaining(self, ctx: Any) -> tuple[BudgetRemaining, ...]:
        """预算余量只读查询（不抛异常：预检不得影响执行）。

        只对实现 :class:`BudgetQuery` 的策略取余量；查询故障 = 该维度
        标记不可用（fail-closed：余量视为 0，见 :func:`can_afford`）。
        """
        results: list[BudgetRemaining] = []
        for policy in self.policies:
            query = getattr(policy, "remaining", None)
            if query is None:
                continue
            try:
                result = await query(ctx)
            except Exception:
                results.append(
                    BudgetRemaining(
                        policy=type(policy).__name__,
                        limit=0.0,
                        used=0.0,
                        remaining=0.0,
                        unavailable=True,
                    )
                )
                continue
            if result is not None:
                results.append(result)
        return tuple(results)


def can_afford(results: tuple[BudgetRemaining, ...], cost: float) -> bool:
    """预算预检（fail-closed 引擎强制）：够付才放行。

    - 无预算维度 → 放行（未启用预算语义）；
    - 任一维度查询不可用 → 拒绝（无法确认余量 = 不得放行）；
    - 否则 cost ≤ 最小余量才放行。
    """
    if not results:
        return True
    if any(r.unavailable for r in results):
        return False
    return cost <= min(r.remaining for r in results)


__all__ = [
    "BudgetManager",
    "BudgetPolicy",
    "BudgetQuery",
    "BudgetRemaining",
    "can_afford",
]
