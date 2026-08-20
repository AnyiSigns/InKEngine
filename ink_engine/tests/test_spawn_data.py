"""spawn 子图数据形态单测：Graph 或图定义数据均可展开（数据化放宽）。

语义检查点：`__spawn__` 清单的 subgraph 从硬类型 Graph 放宽为「Graph
或可解析的图定义数据」——数据形态经注入的建图注册表重建；未注入解析
器时 dict 形态显式拒绝（防静默当作缺子图）；实例隔离/独立子链语义
与 Graph 形态完全一致。
"""
from __future__ import annotations

from conftest import make_engine

from ink_engine.core.executor import Engine
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry
from ink_engine.core.spawn import SPAWN_KEY


def _sub_registry() -> NodeTypeRegistry:
    nodes = NodeTypeRegistry()

    def sub_factory(config: dict):
        async def node(ctx):
            return {"sub_result": ctx.state.get("seed", 0) + config.get("delta", 1)}
        return node

    nodes.register("sub_add", sub_factory)
    return nodes


def _data_subgraph(delta: int = 1) -> dict:
    sub = Graph(name="sub", entry="s1")
    sub.add_node_type("s1", "sub_add", {"delta": delta})
    sub.add_exit("s1")
    sub.resolve_types(_sub_registry())
    return sub.to_dict()


def _parent_graph(route_fn) -> Graph:
    graph = Graph(name="parent", entry="route")
    graph.add_node("route", route_fn)
    graph.add_exit("route")
    return graph


def _run(engine: Engine, **kw):
    return engine._execute(
        state=kw.pop("state", {}),
        thread_id=kw.pop("thread_id", "t"),
        round_id=kw.pop("round_id", None),
        resume_from=kw.pop("resume_from", None),
        trace_id=kw.pop("trace_id", "trace"),
        queue=None,
        **kw,
    )


async def test_data_driven_spawn_with_data_subgraph(memory_storage):
    """数据形态：清单 subgraph = 图定义数据 → 注册表重建后展开，结果回流。"""
    async def route(ctx):
        return {
            SPAWN_KEY: [
                {"subgraph": _data_subgraph(1), "state": {"seed": 10}, "index": 0},
                {"subgraph": _data_subgraph(2), "state": {"seed": 20}, "index": 1},
            ]
        }

    engine = make_engine(
        _parent_graph(route),
        storage=memory_storage,
        registries=GraphRegistries(nodes=_sub_registry()),
    )
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert state["sub_result"] == 22  # 末项覆盖（裸通道）


async def test_data_spawn_instances_isolated_chains(memory_storage):
    """数据形态实例同样走独立子链（实例 checkpoint 与父链互不污染）。"""
    async def route(ctx):
        return {
            SPAWN_KEY: [
                {"subgraph": _data_subgraph(1), "state": {"seed": 1}, "index": 0},
            ]
        }

    engine = make_engine(
        _parent_graph(route),
        storage=memory_storage,
        registries=GraphRegistries(nodes=_sub_registry()),
    )
    await _run(engine, thread_id="t1")
    parent_cps = await memory_storage.list_checkpoints("t1")
    instance_cps = await memory_storage.list_checkpoints("t1:spawn:0")
    assert parent_cps
    assert instance_cps


async def test_data_spawn_without_registry_rejected(memory_storage):
    """未注入注册表时 dict 形态显式拒绝（不静默当作缺子图）。"""
    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": _data_subgraph(1), "state": {}, "index": 0}]}

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "注册表" in (result.error or "")


async def test_graph_form_still_works(memory_storage):
    """Graph 形态兼容保持：直接实例无需注册表（回归护栏）。"""
    async def sub_node(ctx):
        return {"sub_result": ctx.state.get("seed", 0) + 1}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_node)
    sub.add_exit("s1")

    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": sub, "state": {"seed": 5}, "index": 0}]}

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert state["sub_result"] == 6


async def test_invalid_data_subgraph_fails_node(memory_storage):
    """非法图定义数据 → 节点失败（reason=error，不穿出异常）。"""
    async def route(ctx):
        return {
            SPAWN_KEY: [{"subgraph": {"name": "bad"}, "state": {}, "index": 0}]
        }

    engine = make_engine(
        _parent_graph(route),
        storage=memory_storage,
        registries=GraphRegistries(nodes=_sub_registry()),
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
