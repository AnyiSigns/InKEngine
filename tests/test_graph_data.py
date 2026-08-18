"""图定义数据化单测：序列化/重建/指纹/checkpoint 图版本/注册表解析。

语义检查点：图 = 可序列化数据（节点按注册类型名引用、条件边按条件名
引用、子图递归、schema 内联）；函数节点/函数条件无绑定即拒绝序列化
（防静默丢失）；内容指纹 = 图定义身份（checkpoint 图版本一致性校验的
依据——图定义变了恢复语义不保证，拒绝续跑）。
"""
from __future__ import annotations

import pytest
from conftest import make_engine

from ink_engine.core.exceptions import (
    GraphDefinitionError,
    GraphVersionMismatchError,
)
from ink_engine.core.graph import Edge, Graph, TerminateReason
from ink_engine.core.registry import (
    EdgeConditionRegistry,
    GraphRegistries,
    NodeTypeRegistry,
)
from ink_engine.core.state import StateSchema
from ink_engine.core.workflow import (
    WorkflowEdgeSpec,
    WorkflowNodeSpec,
    WorkflowSpec,
    build_workflow_graph,
)


def _node_factory(tag: str):
    """按配置构造节点执行函数（注册表工厂形态：配置透传实例化）。"""

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


def _declarative_graph() -> Graph:
    """声明式图：类型绑定节点 + 按名条件边 + schema（可序列化形态）。"""
    registries = _registries()
    graph = Graph(
        name="decl",
        entry="start",
        schema=StateSchema({"seen": None, "want_yes": None}),
    )
    graph.add_node_type("start", "write", {"value": 1})
    graph.add_node_type("yes", "write", {"value": 2})
    graph.add_node_type("no", "audit", {"value": 3})
    graph.add_conditional_edge_by_name("start", "yes", "want_yes")
    graph.add_conditional_edge_by_name("start", "no", "want_no")
    graph.add_exit("yes")
    graph.add_exit("no")
    graph.resolve_types(registries.nodes)
    graph.resolve_conditions(registries.edges)
    return graph


def test_edge_to_dict_requires_condition_name():
    """函数条件边无名字 → 序列化拒绝（函数不是数据，防静默丢失）。"""
    edge = Edge(target="b", condition=lambda ctx: True)
    with pytest.raises(GraphDefinitionError, match="未注册条件名"):
        edge.to_dict()


def test_graph_to_dict_rejects_function_node():
    """函数直挂节点无类型绑定 → 序列化拒绝。"""
    graph = Graph(name="g", entry="a")
    graph.add_node("a", lambda ctx: {})
    with pytest.raises(GraphDefinitionError, match="未注册类型名"):
        graph.to_dict()


def _rebuild_declarative() -> Graph:
    """声明式图重建（测试共用：序列化 → 注册表解析重建）。"""
    return Graph.from_dict(
        _declarative_graph().to_dict(),
        registry=_registries().nodes,
        edge_registry=_registries().edges,
    )


def test_graph_round_trip_preserves_structure():
    """声明式图序列化 → 重建：拓扑/条件名/schema/子图完整还原。"""
    rebuilt = _rebuild_declarative()
    assert rebuilt.name == "decl"
    assert rebuilt.entry == "start"
    assert rebuilt.exits == {"yes", "no"}
    assert len(rebuilt.edges["start"]) == 2
    edge_refs = {e.condition_name for e in rebuilt.edges["start"]}
    assert edge_refs == {"want_yes", "want_no"}
    assert isinstance(rebuilt.schema, StateSchema)
    assert rebuilt.schema.channels["seen"].reducer is None


async def test_rebuilt_graph_runs_conditionally():
    """重建图可执行且行为一致（条件边经注册表解析）。"""
    engine = make_engine(_rebuild_declarative())
    state, result = await engine._execute(
        state={"want_yes": True},
        thread_id="t",
        round_id=None,
        resume_from=None,
        trace_id="trace",
        queue=None,
    )
    assert result.reason == TerminateReason.REPLY
    assert state["seen"] == ["write:1", "write:2"]


async def test_rebuilt_graph_resolves_both_condition_branches():
    """重建图两分支行为一致（want_yes=False 走否分支——条件按名解析生效）。"""
    engine = make_engine(_rebuild_declarative())
    state, result = await engine._execute(
        state={"want_yes": False},
        thread_id="t",
        round_id=None,
        resume_from=None,
        trace_id="trace",
        queue=None,
    )
    assert result.reason == TerminateReason.REPLY
    assert state["seen"] == ["write:1", "audit:3"]


