"""最小领域生成器单测：build_minimal_harness 起点形态与注册期校验。

覆盖：从高层输入（name/description/keywords）产出最小可用 harness 定义；
无图无工具时为纯能力标记（route 仍可命中）；含图/工具时经注册表走
注册期校验（图/工具非法在注册期暴露，不在执行期静默降级）；数据往返完整。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.graph import Graph
from ink_engine.core.harness import (
    HarnessDefinition,
    HarnessRegistry,
    build_minimal_harness,
)
from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry


def _registry() -> GraphRegistries:
    nodes = NodeTypeRegistry()

    def write_factory(config: dict):
        async def node(ctx):
            return {"seen": [*ctx.state.get("seen", []), config.get("tag", "write")]}

        return node

    nodes.register("write", write_factory)
    return GraphRegistries(nodes=nodes)


def _graph_dict() -> dict:
    """经 Graph API 构造合法图定义（register 的注册期校验按此解析）。"""
    graph = Graph(name="dom", entry="w1")
    graph.add_node_type("w1", "write", {"tag": "dom"})
    graph.add_exit("w1")
    graph.resolve_types(_registry().nodes)
    return graph.to_dict()


def test_minimal_harness_fields():
    """最小 harness 起点：name/description/keywords 透传，无图无工具。"""
    definition = build_minimal_harness(
        name="novel",
        description="小说写作领域",
        keywords=("写作", "小说"),
    )
    assert definition.name == "novel"
    assert definition.description == "小说写作领域"
    assert definition.keywords == ("写作", "小说")
    assert definition.graph is None
    assert definition.tools == ()


def test_minimal_harness_registers_without_graph():
    """纯能力标记（无图无工具）可注册并被路由命中。"""
    registry = HarnessRegistry(registries=_registry())
    registry.register(build_minimal_harness("novel", "小说", ("写作",)))
    assert registry.get("novel") is not None
    # 关键词命中即视为相关（route 可激活）
    ranked = registry.route("我要写作一篇小说")
    assert ranked and ranked[0][0] == "novel" and ranked[0][1] >= 0.5


def test_minimal_harness_with_graph_validates_at_register():
    """含图的最小 harness 经注册表走注册期图校验（节点类型须已注册）。"""
    registry = HarnessRegistry(registries=_registry())
    definition = build_minimal_harness("dom", "带图领域", ("x",), graph=_graph_dict())
    registry.register(definition)  # 注册期校验通过（节点类型 write 已注册）
    assert registry.build_graph("dom") is not None


def test_minimal_harness_round_trip():
    """生成定义数据往返（导出/导入形态完整）。"""
    definition = build_minimal_harness("code", "代码领域", ("代码", "重构"))
    rebuilt = HarnessDefinition.from_dict(definition.to_dict())
    assert rebuilt == definition


def test_minimal_harness_invalid_inputs_rejected():
    """生成器输入形态校验：空名/非串描述/空关键词/非 dict 工具与图。"""
    with pytest.raises(GraphDefinitionError, match="非空字符串"):
        build_minimal_harness("", "x", ("a",))
    with pytest.raises(GraphDefinitionError, match="描述须为字符串"):
        build_minimal_harness("n", {"描述": "不是字符串"}, ("a",))
    with pytest.raises(GraphDefinitionError, match="关键词须为非空字符串清单"):
        build_minimal_harness("n", "x", ())
    with pytest.raises(GraphDefinitionError, match="工具须为"):
        build_minimal_harness("n", "x", ("a",), tools=("not-a-dict",))
    with pytest.raises(GraphDefinitionError, match="graph 须为 dict"):
        build_minimal_harness("n", "x", ("a",), graph=["nodes"])


def test_minimal_harness_copies_mutable_inputs():
    """graph/meta 深拷贝：调用方事后改动不影响已生成定义。"""
    graph = _graph_dict()
    meta = {"source": "caller"}
    definition = build_minimal_harness("dom", "带图领域", ("x",), graph=graph, meta=meta)
    graph["nodes"] = []
    meta["source"] = "mutated"
    assert definition.graph["entry"] == "w1"
    assert definition.meta["source"] == "caller"


def test_minimal_harness_graph_invalid_rejected_at_register():
    """含非法图（未注册节点类型）的最小 harness 在注册期被拒绝，
    不延后到执行期静默降级。"""
    graph = Graph(name="bad", entry="n1")
    graph.add_node_type("n1", "ghost_node", {})
    graph.add_exit("n1")
    registry = HarnessRegistry(registries=_registry())
    definition = build_minimal_harness("bad", "非法图", ("x",), graph=graph.to_dict())
    with pytest.raises(GraphDefinitionError, match="未知节点类型"):
        registry.register(definition)


def test_minimal_harness_meta_and_default_plan_passthrough():
    """meta/default_plan 可选字段透传并回落独立 dict（无共享可变默认值）。"""
    first = build_minimal_harness("a", "x", ("k",))
    second = build_minimal_harness("b", "x", ("k",))
    first.meta["marker"] = "only-first"
    assert "marker" not in second.meta
    assert first.default_plan is None
    plan = {"version": 1}
    with_plan = build_minimal_harness("c", "x", ("k",), default_plan=plan)
    plan["version"] = 2
    assert with_plan.default_plan == {"version": 1}
