"""节点类型注册表单测：注册/按名解析/构造参数透传/重复与未知类型拒绝。

类型名对注册表是不透明字符串——测试里的 "write"/"audit" 只是示意键，
注册表本身不解释任何类型语义（机制中立性的直接体现）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.registry import NodeTypeRegistry


def _counting_factory(tag: str):
    """按配置构造节点执行函数：记录入参配置，返回其值（验证参数透传）。"""

    def factory(config: dict):
        async def node(ctx):
            return {"value": config.get("value", 0), "tag": tag}

        node.__name__ = f"node_{tag}"
        return node

    return factory


def test_register_and_create_by_type():
    registry = NodeTypeRegistry()
    registry.register("write", _counting_factory("write"))
    fn = registry.create("write", {"value": 7})
    assert fn is not None
    assert callable(fn)


def test_unknown_type_rejected():
    registry = NodeTypeRegistry()
    with pytest.raises(GraphDefinitionError, match="未知节点类型"):
        registry.create("missing", {})


def test_duplicate_register_rejected():
    registry = NodeTypeRegistry()
    registry.register("write", _counting_factory("a"))
    with pytest.raises(GraphDefinitionError, match="重复注册"):
        registry.register("write", _counting_factory("b"))


async def test_config_passthrough_and_isolation():
    """同类型不同配置实例化互不干扰的节点（配置经拷贝透传，不共享可变对象）。"""
    registry = NodeTypeRegistry()
    registry.register("write", _counting_factory("write"))
    fn_a = registry.create("write", {"value": 1})
    fn_b = registry.create("write", {"value": 2})
    assert fn_a is not fn_b
    assert (await fn_a(object()))["value"] == 1
    assert (await fn_b(object()))["value"] == 2
    assert (await fn_a(object()))["tag"] == "write"


def test_has_types_and_len():
    registry = NodeTypeRegistry()
    assert not registry.has("write")
    registry.register("write", _counting_factory("w"))
    registry.register("audit", _counting_factory("a"))
    assert registry.has("write")
    assert not registry.has("router")
    assert registry.types() == ("write", "audit")
    assert len(registry) == 2