async def test_graph_round_trip_with_subgraph():
    """子图递归序列化：父图重建后子图节点仍可执行。"""
    sub = _declarative_graph()
    parent = Graph(name="parent", entry="sub")
    parent.add_subgraph("sub", sub)
    parent.add_exit("sub")
    data = parent.to_dict()
    rebuilt = Graph.from_dict(
        data,
        registry=_registries().nodes,
        edge_registry=_registries().edges,
    )
    assert "sub" in rebuilt.subgraphs
    engine = make_engine(rebuilt)
    state, result = await engine._execute(
        state={"want_yes": False},
        thread_id="t",
        round_id=None,
        resume_from=None,
        trace_id="trace",
        queue=None,
    )
    assert result.reason == TerminateReason.REPLY
    assert state["seen"] == ["write:1", "audit:3"]


def test_from_dict_rejects_unknown_condition():
    """重建时条件名未注册 → 建图期拒绝（不等到运行期判定才暴露）。"""
    data = _declarative_graph().to_dict()
    with pytest.raises(GraphDefinitionError, match="条件未注册"):
        Graph.from_dict(data, registry=_registries().nodes, edge_registry=EdgeConditionRegistry())


def test_from_dict_rejects_missing_fields():
    """图定义数据缺 name/entry → 建图期拒绝。"""
    with pytest.raises(GraphDefinitionError, match="缺 name/entry"):
        Graph.from_dict({}, registry=_registries().nodes, edge_registry=_registries().edges)


def test_digest_stable_across_rebuild():
    """内容指纹：同定义重建指纹一致（checkpoint 图版本跨进程可比对）。"""
    original = _declarative_graph()
    rebuilt = Graph.from_dict(
        original.to_dict(),
        registry=_registries().nodes,
        edge_registry=_registries().edges,
    )
    assert original.digest() == rebuilt.digest()


def test_digest_sensitive_to_topology_change():
    """内容指纹：拓扑/配置变更即变指纹（图定义身份可判定）。"""
    base = _declarative_graph()
    altered = _declarative_graph()
    altered.exits = {"yes"}
    assert base.digest() != altered.digest()
    config_changed = _declarative_graph()
    config_changed.node_bindings["start"] = type(config_changed.node_bindings["start"])(
        "write", {"value": 99}
    )
    assert base.digest() != config_changed.digest()


def test_digest_stable_for_function_nodes():
    """函数直挂图也可取指纹（模块级函数身份稳定；拓扑变更敏感）。"""
    from conftest import demo_linear_graph

    g1 = demo_linear_graph()
    g2 = demo_linear_graph()
    assert g1.digest() == g2.digest()


def test_workflow_graph_serializable():
    """工作流编译产物保留类型绑定：可序列化/重建（行为一致由重建图执行验证）。"""
    registry = _registries().nodes
    spec = WorkflowSpec(
        name="wf",
        nodes=(
            WorkflowNodeSpec(id="w", type="write", config={"value": 1}),
            WorkflowNodeSpec(id="a", type="audit", config={"value": 2}),
        ),
        edges=(WorkflowEdgeSpec(source="w", target="a"),),
    )
    graph = build_workflow_graph(spec, registry)
    data = graph.to_dict()
    rebuilt = Graph.from_dict(data, registry=registry)
    assert rebuilt.entry == "w"
    assert rebuilt.exits == {"a"}


async def test_rebuilt_workflow_runs():
    """重建的工作流图执行结果与原图一致。"""
    registry = _registries().nodes
    spec = WorkflowSpec(
        name="wf",
        nodes=(
            WorkflowNodeSpec(id="w", type="write", config={"value": 1}),
            WorkflowNodeSpec(id="a", type="audit", config={"value": 2}),
        ),
        edges=(WorkflowEdgeSpec(source="w", target="a"),),
    )
    graph = build_workflow_graph(spec, registry)
    rebuilt = Graph.from_dict(graph.to_dict(), registry=registry)
    engine = make_engine(rebuilt)
    state, result = await engine._execute(
        state={}, thread_id="t", round_id=None, resume_from=None, trace_id="trace", queue=None
    )
    assert result.reason == TerminateReason.REPLY
    assert state["seen"] == ["write:1", "audit:2"]


def test_state_schema_round_trip():
    """状态通道 schema 序列化/还原（含裸通道与 reducer 通道）。"""
    schema = StateSchema({"messages": "add_messages", "count": None, "metrics": "merge_metrics"})
    data = schema.to_dict()
    rebuilt = StateSchema.from_dict(data)
    assert rebuilt.channels["messages"].reducer == "add_messages"
    assert rebuilt.channels["count"].reducer is None
    assert rebuilt.channels["metrics"].reducer == "merge_metrics"
    assert StateSchema.from_dict(None) is None


