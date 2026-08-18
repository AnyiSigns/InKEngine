"""声明式工作流编译单测：入口推导/出口标记/建图期校验/类型解析/引擎联跑。

语义检查点：入口 = 显式声明或唯一无入边节点；出口 = 无出边节点自动
标记；未知类型/悬空边/回路/入口歧义全部建图期拒绝（不等到运行时）。
"""
from __future__ import annotations

import pytest
from conftest import make_engine

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.executor import Engine
from ink_engine.core.graph import TerminateReason
from ink_engine.core.registry import NodeTypeRegistry
from ink_engine.core.workflow import (
    WorkflowEdgeSpec,
    WorkflowNodeSpec,
    WorkflowSpec,
    build_workflow_graph,
)


async def _execute(engine: Engine, **kw):
    state, result = await engine._execute(
        state={},
        thread_id=kw.pop("thread_id", "t"),
        round_id=kw.pop("round_id", None),
        resume_from=kw.pop("resume_from", None),
        trace_id=kw.pop("trace_id", "trace"),
        queue=None,
        **kw,
    )
    return state, result


def _prompt_factory(tag: str):
    """按配置构造节点执行函数：把配置写入状态（验证参数透传与节点身份）。"""

    def factory(config: dict):
        async def node(ctx):
            return {"seen": [*ctx.state.get("seen", []), f"{tag}:{config.get('value', 0)}"]}

        return node

    return factory


def _spec(
    name: str,
    nodes: list[tuple[str, str, dict]],
    edges: list[tuple[str, str]],
    entry: str | None = None,
) -> WorkflowSpec:
    return WorkflowSpec(
        name=name,
        nodes=tuple(WorkflowNodeSpec(id=nid, type=ntype, config=cfg) for nid, ntype, cfg in nodes),
        edges=tuple(WorkflowEdgeSpec(source=s, target=t) for s, t in edges),
        entry=entry,
    )


def _registry() -> NodeTypeRegistry:
    registry = NodeTypeRegistry()
    registry.register("write", _prompt_factory("write"))
    registry.register("audit", _prompt_factory("audit"))
    return registry


async def test_linear_spec_compiles_and_runs():
    """线性规格：入口推断 + 出口标记，经引擎联跑端到端。"""
    spec = _spec(
        "linear",
        [("writer", "write", {"value": 1}), ("auditor", "audit", {"value": 2})],
        [("writer", "auditor")],
    )
    graph = build_workflow_graph(spec, _registry())
    assert graph.entry == "writer"  # 唯一无入边节点
    assert graph.exits == {"auditor"}  # 无出边节点自动标记出口
    engine = make_engine(graph)
    state, result = await _execute(engine)
    assert result.reason == TerminateReason.REPLY
    assert state["seen"] == ["write:1", "audit:2"]


async def test_fanout_spec_runs_parallel_branch():
    """扇出规格：writer 同时到两个审计，汇聚到 chief 出口。"""
    spec = _spec(
        "fanout",
        [
            ("writer", "write", {"value": 1}),
            ("compliance", "audit", {"value": 2}),
            ("plot", "audit", {"value": 3}),
            ("chief", "write", {"value": 4}),
        ],
        [
            ("writer", "compliance"),
            ("writer", "plot"),
            ("compliance", "chief"),
            ("plot", "chief"),
        ],
    )
    graph = build_workflow_graph(spec, _registry())
    assert graph.entry == "writer"
    assert graph.exits == {"chief"}
    engine = make_engine(graph)
    state, result = await _execute(engine)
    assert result.reason == TerminateReason.REPLY
    # 扇出串行化：分支按稳定拓扑序衔接，全节点各执行一次
    assert state["seen"] == ["write:1", "audit:2", "audit:3", "write:4"]


def test_explicit_entry_used():
    spec = _spec(
        "explicit",
        [("b", "write", {}), ("a", "write", {})],
        [("a", "b")],
        entry="a",
    )
    graph = build_workflow_graph(spec, _registry())
    assert graph.entry == "a"


def test_entry_not_in_nodes_rejected():
    spec = _spec(
        "bad-entry",
        [("a", "write", {})],
        [],
        entry="missing",
    )
    with pytest.raises(GraphDefinitionError, match="入口节点不存在"):
        build_workflow_graph(spec, _registry())


def test_ambiguous_entry_rejected():
    """两个无入边节点且未声明入口：入口歧义，建图期拒绝。"""
    spec = _spec(
        "ambiguous",
        [("a", "write", {}), ("b", "write", {})],
        [],
    )
    with pytest.raises(GraphDefinitionError, match="入口歧义"):
        build_workflow_graph(spec, _registry())


def test_cycle_rejected():
    spec = _spec(
        "cycle",
        [("a", "write", {}), ("b", "write", {})],
        [("a", "b"), ("b", "a")],
    )
    with pytest.raises(GraphDefinitionError, match="循环依赖"):
        build_workflow_graph(spec, _registry())


def test_self_loop_rejected():
    spec = _spec("self-loop", [("a", "write", {})], [("a", "a")])
    with pytest.raises(GraphDefinitionError, match="循环依赖"):
        build_workflow_graph(spec, _registry())


def test_duplicate_node_id_rejected():
    spec = _spec(
        "dup",
        [("a", "write", {}), ("a", "audit", {})],
        [],
    )
    with pytest.raises(GraphDefinitionError, match="id 重复"):
        build_workflow_graph(spec, _registry())


def test_unknown_node_type_rejected():
    spec = _spec(
        "unknown-type",
        [("a", "not_registered", {})],
        [],
    )
    with pytest.raises(GraphDefinitionError, match="未知节点类型"):
        build_workflow_graph(spec, _registry())


def test_dangling_edge_rejected():
    spec = _spec(
        "dangling",
        [("a", "write", {})],
        [("a", "ghost")],
    )
    with pytest.raises(GraphDefinitionError, match="未知节点"):
        build_workflow_graph(spec, _registry())


def test_empty_spec_rejected():
    spec = _spec("empty", [], [])
    with pytest.raises(GraphDefinitionError, match="为空"):
        build_workflow_graph(spec, _registry())


def test_built_graph_passes_full_compile():
    """编译产物交给 Engine 构造不抛校验错（Graph.compile 建图期校验通过）。"""
    spec = _spec(
        "valid",
        [("a", "write", {}), ("b", "audit", {})],
        [("a", "b")],
    )
    graph = build_workflow_graph(spec, _registry())
    compiled = graph.compile()
    assert compiled is not None


def test_config_isolation_between_nodes():
    """同类型不同节点各持独立配置（一节点配置改动不波及另一节点）。"""
    spec = _spec(
        "isolation",
        [("a", "write", {"value": 1}), ("b", "write", {"value": 2})],
        [("a", "b")],
    )
    graph = build_workflow_graph(spec, _registry())
    # 两节点执行函数为独立闭包：值互不串扰（引擎仅建图，不执行）
    assert graph.nodes["a"] is not graph.nodes["b"]
