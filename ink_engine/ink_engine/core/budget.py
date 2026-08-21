"""执行预算检查钩子（引擎在节点边界检查并终止）。

机制在内核：引擎定义预算检查点（节点完成/边选择前调用已注册的策略），
策略由业务注册（GROUP_STEP_CAPS/tool_round_limit/字符预算等硬编码常量
改声明式配置，全局/书籍级）。策略抛 BudgetExceededError → 引擎终止本轮
并记录终止原因 budget_exceeded（入轨迹与审计）。
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


@dataclass(slots=True)
class BudgetManager:
    """预算管理器：策略注册表 + 节点边界检查入口。

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
                # 类型信息到 kind（区分「策略执行故障」与「预算超限」），仍 fail-closed
                raise BudgetExceededError(f"policy_error:{type(exc).__name__}", 0, 0) from exc


__all__ = ["BudgetManager", "BudgetPolicy"]