def test_edge_condition_registry_rejects_duplicate():
    """条件名重复注册 → 建图期拒绝（防静默覆盖语义）。"""
    registry = EdgeConditionRegistry()
    registry.register("c1", lambda ctx: True)
    with pytest.raises(GraphDefinitionError, match="重复注册"):
        registry.register("c1", lambda ctx: False)
    assert registry.names() == ("c1",)


async def test_checkpoint_carries_graph_version(memory_storage):
    """checkpoint 携带图版本：执行后链尾快照的 graph_version = 图指纹。"""
    graph = _declarative_graph()
    engine = make_engine(graph, storage=memory_storage)
    _, result = await engine._execute(
        state={"want_yes": True},
        thread_id="t1",
        round_id=None,
        resume_from=None,
        trace_id="trace",
        queue=None,
    )
    assert result.reason == TerminateReason.REPLY
    tail = await memory_storage.get_latest_checkpoint("t1")
    assert tail is not None
    assert tail.graph_version == graph.digest()


async def test_resume_rejects_changed_graph(memory_storage):
    """恢复锚点图版本不匹配 → 显式拒绝（图定义变了恢复语义不保证）。"""
    graph = _declarative_graph()
    engine = make_engine(graph, storage=memory_storage)
    _, result = await engine._execute(
        state={"want_yes": True},
        thread_id="t1",
        round_id=None,
        resume_from=None,
        trace_id="trace",
        queue=None,
    )
    assert result.checkpoint_id is not None
    # 图定义变更（节点配置不同 → 指纹不同）：同锚点续跑被拒绝
    altered = _declarative_graph()
    altered.node_bindings["start"] = type(altered.node_bindings["start"])(
        "write", {"value": 100}
    )
    engine2 = make_engine(altered, storage=memory_storage)
    with pytest.raises(GraphVersionMismatchError, match="图定义版本与恢复锚点不匹配"):
        await engine2._execute(
            state={},
            thread_id="t1",
            round_id=None,
            resume_from=result.checkpoint_id,
            trace_id="trace",
            queue=None,
        )


async def test_resume_same_graph_continues(memory_storage):
    """图版本一致时恢复正常续跑（同定义重建引擎同样通过——指纹按内容）。"""
    graph = _declarative_graph()
    engine = make_engine(graph, storage=memory_storage)
    _, result = await engine._execute(
        state={"want_yes": True},
        thread_id="t1",
        round_id=None,
        resume_from=None,
        trace_id="trace",
        queue=None,
    )
    rebuilt = Graph.from_dict(
        graph.to_dict(),
        registry=_registries().nodes,
        edge_registry=_registries().edges,
    )
    engine2 = make_engine(rebuilt, storage=memory_storage)
    _, result2 = await engine2._execute(
        state={},
        thread_id="t1",
        round_id=None,
        resume_from=result.checkpoint_id,
        trace_id="trace",
        queue=None,
    )
    assert result2.reason in (TerminateReason.REPLY, TerminateReason.STOP)


async def test_continue_chain_switches_graph(memory_storage):
    """continue_chain 换图放行：续链不重放事件，同 thread 换 harness 合法。

    回归 P1-3：修复前 _assert_graph_version 对续链链尾一并校验，
    新图 + continue_chain 被硬拒（M3 同 thread 按任务切 harness 的核心
    场景）；图版本校验只作用于 resume_from 真恢复。
    """
    engine1 = make_engine(_declarative_graph(), storage=memory_storage)
    _, result = await engine1._execute(
        state={"want_yes": True},
        thread_id="t1",
        round_id=None,
        resume_from=None,
        trace_id="trace",
        queue=None,
    )
    assert result.reason == TerminateReason.REPLY
    # 换一张不同的图（入口不同/节点不同 → 指纹不同）续链
    other = Graph(name="other", entry="a")
    other.add_node("a", lambda ctx: {"other": True})
    other.add_exit("a")
    engine2 = make_engine(other, storage=memory_storage)
    _, result2 = await engine2._execute(
        state={"seed": 1},
        thread_id="t1",
        round_id=None,
        resume_from=None,
        continue_chain=True,
        trace_id="trace",
        queue=None,
    )
    assert result2.reason == TerminateReason.REPLY
    assert result2.state.get("other") is True
    # 同一 thread 用旧图 resume_from 仍拒绝（真恢复校验不受影响）
    engine3 = make_engine(other, storage=memory_storage)
    with pytest.raises(GraphVersionMismatchError):
        await engine3._execute(
            state={},
            thread_id="t1",
            round_id=None,
            resume_from=result.checkpoint_id,
            trace_id="trace",
            queue=None,
        )


