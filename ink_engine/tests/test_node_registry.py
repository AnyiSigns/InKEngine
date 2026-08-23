"""节点类型注册表单测：注册/按名解析/构造参数透传/重复与未知类型拒绝。

类型名对注册表是不透明字符串——测试里的 "write"/"audit" 只是示意键，
注册表本身不解释任何类型语义（机制中立性的直接体现）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.contracts import NodeContract
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


# ── 契约登记（可选扩展：旧调用形态零破坏）──


def test_register_with_contract_queryable():
    """register 携带契约：契约随类型登记，可查询/可判版本。"""
    registry = NodeTypeRegistry()
    contract = NodeContract(safety_tier=1, version=2)
    registry.register("write", _counting_factory("w"), contract=contract)
    assert registry.contract_for("write") is contract
    assert registry.contract_versions("write") == frozenset({2})
    assert registry.has_contract("write") is True


def test_register_without_contract_keeps_old_form():
    """旧调用形态（无 contract）完全不变：契约查询为空、实例化不受影响。"""
    registry = NodeTypeRegistry()
    registry.register("write", _counting_factory("w"))
    assert registry.contract_for("write") is None
    assert registry.contract_versions("write") == frozenset()
    assert registry.has_contract("write") is False
    # 未知类型同样返回空
    assert registry.contract_for("missing") is None
    assert registry.contract_versions("missing") == frozenset()
    # 无契约类型仍可正常实例化（契约是数据，不参与实例化）
    fn = registry.create("write", {"value": 1})
    assert callable(fn)


def test_contract_does_not_affect_instantiation():
    """契约只登记数据，实例化仍走工厂（契约不参与执行形态）。"""
    registry = NodeTypeRegistry()
    contract = NodeContract(output_schema=None)
    registry.register("write", _counting_factory("w"), contract=contract)
    fn = registry.create("write", {"value": 7})
    assert callable(fn)


def test_duplicate_register_rejected_with_contract():
    """携带契约的重复登记同样拒绝（防静默覆盖语义不变）。"""
    registry = NodeTypeRegistry()
    registry.register("write", _counting_factory("a"), contract=NodeContract())
    with pytest.raises(GraphDefinitionError, match="重复注册"):
        registry.register("write", _counting_factory("b"), contract=NodeContract())
