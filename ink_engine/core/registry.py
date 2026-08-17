"""节点/边注册表（扩展点：业务注册自定义节点/边，引擎不封闭）。

新增图能力 = 注册新节点/边类型，引擎核心零改动（插拔 U 盘式扩展）。
注册表按命名空间隔离（默认全局），引擎图定义引用已注册节点。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from .exceptions import NodeNotFoundError
from .graph import EdgeCondition, NodeFn

# 默认命名空间：未指定命名空间的注册/解析走这里
DEFAULT_NAMESPACE = "__default__"


@dataclass(slots=True)
class NodeRegistry:
    """节点注册表：name → NodeFn（业务声明式注册，图定义按名引用）。

    用法：
        registry = NodeRegistry()
        registry.register("my_node", my_fn)
        graph.nodes["my_node"] = registry.resolve("my_node")
    """

    namespace: str = DEFAULT_NAMESPACE
    _nodes: dict[str, NodeFn] = field(default_factory=dict)

    def register(self, name: str, fn: NodeFn) -> None:
        if name in self._nodes:
            raise ValueError(f"节点重复注册 [{self.namespace}]: {name}")
        self._nodes[name] = fn

    def resolve(self, name: str) -> NodeFn:
        try:
            return self._nodes[name]
        except KeyError as exc:
            raise NodeNotFoundError(f"{self.namespace}:{name}") from exc

    def has(self, name: str) -> bool:
        return name in self._nodes

    def names(self) -> list[str]:
        return sorted(self._nodes)


@dataclass(slots=True)
class EdgeRegistry:
    """条件边注册表：name → EdgeCondition（业务注册可复用判定）。"""

    namespace: str = DEFAULT_NAMESPACE
    _conditions: dict[str, EdgeCondition] = field(default_factory=dict)

    def register(self, name: str, condition: EdgeCondition) -> None:
        if name in self._conditions:
            raise ValueError(f"条件边重复注册 [{self.namespace}]: {name}")
        self._conditions[name] = condition

    def resolve(self, name: str) -> EdgeCondition:
        try:
            return self._conditions[name]
        except KeyError as exc:
            raise NodeNotFoundError(f"{self.namespace}:{name}") from exc


# 默认命名空间的全局注册表（业务模块导入即注册，图定义按名引用）
GLOBAL_NODES: NodeRegistry = NodeRegistry()
GLOBAL_EDGES: EdgeRegistry = EdgeRegistry()


def register_node(name: str, fn: NodeFn) -> None:
    """全局节点注册（装饰器/直接调用皆可）：``@register_node("x")`` 或
    ``register_node("x", fn)``。"""
    GLOBAL_NODES.register(name, fn)


def register_edge(name: str, condition: EdgeCondition) -> None:
    GLOBAL_EDGES.register(name, condition)


def resolve_node(name: str) -> NodeFn:
    return GLOBAL_NODES.resolve(name)


def resolve_edge(name: str) -> EdgeCondition:
    return GLOBAL_EDGES.resolve(name)


__all__ = [
    "DEFAULT_NAMESPACE",
    "GLOBAL_EDGES",
    "GLOBAL_NODES",
    "EdgeRegistry",
    "NodeRegistry",
    "register_edge",
    "register_node",
    "resolve_edge",
    "resolve_node",
]
