"""引擎单测共享基础设施（纯内存，零外部依赖）。

提供：内存存储 fixture、事件收集传输、demo 图工厂（线性/条件边/
循环回路），测试聚焦引擎机制而非业务。
"""
from __future__ import annotations

import pytest

from ink_engine.core.budget import BudgetPolicy
from ink_engine.core.events import CollectorTransport
from ink_engine.core.exceptions import BudgetExceededError
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.graph import Graph
from ink_engine.core.storage import create_storage


@pytest.fixture
def memory_storage():
    storage = create_storage("memory://")
    yield storage


@pytest.fixture
def transport():
    return CollectorTransport()


def make_engine(
    graph: Graph,
    storage=None,
    budget=None,
    schema=None,
    *,
    transports=None,
    **kw,
) -> Engine:
    return Engine(
        graph,
        options=RunOptions(
            storage=storage,
            budget=budget,
            schema=schema,
            transports=transports or [CollectorTransport()],
            **kw,
        ),
    )


def demo_linear_graph() -> Graph:
    """线性图：start → mid → end（每节点累加计数，end 为出口）。"""

    async def start(ctx):
        return {"count": 1}

    async def mid(ctx):
        return {"count": ctx.state.get("count", 0) + 1}

    async def end(ctx):
        return {"count": ctx.state.get("count", 0) + 1}

    g = Graph(name="linear", entry="start")
    g.add_node("start", start)
    g.add_node("mid", mid)
    g.add_node("end", end)
    g.add_edge("start", "mid")
    g.add_edge("mid", "end")
    g.add_exit("end")
    return g


def demo_conditional_graph() -> Graph:
    """条件边图：start 按 want_yes 分流到 yes / no（条件边逐个判定）。"""

    async def start(ctx):
        return {}

    async def yes(ctx):
        return {"branch": "yes"}

    async def no(ctx):
        return {"branch": "no"}

    async def want_yes(ctx):
        return ctx.state.get("want_yes", False) is True

    async def want_no(ctx):
        return ctx.state.get("want_yes", False) is False

    g = Graph(name="conditional", entry="start")
    g.add_node("start", start)
    g.add_node("yes", yes)
    g.add_node("no", no)
    g.add_conditional_edge("start", "yes", want_yes)
    g.add_conditional_edge("start", "no", want_no)
    g.add_exit("yes")
    g.add_exit("no")
    return g


def demo_loop_graph() -> Graph:
    """循环回路图：start → loop（count<3 回指自身）→ exit。"""

    async def start(ctx):
        return {"count": 0}

    async def loop(ctx):
        return {"count": ctx.state.get("count", 0) + 1}

    async def again(ctx):
        return ctx.state.get("count", 0) < 3

    g = Graph(name="loop", entry="start")
    g.add_node("start", start)
    g.add_node("loop", loop)
    g.add_node("exit", lambda ctx: {"done": True})
    g.add_edge("start", "loop")
    g.add_conditional_edge("loop", "loop", again)
    g.add_conditional_edge("loop", "exit", lambda ctx: not ctx.state.get("count", 0) < 3)
    g.add_exit("exit")
    return g


class DemoBudgetPolicy(BudgetPolicy):
    """测试预算策略：节点边界访问计数超限即抛超限（fail-closed 演示）。"""

    def __init__(self, max_nodes: int = 5):
        self.max_nodes = max_nodes
        self.visited: list[str] = []

    async def check(self, ctx) -> None:
        node = getattr(ctx, "node", None)
        self.visited.append(node or "")
        if len(self.visited) > self.max_nodes:
            raise BudgetExceededError("nodes", self.max_nodes, len(self.visited))


@pytest.fixture
def assembled_runtime():
    """装配运行时（含池治理登记器 + 内省服务），供桥 op 测试。"""
    import importlib
    import sys
    from pathlib import Path

    from ink_engine.core.pool_governance import PoolGovernance
    from ink_engine.core.runtime import Runtime

    runtime = Runtime()
    runtime.pool_governance = PoolGovernance()
    runtime._state = "running"

    # 内省服务（含图数据源）
    from ink_engine.core.introspection import IntrospectionService, IntrospectionSources

    graph = demo_linear_graph()
    runtime.introspection_service = IntrospectionService(
        IntrospectionSources(graph=graph)
    )

    # 加载桥模块（路径含点，需手动加载）
    repo_root = Path(__file__).resolve().parents[2]
    bridge_path = repo_root / "inkling" / "shell" / "src-tauri" / "src" / "engine" / "py" / "bridge.py"
    spec = importlib.util.spec_from_file_location("inkling_bridge", bridge_path)
    bridge = importlib.util.module_from_spec(spec)
    sys.modules["inkling_bridge"] = bridge
    spec.loader.exec_module(bridge)
    bridge.bind_runtime(runtime, None)
    yield runtime
    bridge.bind_runtime(None, None)


@pytest.fixture
def runtime_with_edges(assembled_runtime):
    """带边证据存储的运行时。"""
    import asyncio

    from ink_engine.core.edge_evidence import EdgeEvidence, EdgeEvidenceStore, EdgeKey

    store = EdgeEvidenceStore()
    assembled_runtime.edge_evidence_store = store
    key = EdgeKey(src_type="a", dst_type="b", context_domain="code")
    asyncio.run(
        store.put(
            EdgeEvidence(
                key=key,
                success_count=10,
                fail_count=2,
                avg_cost=1.5,
                last_used_at=1_800_000_000.0,
                created_at=1_800_000_000.0,
            )
        )
    )
    return assembled_runtime


__all__ = [
    "DemoBudgetPolicy",
    "assembled_runtime",
    "demo_conditional_graph",
    "demo_linear_graph",
    "demo_loop_graph",
    "make_engine",
    "memory_storage",
    "runtime_with_edges",
    "transport",
]
