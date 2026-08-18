"""节点类型注册表：类型 → 工厂的注册与按名解析（声明式图编译的节点来源）。

图节点可以不经注册表直接以函数形式挂载（Graph.add_node），注册表面向
「声明式规格驱动实例化」的场景：画布/清单里的节点只携带类型名与配置，
建图时按类型解析工厂、把配置透传给工厂生成节点执行函数——同一类型
不同配置实例化出互不干扰的节点。

语义边界：类型名是不透明字符串，注册表不解释任何类型含义；哪些类型
存在、工厂如何构造节点，全部由注册方（宿主/领域包）决定。重复注册
同类型视为编程错误（覆盖会静默替换既有节点语义），建图期显式拒绝。
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .exceptions import GraphDefinitionError
from .graph import NodeFn

# 节点工厂签名：节点配置（声明式规格中的 config 字段透传）→ 节点执行函数。
# 执行函数签名与 Graph.add_node 一致（async (ctx) -> 增量 dict | None）。
NodeFactory = Callable[[dict[str, Any]], NodeFn]


class NodeTypeRegistry:
    """节点类型注册表（进程内单表，注册方在建图前完成登记）。

    线程安全说明：注册通常发生在启动装配期（单线程），解析发生在建图期
    （可并发）；解析只读 dict 无写冲突，无需加锁。注册表支持多个实例
    （宿主可为不同图域各自建表，互不干扰），模块级单例只是惯例用法。
    """

    def __init__(self) -> None:
        self._factories: dict[str, NodeFactory] = {}

    def register(self, type_name: str, factory: NodeFactory) -> None:
        """登记类型 → 工厂（重复登记抛 GraphDefinitionError，防静默覆盖）。"""
        if type_name in self._factories:
            raise GraphDefinitionError(f"节点类型重复注册: {type_name}")
        self._factories[type_name] = factory

    def create(self, type_name: str, config: dict[str, Any] | None = None) -> NodeFn:
        """按类型名实例化节点执行函数（未知类型抛 GraphDefinitionError）。

        配置经浅拷贝透传工厂：同一工厂被多个节点引用时，节点内对配置
        的就地改写不会互相污染（建图期一次性调用，拷贝开销可忽略）。
        """
        factory = self._factories.get(type_name)
        if factory is None:
            raise GraphDefinitionError(f"未知节点类型: {type_name}")
        return factory(dict(config or {}))

    def has(self, type_name: str) -> bool:
        return type_name in self._factories

    def types(self) -> tuple[str, ...]:
        """已注册类型名（插入序，供校验/展示；内容不解释）。"""
        return tuple(self._factories)

    def __len__(self) -> int:
        return len(self._factories)


__all__ = ["NodeFactory", "NodeTypeRegistry"]
