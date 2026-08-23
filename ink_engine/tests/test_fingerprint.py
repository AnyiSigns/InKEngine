"""路径指纹单测：算法归引擎（复用图摘要），上下文指纹钉模型/上下文。

覆盖：图指纹 = 图定义规范摘要（拓扑变更即指纹变化、同定义稳定）；
上下文指纹含图摘要 + 上下文 + 模型标识（漂移即不命中）。
"""
from __future__ import annotations

from ink_engine.core.fingerprint import context_fingerprint, graph_fingerprint
from ink_engine.core.graph import Graph


def _graph(name: str = "g") -> Graph:
    g = Graph(name=name, entry="a")
    g.add_node("a", lambda ctx: {"x": 1})
    g.add_node("b", lambda ctx: {"y": 2})
    g.add_edge("a", "b")
    g.add_exit("b")
    return g


def test_graph_fingerprint_stable():
    """同一定义指纹稳定；拓扑变更即指纹变化。"""
    g1 = _graph()
    g2 = _graph()
    assert graph_fingerprint(g1) == graph_fingerprint(g2)
    g1.add_node("c", lambda ctx: {"z": 3})
    g1.add_edge("b", "c")
    g1.add_exit("c")
    assert graph_fingerprint(g1) != graph_fingerprint(g2)


def test_graph_fingerprint_is_digest():
    """图指纹 = Graph.digest（算法复用，不另立实现）。"""
    g = _graph()
    assert graph_fingerprint(g) == g.digest()


def test_context_fingerprint_binds_context_and_model():
    """上下文指纹钉上下文与模型标识：漂移即不命中。"""
    g = _graph()
    base = context_fingerprint(g, context={"goal": "x"}, model_id="m1")
    assert base == context_fingerprint(g, context={"goal": "x"}, model_id="m1")
    assert base != context_fingerprint(g, context={"goal": "y"}, model_id="m1")
    assert base != context_fingerprint(g, context={"goal": "x"}, model_id="m2")
    assert context_fingerprint(g) != context_fingerprint(g, context={"goal": "x"})


def test_context_fingerprint_hexdigest_shape():
    """sha256 十六进制形态（64 字符），JSON 规范序（键序无关）。"""
    g = _graph()
    fp = context_fingerprint(g, context={"a": 1, "b": 2}, model_id="m")
    assert len(fp) == 64
    assert all(c in "0123456789abcdef" for c in fp)
    assert fp == context_fingerprint(g, context={"b": 2, "a": 1}, model_id="m")