async def test_engine_accepts_foreign_schema_shape(memory_storage):
    """顶层 graph.schema 为引擎不识别的形态（dict）：Engine 构造不崩。

    回归 P1-7：修复前 digest() 无条件调 schema.to_dict（无 hasattr 守卫），
    dict 形态 schema 让 Engine() 直接 AttributeError——对宿主的静默
    破坏性变更；现退化为 repr(type) 参与指纹。
    """
    graph = Graph(name="g", entry="a", schema={"channels": {"x": None}})
    graph.add_node("a", lambda ctx: {})
    graph.add_exit("a")
    engine = make_engine(graph, storage=memory_storage)
    assert engine._graph_digest  # 构造成功且指纹可计算
    _, result = await engine._execute(
        state={},
        thread_id="t1",
        round_id=None,
        resume_from=None,
        trace_id="trace",
        queue=None,
    )
    assert result.reason == TerminateReason.REPLY


def test_to_dict_unresolved_declarative_keeps_nodes():
    """未解析的声明式图序列化不丢节点（回归 P0-2）。

    修复前 to_dict/digest 遍历 self.nodes（resolve_types 前为空），
    声明式图直接序列化产出空节点集（边/出口照旧）——静默数据丢失。
    """
    graph = Graph(name="decl", entry="start")
    graph.add_node_type("start", "write", {"value": 1})
    graph.add_node_type("yes", "write", {"value": 2})
    graph.add_conditional_edge_by_name("start", "yes", "want_yes")
    graph.add_exit("yes")
    data = graph.to_dict()
    assert set(data["nodes"]) == {"start", "yes"}
    assert data["nodes"]["start"]["type"] == "write"
    assert data["nodes"]["start"]["config"] == {"value": 1}
    # 重建（含校验）后节点齐备，可编译
    rebuilt = Graph.from_dict(
        data,
        registry=_registries().nodes,
        edge_registry=_registries().edges,
        validate=True,
    )
    assert set(rebuilt.nodes) == {"start", "yes"}
    # 指纹稳定：未解析与解析后的图定义数据指纹一致（同一份图定义）
    assert graph.digest() == rebuilt.digest()


def test_to_dict_config_not_shared_with_binding():
    """to_dict 不外泄 config 引用：修改序列化结果不得污染活图（回归 P1-6）。"""
    graph = Graph(name="g", entry="a")
    graph.add_node_type("a", "write", {"value": 1})
    data = graph.to_dict()
    data["nodes"]["a"]["config"]["value"] = 999
    assert graph.node_bindings["a"].config["value"] == 1


def test_from_dict_malformed_types_rejected():
    """from_dict 类型闸门：nodes/edges/subgraphs/config 类型错乱 → GraphDefinitionError。

    回归 P1-4：修复前畸形输入抛 AttributeError 直接穿出 _execute
    （无 error 事件/终态 checkpoint，run 硬崩）；现统一收口为
    GraphDefinitionError（执行器按节点失败处理）。
    """
    base = _declarative_graph().to_dict()
    cases = [
        {"nodes": "nope"},
        {"edges": {"a": "not-a-list"}},
        {"edges": {"a": [{"target": "b", "condition": 123}]}},
        {"subgraphs": {"s": "nope"}},
        {"nodes": {"a": {"type": "write", "config": "nope"}}},
        {"nodes": {"a": "not-a-dict"}},
        {"exits": "nope"},
    ]
    for patch in cases:
        data = {**base, **patch}
        with pytest.raises(GraphDefinitionError):
            Graph.from_dict(data)
    # 顶层非 dict
    with pytest.raises(GraphDefinitionError):
        Graph.from_dict(["not", "dict"])


def test_from_dict_validate_rejects_dangling_refs():
    """from_dict(validate=True)：悬挂出口/边源不存在 → GraphDefinitionError。

    回归 P1-5：修复前 from_dict 不做结构校验，非法定义延后到执行期
    才暴露（spawn 子图实例 compile 失败被剔除 → 静默降级）。
    """
    base = _declarative_graph().to_dict()
    # 悬挂出口
    dangling = {**base, "exits": ["yes", "ghost"]}
    with pytest.raises(GraphDefinitionError):
        Graph.from_dict(
            dangling,
            registry=_registries().nodes,
            edge_registry=_registries().edges,
            validate=True,
        )
    # 边源不存在
    ghost_edge = {**base, "edges": {"ghost": [{"target": "yes"}]}}
    with pytest.raises(GraphDefinitionError):
        Graph.from_dict(
            ghost_edge,
            registry=_registries().nodes,
            edge_registry=_registries().edges,
            validate=True,
        )
    # validate=False 保持宽容（既有语义：结构校验交给编译期）
    rebuilt = Graph.from_dict(
        dangling,
        registry=_registries().nodes,
        edge_registry=_registries().edges,
    )
    assert "ghost" in rebuilt.exits
