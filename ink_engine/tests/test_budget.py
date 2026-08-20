"""执行预算机制单测：策略注册/节点边界检查/异常包装 fail-closed。

语义检查点：
- 策略注册即插拔（多个维度叠加检查）；
- 策略抛 BudgetExceededError → 透传（引擎按超限终止）；
- 策略自身异常 → 包装为 BudgetExceededError（预算检查故障不能拖垮
  主流程，按超限终止留痕）；
- 无策略 = 空检查恒通过（预算未启用语义）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.budget import BudgetManager, BudgetPolicy
from ink_engine.core.exceptions import BudgetExceededError


class DemoPolicy(BudgetPolicy):
    """测试策略：节点访问计数超限即抛超限。"""

    def __init__(self, max_nodes: int = 3):
        self.max_nodes = max_nodes
        self.visited = 0

    async def check(self, ctx) -> None:
        self.visited += 1
        if self.visited > self.max_nodes:
            raise BudgetExceededError("nodes", self.max_nodes, self.visited)


async def test_budget_manager_empty_passes():
    """无策略注册 = 空检查恒通过（预算未启用语义）。"""
    manager = BudgetManager()
    await manager.check(None)  # 不抛错


async def test_budget_manager_policy_registered():
    """策略注册即生效：超限抛 BudgetExceededError（引擎按超限终止）。"""
    manager = BudgetManager()
    manager.register(DemoPolicy(max_nodes=2))
    await manager.check(None)
    await manager.check(None)
    with pytest.raises(BudgetExceededError):
        await manager.check(None)


async def test_budget_manager_multiple_policies():
    """多策略叠加：任一维度超限即终止（fail-closed 汇总）。"""
    manager = BudgetManager()
    manager.register(DemoPolicy(max_nodes=1))
    manager.register(DemoPolicy(max_nodes=5))
    await manager.check(None)
    with pytest.raises(BudgetExceededError, match="nodes"):
        await manager.check(None)


async def test_budget_manager_policy_error_wrapped():
    """策略自身异常 → 包装为 BudgetExceededError（不静默放行）。"""
    class BrokenPolicy(BudgetPolicy):
        async def check(self, ctx) -> None:
            raise RuntimeError("预算策略自身故障")

    manager = BudgetManager()
    manager.register(BrokenPolicy())
    with pytest.raises(BudgetExceededError, match="policy_error"):
        await manager.check(None)


def test_budget_exceeded_carries_details():
    """超限异常携带维度/上限/实际值（审计留痕可读）。"""
    err = BudgetExceededError("tokens", 1000, 1200)
    assert "tokens" in str(err)
    assert "1000" in str(err)
    assert "1200" in str(err)
