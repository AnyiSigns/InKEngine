"""策略层 ContractGate：契约查闸（独立于路由）。

自 graph.py 的 Contract._satisfied/ok 与 Graph._statically_dead 逐行搬入：
声明不满足 = 零代价死路（不执行函数、不调 LLM）。数据声明 Contract 在
topology/store.py，本模块只做评估。

v3 增补 `when`（值约束）评估：requires 管"字段有没有"（存在性/析取），
when 管"字段值对不对"（如 family="code"、test_verdict="fail"）。两者分离
后才能表达"族由 classify 节点产出、产出前角色节点不可用"的契约。
requires 的旧语义（键在 state 有值即按值判定）保持不变，v2 契约零改动。
"""

from __future__ import annotations


class ContractGate:
    @staticmethod
    def _satisfied(role: str, keys: tuple[str, ...], state: dict) -> bool:
        if not keys:  # 存在性
            return state.get(role) is not None
        v = state.get(role)
        if v is not None:  # 兼容旧语义：该键本身有值 -> 值约束
            return v in keys
        return any(state.get(k) is not None for k in keys)  # 析取存在

    @staticmethod
    def _when_satisfied(field: str, vals: tuple[str, ...], state: dict) -> bool:
        v = state.get(field)
        if v is None:
            return True  # 尚未产出 -> 可满足（由 provider 后续产出）
        return v in vals

    @staticmethod
    def ok(contract, state: dict) -> bool:
        if not all(ContractGate._satisfied(r, k, state)
                   for r, k in contract.requires.items()):
            return False
        return all(ContractGate._when_satisfied(f, v, state)
                   for f, v in getattr(contract, "when", {}).items())

    @staticmethod
    def statically_dead(store, node, state: dict) -> bool:
        """静态死路（路由前过滤）：契约要求某字段，而该字段既不在当前 state、
        也没有任何存活节点能提供 —— 该节点永远不可能成功，零代价跳过。
        值约束已错配 = 不可逆，同样静态死路。"""
        c = node.contract
        if not c:
            return False
        providers = {n.contract.provides for n in store.nodes.values()
                     if n.alive and n.contract and n.contract.provides}
        for role, keys in c.requires.items():
            v = state.get(role)
            if v is not None:  # 兼容旧语义：值约束错配不可逆
                if keys and v not in keys:
                    return True
                continue
            if not keys:
                if role not in providers:
                    return True
            elif not any(k in providers for k in keys):
                return True
        for field, vals in getattr(c, "when", {}).items():
            v = state.get(field)
            if v is not None:
                if v not in vals:
                    return True  # 值错配：字段已产出且不符，不可逆
            elif field not in providers:
                return True  # 无人能产出该字段 -> 条件永远无法满足
        return False
