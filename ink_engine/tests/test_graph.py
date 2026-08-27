"""图定义 DSL 单测：compile 校验/节点注册/条件边/嵌套图/循环回路。"""
from __future__ import annotations

import pytest
from conftest import demo_conditional_graph, demo_linear_graph, demo_loop_graph

from ink_engine.core.exceptions import GraphDefinitionError, NodeNotFoundError
from ink_engine.core.graph import Graph


def test_compile_ok_linear():
    demo_linear_graph().compile()


def test_compile_missing_entry():
    g = Graph(name="g", entry="nope")
    with pytest.raises(GraphDefinitionError):
        g.compile()


def test_compile_missing_edge_target():
    g = Graph(name="g", entry="a")
    g.add_node("a", lambda ctx: {})
    g.add_edge("a", "ghost")
    with pytest.raises(NodeNotFoundError):
        g.compile()


def test_compile_missing_exit():
    g = Graph(name="g", entry="a")
    g.add_node("a", lambda ctx: {})
    g.add_node("b", lambda ctx: {})
    g.add_edge("a", "b")
    g.add_exit("ghost")
    with pytest.raises(NodeNotFoundError):
        g.compile()


def test_compile_missing_source():
    g = Graph(name="g", entry="a")
    g.add_node("a", lambda ctx: {})
    g.add_edge("ghost", "a")
    with pytest.raises(NodeNotFoundError):
        g.compile()


def test_conditional_graph_nodes_registered():
    g = demo_conditional_graph()
    assert set(g.nodes) == {"start", "yes", "no"}
    assert len(g.edges["start"]) == 2


def test_loop_graph_self_edge():
    g = demo_loop_graph()
    targets = [e.target for e in g.edges["loop"]]
    assert targets == ["loop", "exit"]


def test_subgraph_conflict_name():
    g = Graph(name="parent", entry="sub")
    sub = Graph(name="sub", entry="a")
    sub.add_node("a", lambda ctx: {})
    sub.add_exit("a")
    g.add_node("sub", lambda ctx: {})  # 先占同名
    with pytest.raises(GraphDefinitionError):
        g.add_subgraph("sub", sub)


def test_subgraph_register_ok():
    g = Graph(name="parent", entry="sub")
    sub = Graph(name="sub", entry="a")
    sub.add_node("a", lambda ctx: {})
    sub.add_exit("a")
    g.add_subgraph("sub", sub)
    assert "sub" in g.subgraphs
    assert "sub" in g.nodes
    g.compile()


def test_compile_rejects_static_and_conditional_mix():
    """静态边与条件边混用 → 编译期拒绝（静态边优先会闷杀条件边）。"""
    g = Graph(name="g", entry="a")
    g.add_node("a", lambda ctx: {})
    g.add_node("b", lambda ctx: {})
    g.add_node("c", lambda ctx: {})
    g.add_edge("a", "b")  # 静态边
    g.add_conditional_edge("a", "c", lambda ctx: True)  # 条件边被闷杀
    g.add_exit("b")
    with pytest.raises(GraphDefinitionError):
        g.compile()


def test_compile_validates_nested_subgraph_early():
    """非法子图在父图 compile 期暴露（不等到运行时才失败）。"""
    parent = Graph(name="parent", entry="sub")
    sub = Graph(name="sub", entry="ghost")  # 子图入口不存在
    sub.add_node("a", lambda ctx: {})
    sub.add_exit("a")
    parent.add_subgraph("sub", sub)
    with pytest.raises(GraphDefinitionError):
        parent.compile()


def test_digest_excludes_name():
    from ink_engine.core.contracts import NodeContract
    """ENG9a-18 回归：Graph.digest 不参与 name——同拓扑不同图名 = 同一指纹。

    候选图名随排名生成时，同拓扑不同排名不得产出不同指纹（缓存身份
    按拓扑判定，name 是展示/路由标签而非图定义身份）。
    """
    def build(name: str) -> Graph:
        g = Graph(name=name, entry="a")
        g.add_node_type("a", "intent_parse", contract=NodeContract())
        g.add_node_type("b", "answer_direct", contract=NodeContract())
        g.add_edge("a", "b")
        g.add_exit("b")
        return g

    assert build("assembly.1.code").digest() == build("assembly.2.code").digest()
    assert build("assembly.1.code").digest() == build("any.other.name").digest()
    # 拓扑变化仍改变指纹（name 不变性不与身份敏感性冲突）
    def other(name: str) -> Graph:
        g = Graph(name=name, entry="a")
        g.add_node_type("a", "intent_parse", contract=NodeContract())
        g.add_node_type("c", "code_gen", contract=NodeContract())
        g.add_edge("a", "c")
        g.add_exit("c")
        return g

    assert other("assembly.1.code").digest() != build("assembly.1.code").digest()


def test_resolve_conditions_position_based_replacement():
    """ENG2-15 回归：同源多条件边按位置解析（不再 edge_list.index 错替）。"""

    class Registry:
        def create(self, name: str):
            def condition(ctx):
                return True

            return condition

    g = Graph(name="g", entry="a")
    g.add_node("a", lambda ctx: {})
    g.add_node("b", lambda ctx: {})
    g.add_node("c", lambda ctx: {})
    # 同源两条条件边：目标不同、条件名不同（旧 index 语义的错替场景）
    g.add_conditional_edge_by_name("a", "b", "cond_b")
    g.add_conditional_edge_by_name("a", "c", "cond_c")
    g.add_exit("c")
    g.resolve_conditions(Registry())
    resolved = g.edges["a"]
    assert [e.target for e in resolved] == ["b", "c"]
    # 每条边按自身条件名解析（b 边绑 cond_b、c 边绑 cond_c——不被首条
    # 同 target 边错替）
    assert resolved[0].target == "b" and resolved[0].condition_name == "cond_b"
    assert resolved[1].target == "c" and resolved[1].condition_name == "cond_c"
    assert all(e.condition is not None for e in resolved)
