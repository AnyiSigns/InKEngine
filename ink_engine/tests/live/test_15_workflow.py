"""族 15：工作流（test_15_workflow.py）｜workflow。

- WorkflowSpec → 图转换（build_workflow_graph）；入口推断/回路/孤岛拒绝
- 宽松域/严格序（RunOptions.plan_workflow + plan_policy）；越界计划拒绝
- 工作流 + plan + spawn 组合

确定性机制用例（零模型调用）+ 1 条真实 LLM 用例（族门禁②）。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.events import CollectorTransport  # noqa: E402
from ink_engine.core.exceptions import GraphDefinitionError  # noqa: E402
from ink_engine.core.executor import Engine, RunOptions  # noqa: E402
from ink_engine.core.graph import Graph, TerminateReason  # noqa: E402
from ink_engine.core.plan import PLAN_KEY  # noqa: E402
from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry  # noqa: E402
from ink_engine.core.workflow import (  # noqa: E402
    WorkflowEdgeSpec,
    WorkflowNodeSpec,
    WorkflowSpec,
    build_workflow_graph,
)


def _registry() -> NodeTypeRegistry:
    def factory(tag: str):
        def make(config: dict):
            async def node(ctx):
                return {"seen": [*ctx.state.get("seen", []), f"{tag}"]}

            return node

        return make

    registry = NodeTypeRegistry()
    registry.register("a", factory("a"))
    registry.register("b", factory("b"))
    registry.register("c", factory("c"))
    return registry


def test_workflow_spec_to_graph():
    spec = WorkflowSpec(
        name="wf",
        nodes=(
            WorkflowNodeSpec(id="a", type="a"),
            WorkflowNodeSpec(id="b", type="b"),
            WorkflowNodeSpec(id="c", type="c"),
        ),
        edges=(
            WorkflowEdgeSpec(source="a", target="b"),
            WorkflowEdgeSpec(source="b", target="c"),
        ),
    )
    graph = build_workflow_graph(spec, _registry())
    assert graph.entry == "a"  # 唯一无入边节点推断
    assert "c" in graph.exits


def test_workflow_ambiguous_entry_rejected():
    spec = WorkflowSpec(
        name="wf2",
        nodes=(
            WorkflowNodeSpec(id="a", type="a"),
            WorkflowNodeSpec(id="b", type="b"),
        ),
    )
    with pytest.raises(GraphDefinitionError):
        build_workflow_graph(spec, _registry())  # 多无入边节点：入口歧义拒绝


def test_workflow_cycle_and_isolated_rejected():
    registry = _registry()
    cycle = WorkflowSpec(
        name="cyc",
        entry="a",
        nodes=(WorkflowNodeSpec(id="a", type="a"), WorkflowNodeSpec(id="b", type="b")),
        edges=(
            WorkflowEdgeSpec(source="a", target="b"),
            WorkflowEdgeSpec(source="b", target="a"),
        ),
    )
    with pytest.raises(GraphDefinitionError):
        build_workflow_graph(cycle, registry)
    isolated = WorkflowSpec(
        name="iso",
        entry="a",
        nodes=(
            WorkflowNodeSpec(id="a", type="a"),
            WorkflowNodeSpec(id="b", type="b"),
        ),
        edges=(WorkflowEdgeSpec(source="a", target="a"),),
    )
    with pytest.raises(GraphDefinitionError):
        build_workflow_graph(isolated, registry)  # 入口不可达节点拒绝


async def test_workflow_execution_with_plan_constraint(memory_storage):
    """工作流约束域：__plan__ 落在 WorkflowSpec 声明的计划空间内执行。"""
    spec = WorkflowSpec(
        name="wf",
        nodes=(
            WorkflowNodeSpec(id="a", type="a"),
            WorkflowNodeSpec(id="b", type="b"),
            WorkflowNodeSpec(id="c", type="c"),
        ),
        edges=(
            WorkflowEdgeSpec(source="a", target="b"),
            WorkflowEdgeSpec(source="b", target="c"),
        ),
    )

    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["b", "c"]}]}

    route_graph = Graph(name="route", entry="r")
    route_graph.add_node("r", route)
    route_graph.add_edge("r", "a")
    route_graph.add_exit("c")
    route_graph.add_node("a", lambda ctx: {})
    route_graph.add_node("b", lambda ctx: {"seen": [*ctx.state.get("seen", []), "b"]})
    route_graph.add_node("c", lambda ctx: {"seen": [*ctx.state.get("seen", []), "c"]})
    route_graph.add_edge("a", "b")
    route_graph.add_edge("b", "c")

    engine = Engine(
        route_graph,
        options=RunOptions(
            storage=memory_storage,
            transports=[CollectorTransport()],
            plan_workflow=spec,
            plan_policy="strict",
        ),
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state["seen"] == ["b", "c"]


async def test_workflow_out_of_domain_plan_rejected(memory_storage):
    """越界计划拒绝：计划引用约束域外节点（strict）→ 显式失败。"""
    spec = WorkflowSpec(
        name="wf",
        nodes=(WorkflowNodeSpec(id="a", type="a"), WorkflowNodeSpec(id="b", type="b")),
        edges=(WorkflowEdgeSpec(source="a", target="b"),),
    )

    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["outside"]}]}

    route_graph = Graph(name="route", entry="r")
    route_graph.add_node("r", route)
    route_graph.add_node("a", lambda ctx: {})
    route_graph.add_node("outside", lambda ctx: {})
    route_graph.add_edge("r", "a")
    route_graph.add_edge("a", "outside")
    route_graph.add_exit("outside")
    engine = Engine(
        route_graph,
        options=RunOptions(
            storage=memory_storage,
            transports=[CollectorTransport()],
            plan_workflow=spec,
            plan_policy="strict",
        ),
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.ERROR  # 越界计划 fail-closed


async def test_workflow_plan_spawn_combination(memory_storage):
    """工作流 + plan + spawn 组合：计划 spawn 步（数据形态）展开并回流。"""

    def sub_factory(tag: str):
        def make(config: dict):
            async def node(ctx):
                return {"subs": [*ctx.state.get("subs", []), tag]}

            return node

        return make

    def sub_node_factory(config: dict):
        async def sub_node(ctx):
            return {"saw": ctx.state.get("seed", 0) + config.get("boost", 0)}

        return sub_node

    registry = NodeTypeRegistry()
    registry.register("s1", sub_factory("s1"))
    registry.register("s2", sub_factory("s2"))
    registry.register("sub_node", sub_node_factory)

    spec = WorkflowSpec(
        name="wfsp",
        nodes=(
            WorkflowNodeSpec(id="s1", type="s1"),
            WorkflowNodeSpec(id="s2", type="s2"),
        ),
        edges=(WorkflowEdgeSpec(source="s1", target="s2"),),
    )

    sub = Graph(name="sub", entry="x")
    sub.add_node_type("x", "sub_node", {"boost": 1})
    sub.add_exit("x")
    sub.resolve_types(registry)

    async def route(ctx):
        return {
            PLAN_KEY: [
                {"nodes": ["s1"]},
                {"spawns": [{"subgraph": sub.to_dict(), "state": {"seed": 7}, "index": 0}]},
            ]
        }

    route_graph = Graph(name="route", entry="r")
    route_graph.add_node("r", route)
    route_graph.add_edge("r", "s1")
    route_graph.add_node("s1", lambda ctx: {"seen": [*ctx.state.get("seen", []), "s1"]})
    route_graph.add_node("s2", lambda ctx: {"seen": [*ctx.state.get("seen", []), "s2"]})
    route_graph.add_edge("s1", "s2")
    route_graph.add_exit("s2")
    engine = Engine(
        route_graph,
        options=RunOptions(
            storage=memory_storage,
            transports=[CollectorTransport()],
            plan_workflow=spec,
            plan_policy="loose",
            registries=GraphRegistries(nodes=registry),
        ),
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert "s1" in result.state["seen"]
    assert result.state["saw"] == 8  # spawn 实例结果回流（7 + boost 1）


# ----------------------------------------------------------------------
# 真实 LLM 回合：工作流图 + 严格计划约束域（族门禁②）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_round_workflow_graph_strict_plan(live_llm, memory_storage):
    """真实 LLM 回合走工作流图（严格计划域内），回合产物 + 图执行契约。"""
    from ink_engine.core.llm.messages import user

    spec = WorkflowSpec(
        name="wf-real",
        nodes=(
            WorkflowNodeSpec(id="a", type="a"),
            WorkflowNodeSpec(id="b", type="b"),
            WorkflowNodeSpec(id="c", type="c"),
        ),
        edges=(
            WorkflowEdgeSpec(source="a", target="b"),
            WorkflowEdgeSpec(source="b", target="c"),
        ),
    )

    async def llm_node(ctx):
        result = await live_llm.ainvoke([user("用一句话回答：工作流验证")])
        await ctx.emit("reply_token", {"content": result.content})
        return {"answer": result.content}

    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["b", "c"]}]}

    route_graph = Graph(name="route_real", entry="r")
    route_graph.add_node("r", route)
    route_graph.add_node("a", llm_node)
    route_graph.add_node("b", llm_node)
    route_graph.add_node("c", lambda ctx: {"done": True})
    route_graph.add_edge("r", "a")
    route_graph.add_edge("a", "b")
    route_graph.add_edge("b", "c")
    route_graph.add_exit("c")
    engine = Engine(
        route_graph,
        options=RunOptions(
            storage=memory_storage,
            transports=[CollectorTransport()],
            plan_workflow=spec,
            plan_policy="strict",
        ),
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state["answer"].strip()  # 真实回合产物
    assert result.state["done"] is True
