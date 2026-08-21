"""族 13：图与复杂图（test_13_graph_full.py）｜graph/registry/harness。

- 图 DSL 全特性：节点/静态边/条件边（函数+按名）/嵌套子图/多出口/
  循环回路（带退出条件）
- 复杂图拓扑矩阵：3 层嵌套子图/子图内条件边/子图间跳转/循环+条件退出/
  多分支汇聚/循环内嵌套子图
- Graph round-trip（to_dict/from_dict 指纹一致）；注册表建图（type 数据
  解析 + 未知类型错误路径）；函数直挂序列化显式拒绝
- harness：声明式定义/注册表路由/补丁链仓库（版本回退取旧图）/未注册
  名显式拒绝
- 复杂图上真实 LLM 回合 + checkpoint 恢复（图深路径断言）

`real` 标记 = 真实 LLM 调用（族门禁②）；其余为确定性机制用例。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.events import CollectorTransport  # noqa: E402
from ink_engine.core.exceptions import GraphDefinitionError  # noqa: E402
from ink_engine.core.executor import Engine, RunOptions  # noqa: E402
from ink_engine.core.graph import Graph, TerminateReason  # noqa: E402
from ink_engine.core.harness import (  # noqa: E402
    HarnessDefinition,
    HarnessRegistry,
    HarnessRepository,
    build_minimal_harness,
)
from ink_engine.core.llm.messages import user  # noqa: E402
from ink_engine.core.registry import (  # noqa: E402
    EdgeConditionRegistry,
    GraphRegistries,
    NodeTypeRegistry,
)
from ink_engine.core.state import StateSchema  # noqa: E402


def _node_factory(tag: str):
    def factory(config: dict):
        async def node(ctx):
            return {"seen": [*ctx.state.get("seen", []), f"{tag}:{config.get('value', 0)}"]}

        return node

    return factory


def _registries() -> GraphRegistries:
    nodes = NodeTypeRegistry()
    nodes.register("write", _node_factory("write"))
    nodes.register("audit", _node_factory("audit"))
    edges = EdgeConditionRegistry()

    async def want_yes(ctx):
        return ctx.state.get("want_yes", False) is True

    async def want_no(ctx):
        return ctx.state.get("want_yes", False) is False

    edges.register("want_yes", want_yes)
    edges.register("want_no", want_no)
    return GraphRegistries(nodes=nodes, edges=edges)


# ----------------------------------------------------------------------
# 图 DSL 全特性
# ----------------------------------------------------------------------

async def test_graph_dsl_full_features(memory_storage):
    """节点/静态边/按名条件边/子图/多出口/循环回路带退出条件同图生效。"""
    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", lambda ctx: {"sub_done": True})
    sub.add_exit("s1")

    g = Graph(name="dsl", entry="start")
    g.add_node("start", lambda ctx: {"count": 0})
    g.add_node("loop", lambda ctx: {"count": ctx.state.get("count", 0) + 1})
    g.add_subgraph("sub", sub)
    g.add_node("a_exit", lambda ctx: {"branch": "a"})
    g.add_node("b_exit", lambda ctx: {"branch": "b"})
    g.add_edge("start", "loop")
    g.add_conditional_edge("loop", "loop", lambda ctx: ctx.state.get("count", 0) < 2)
    g.add_conditional_edge("loop", "sub", lambda ctx: ctx.state.get("count", 0) >= 2)
    g.add_edge("sub", "a_exit")
    g.add_conditional_edge_by_name("a_exit", "b_exit", "want_no")
    g.add_exit("a_exit")
    g.add_exit("b_exit")
    engine = Engine(
        g,
        options=RunOptions(
            storage=memory_storage,
            transports=[CollectorTransport()],
            registries=_registries(),
        ),
    )
    result = await engine.ainvoke({"want_yes": True}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state["count"] == 2
    assert result.state["sub_done"] is True
    assert result.state["branch"] == "a"


# ----------------------------------------------------------------------
# 复杂图拓扑矩阵
# ----------------------------------------------------------------------

async def test_complex_topology_matrix(memory_storage):
    """复杂图：3 层嵌套 + 子图内条件边 + 子图间跳转 + 循环条件退出 +
    多分支汇聚 + 循环内嵌套子图——一图同场，路径与状态全断言。"""
    # 第 3 层：条件边 + 汇聚
    leaf_yes = Graph(name="leaf_yes", entry="ly1")
    leaf_yes.add_node("ly1", lambda ctx: {"path": [*ctx.state.get("path", []), "leaf_yes"]})
    leaf_yes.add_exit("ly1")
    leaf_no = Graph(name="leaf_no", entry="ln1")
    leaf_no.add_node("ln1", lambda ctx: {"path": [*ctx.state.get("path", []), "leaf_no"]})
    leaf_no.add_exit("ln1")

    # 第 2 层：子图内条件边（按名字）+ 循环内嵌套子图
    inner = Graph(name="inner", entry="i1")
    inner.add_node("i1", lambda ctx: {"path": [*ctx.state.get("path", []), "inner"]})
    inner.add_subgraph("leaf_yes", leaf_yes)
    inner.add_subgraph("leaf_no", leaf_no)
    inner.add_conditional_edge_by_name("i1", "leaf_yes", "want_yes")
    inner.add_conditional_edge_by_name("i1", "leaf_no", "want_no")
    inner.add_exit("leaf_yes")
    inner.add_exit("leaf_no")
    registries = _registries()
    inner.resolve_conditions(registries.edges)  # 嵌套子图按名条件边解析

    loop_sub = Graph(name="loop_sub", entry="ls1")
    loop_sub.add_node("ls1", lambda ctx: {"loop_sub_ticks": ctx.state.get("loop_sub_ticks", 0) + 1})
    loop_sub.add_exit("ls1")

    # 第 1 层：循环（带退出）+ 子图间跳转 + 多分支汇聚
    top = Graph(name="top", entry="t1")
    top.add_node("t1", lambda ctx: {"path": ["top"], "count": 0})
    top.add_node("loop", lambda ctx: {"count": ctx.state.get("count", 0) + 1})
    top.add_subgraph("loop_sub", loop_sub)
    top.add_subgraph("inner", inner)
    top.add_node("merge", lambda ctx: {"path": [*ctx.state.get("path", []), "merge"]})
    top.add_node("t_exit", lambda ctx: {"done": True})
    top.add_edge("t1", "loop")
    top.add_conditional_edge("loop", "loop_sub", lambda ctx: ctx.state.get("count", 0) % 2 == 1)
    top.add_conditional_edge("loop", "inner", lambda ctx: ctx.state.get("count", 0) >= 2)
    top.add_conditional_edge("loop", "merge", lambda ctx: False)
    top.add_edge("loop_sub", "loop")  # 循环内嵌套子图 → 回指循环
    top.add_edge("inner", "merge")  # 子图间跳转（inner → merge）
    top.add_edge("merge", "t_exit")
    top.add_exit("t_exit")
    engine = Engine(
        top,
        options=RunOptions(storage=memory_storage, transports=[CollectorTransport()], registries=registries),
    )
    result = await engine.ainvoke({"want_yes": True}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state["done"] is True
    assert result.state["loop_sub_ticks"] == 1  # 循环内嵌套子图执行一次
    assert result.state["path"] == ["top", "inner", "leaf_yes", "merge"]
    assert result.state["count"] == 2  # 循环退出条件


# ----------------------------------------------------------------------
# round-trip / 注册表 / 序列化拒绝
# ----------------------------------------------------------------------

def test_graph_roundtrip_digest_stable():
    registries = _registries()
    g = Graph(name="decl", entry="start", schema=StateSchema({"seen": None, "want_yes": None}))
    g.add_node_type("start", "write", {"value": 1})
    g.add_node_type("yes", "write", {"value": 2})
    g.add_node_type("no", "audit", {"value": 3})
    g.add_conditional_edge_by_name("start", "yes", "want_yes")
    g.add_conditional_edge_by_name("start", "no", "want_no")
    g.add_exit("yes")
    g.add_exit("no")
    g.resolve_types(registries.nodes)
    g.resolve_conditions(registries.edges)
    rebuilt = Graph.from_dict(
        g.to_dict(), registry=registries.nodes, edge_registry=registries.edges, validate=True
    )
    assert rebuilt.digest() == g.digest()  # 指纹一致（数据形态稳定）
    assert rebuilt.entry == g.entry


def test_registry_unknown_type_error_path():
    nodes = NodeTypeRegistry()
    nodes.register("write", _node_factory("write"))
    g = Graph(name="g", entry="a")
    g.add_node_type("a", "no_such_type", {})
    with pytest.raises(GraphDefinitionError):
        g.resolve_types(nodes)  # 未知类型 = 建期显式拒绝，不静默当函数节点


def test_function_node_serialization_rejected():
    g = Graph(name="g", entry="a")
    g.add_node("a", lambda ctx: {})
    with pytest.raises(GraphDefinitionError, match="未注册类型名"):
        g.to_dict()  # 函数直挂节点 → 序列化显式拒绝


def test_graph_compile_validation():
    g = Graph(name="g", entry="a")
    g.add_node("a", lambda ctx: {})
    g.add_exit("b")  # 出口未声明节点
    with pytest.raises(GraphDefinitionError):
        g.compile()


# ----------------------------------------------------------------------
# harness：定义 / 路由 / 补丁链仓库 / 拒绝路径
# ----------------------------------------------------------------------

async def test_harness_route_and_build(memory_storage):
    registries = _registries()
    g = Graph(name="h", entry="start")
    g.add_node_type("start", "write", {"value": 9})
    g.add_exit("start")
    g.resolve_types(registries.nodes)
    definition = HarnessDefinition(
        name="writer",
        description="写作助手",
        keywords=("写作", "润色"),
        graph=g.to_dict(),
    )
    registry = HarnessRegistry(registries)
    registry.register(definition)
    routes = registry.route("帮我写作润色")
    assert routes and routes[0][0] == "writer"
    rebuilt = registry.build_graph("writer")
    assert rebuilt is not None
    engine = Engine(
        rebuilt,
        options=RunOptions(storage=memory_storage, transports=[CollectorTransport()], registries=registries),
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.state["seen"] == ["write:9"]


async def test_harness_repository_version_rollback(memory_storage):
    repo = HarnessRepository(memory_storage)
    v1 = build_minimal_harness("h1", "版本一", ("k",), graph={"name": "g1", "entry": "a", "nodes": {}, "edges": {}, "exits": ["a"]})
    first = await repo.save(v1, note="v1")
    assert first == 1
    v2 = build_minimal_harness("h1", "版本二", ("k",), graph={"name": "g2", "entry": "a", "nodes": {}, "edges": {}, "exits": ["a"]})
    second = await repo.save(v2, note="v2")
    assert second == 2
    # 最新 = v2；回退 = 组装到 v1（补丁链 partial，不物理删除）
    assert (await repo.get("h1")).description == "版本二"
    assert (await repo.get("h1", version=1)).description == "版本一"
    assert (await repo.get("h1", version=1)).graph["name"] == "g1"
    versions = await repo.versions("h1")
    assert [v.version for v in versions] == [1, 2]


def test_harness_unregistered_rejected():
    registry = HarnessRegistry()
    with pytest.raises(KeyError):
        registry.build_graph("no_such_harness")


# ----------------------------------------------------------------------
# 复杂图上真实 LLM 回合 + checkpoint 恢复
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_complex_graph_real_round_and_resume(live_llm, memory_storage):
    """复杂图（嵌套+条件）真实 LLM 回合 → 中断 → 恢复续跑（深路径断言）。"""
    async def llm_node(ctx):
        result = await live_llm.ainvoke([user("用一句话回答：今天适合户外运动吗？")])
        await ctx.emit("llm_answer", {"content": result.content})
        return {"answer": result.content}

    sub = Graph(name="brain", entry="b1")
    sub.add_node("b1", llm_node)
    sub.add_exit("b1")

    async def gate(ctx):
        await ctx.interrupt("gate", {"q": "确认?"})
        return {}

    top = Graph(name="complex_real", entry="t1")
    top.add_node("t1", lambda ctx: {"phase": "start"})
    top.add_subgraph("brain", sub)
    top.add_node("gate", gate)
    top.add_node("final", lambda ctx: {"phase": "done"})
    top.add_edge("t1", "brain")
    top.add_conditional_edge("brain", "gate", lambda ctx: bool(ctx.state.get("answer")))
    top.add_edge("gate", "final")
    top.add_exit("final")

    engine1 = Engine(
        top,
        options=RunOptions(storage=memory_storage, transports=[CollectorTransport()]),
    )
    result = await engine1.ainvoke({}, thread_id="t")
    assert result.interrupt is not None and result.interrupt.key == "gate"
    assert result.state["answer"], "子图真实 LLM 产出缺失"
    # 恢复续跑（新引擎同存储）：决议注入 → 走完
    engine2 = Engine(
        top,
        options=RunOptions(storage=memory_storage, transports=[CollectorTransport()]),
    )
    resumed = await engine2.ainvoke(
        {}, thread_id="t", resume_from=result.checkpoint_id, inject={"gate": "accept"}
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state["phase"] == "done"
    # 深路径断言：子图事件 graph_path 完整
    sub_events = [
        e for e in engine1.options.transports[0].events if e.type == "llm_answer"
    ]
    assert sub_events and sub_events[0].graph_path == ("brain",)
