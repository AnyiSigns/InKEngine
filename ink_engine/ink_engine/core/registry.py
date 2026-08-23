"""节点类型 / 边条件注册表：按名解析的声明式图定义来源。

图节点可以不经注册表直接以函数形式挂载（Graph.add_node），注册表面向
「声明式规格驱动实例化」的场景：画布/清单里的节点只携带类型名与配置，
建图时按类型解析工厂、把配置透传给工厂生成节点执行函数——同一类型
不同配置实例化出互不干扰的节点；条件边同理，判定函数按条件名解析。

语义边界：类型名/条件名是不透明字符串，注册表不解释任何含义；哪些
名字存在、如何构造执行/判定函数，全部由注册方（宿主/领域包）决定。
重复注册视为编程错误（覆盖会静默替换既有语义），建图期显式拒绝。

节点工厂生命周期契约（跨引擎重建的实时性）：类型只注册一次（重复
登记拒绝），工厂与其产出的节点执行函数可跨引擎重建存活——工厂
**禁止捕获装配期可变状态快照**（工具表/流水线/装配源等随挂载/补丁
演化而变化的装配产物）。正确形态 = 实时引用：以 registry 实例为键
持有最新装配源（WeakKeyDictionary 惯用法），节点执行时现取，重建后
新装配源对既有节点立即可见。快照闭包 = 重建后节点读到过期装配源
（见 runtime.py GraphRecipeContext 契约）。
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .contracts import NodeContract
from .exceptions import GraphDefinitionError
from .graph import EdgeCondition, NodeFn

# 节点工厂签名：节点配置（声明式规格中的 config 字段透传）→ 节点执行函数。
# 执行函数签名与 Graph.add_node 一致（async (ctx) -> 增量 dict | None）。
# 生命周期契约：工厂禁止捕获装配期可变状态快照，须用实时引用
# （以 registry 实例为键的持有者现取）——类型注册一次、跨引擎重建存活。
NodeFactory = Callable[[dict[str, Any]], NodeFn]


class NodeTypeRegistry:
    """节点类型注册表（进程内单表，注册方在建图前完成登记）。

    线程安全说明：注册通常发生在启动装配期（单线程），解析发生在建图期
    （可并发）；解析只读 dict 无写冲突，无需加锁。注册表支持多个实例
    （宿主可为不同图域各自建表，互不干扰），模块级单例只是惯例用法。

    契约登记：类型可随注册携带结点契约（可选参数，旧调用形态不变）；
    契约是数据（随类型登记，供契约查询与链接校验的版本存在性判定），
    不参与节点实例化——无契约类型 = 无契约结点（不参与组装，仅可被
    手绘图引用，旧行为零破坏）。
    """

    def __init__(self) -> None:
        self._factories: dict[str, NodeFactory] = {}
        self._contracts: dict[str, NodeContract] = {}

    def register(
        self,
        type_name: str,
        factory: NodeFactory,
        contract: NodeContract | None = None,
    ) -> None:
        """登记类型 → 工厂（重复登记抛 GraphDefinitionError，防静默覆盖）。

        Args:
            type_name: 类型名（不透明字符串，注册表不解释含义）。
            factory: 节点工厂（配置 → 节点执行函数）。
            contract: 结点契约（可选；缺省 = 无契约结点，不参与组装，
                仅可被手绘图引用——旧调用形态完全不变）。
        """
        if type_name in self._factories:
            raise GraphDefinitionError(f"节点类型重复注册: {type_name}")
        self._factories[type_name] = factory
        if contract is not None:
            self._contracts[type_name] = contract

    def create(self, type_name: str, config: dict[str, Any] | None = None) -> NodeFn:
        """按类型名实例化节点执行函数（未知类型抛 GraphDefinitionError）。

        配置经浅拷贝透传工厂：同一工厂被多个节点引用时，节点内对配置
        的就地改写不会互相污染（建图期一次性调用，拷贝开销可忽略）。
        契约不参与实例化——契约是数据，执行体仍是工厂产出的函数。
        """
        factory = self._factories.get(type_name)
        if factory is None:
            raise GraphDefinitionError(f"未知节点类型: {type_name}")
        return factory(dict(config or {}))

    def contract_for(self, type_name: str) -> NodeContract | None:
        """按类型名取已登记契约（未登记契约/未知类型 = None）。

        契约随类型登记（register 的 contract 参数）；查询供组装期
        候选收集与链接校验使用。契约与工厂同表同生命周期——类型
        是唯一集，契约是类型声明的数据部分。
        """
        return self._contracts.get(type_name)

    def contract_versions(self, type_name: str) -> frozenset[int]:
        """该类型已登记的契约版本集（无契约/未知类型 = 空集）。

        供链接校验的契约版本存在性判定（引用的契约版本须已登记——
        旧图定义可解析）；当前登记形态只保留最新契约版本，补丁链
        版本快照接入后由调用方合并历史版本集传入校验器。
        """
        contract = self._contracts.get(type_name)
        if contract is None:
            return frozenset()
        return frozenset({contract.version})

    def has_contract(self, type_name: str) -> bool:
        return type_name in self._contracts

    def has(self, type_name: str) -> bool:
        return type_name in self._factories

    def types(self) -> tuple[str, ...]:
        """已注册类型名（插入序，供校验/展示；内容不解释）。"""
        return tuple(self._factories)

    def __len__(self) -> int:
        return len(self._factories)


class EdgeConditionRegistry:
    """条件边注册表：条件名 → 判定函数（声明式图定义的边引用）。

    与 :class:`NodeTypeRegistry` 同构：图定义数据里的条件边只携带条件名，
    建图/重放时按名解析判定函数（async (ctx) -> bool）。未注册的条件名
    在建图期拒绝（GraphDefinitionError），不等到运行时判定才暴露。
    """

    def __init__(self) -> None:
        self._conditions: dict[str, EdgeCondition] = {}

    def register(self, name: str, condition: EdgeCondition) -> None:
        """登记条件名 → 判定函数（重复登记抛错，防静默覆盖语义）。"""
        if name in self._conditions:
            raise GraphDefinitionError(f"条件名重复注册: {name}")
        self._conditions[name] = condition

    def create(self, name: str) -> EdgeCondition:
        """按条件名取判定函数（未知条件抛 GraphDefinitionError）。"""
        condition = self._conditions.get(name)
        if condition is None:
            raise GraphDefinitionError(f"未知条件: {name}")
        return condition

    def has(self, name: str) -> bool:
        return name in self._conditions

    def names(self) -> tuple[str, ...]:
        """已注册条件名（插入序，供校验/展示）。"""
        return tuple(self._conditions)

    def __len__(self) -> int:
        return len(self._conditions)


@dataclass(frozen=True, slots=True)
class GraphRegistries:
    """建图注册表捆绑（引擎级依赖注入）。

    图定义数据（spawn 子图/计划条件/harness 图）的解析需要节点类型与
    边条件两套注册表，捆绑注入避免分散传递、保证两表同源；缺省各自
    建空表（调用方按需填充）。
    """

    nodes: NodeTypeRegistry = field(default_factory=NodeTypeRegistry)
    edges: EdgeConditionRegistry = field(default_factory=EdgeConditionRegistry)


__all__ = [
    "EdgeConditionRegistry",
    "GraphRegistries",
    "NodeFactory",
    "NodeTypeRegistry",
]
