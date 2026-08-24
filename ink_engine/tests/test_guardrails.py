"""子链护栏单测（嵌套深度上限 / 推演分支步数截止 / 默认值回归）。

覆盖口径（fail-closed 硬护栏）：
- spawn 嵌套深度 N+1 拒绝 = 节点失败（与清单超限同口径收口）；
- 默认深度内的多层嵌套兼容（产品层「仅策略层产 spawn」约束在引擎
  护栏内工作，不冲突）；
- 推演分支步数超限 = 分支失败剔除；全部超限 = 决策点无产出，按节点
  失败收口（不静默提交空结果）；
- 分支步数截止线以内正常选题（护栏不误杀）；
- 护栏默认参数值回归（数据化，装配可覆盖）。
"""

from __future__ import annotations

from conftest import make_engine

from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.run_result import RunOptions
from ink_engine.core.simulation import (
    SIMULATE_KEY,
    Evaluation,
    Evaluator,
    SimulateSpec,
)
from ink_engine.core.spawn import SPAWN_KEY


def _line_subgraph(steps: int, name: str = "line") -> Graph:
    """线性子图：steps 个节点顺序执行（末节点为出口），每节点写步数标记。"""

    g = Graph(name=name, entry="n0")
    for i in range(steps):

        async def node(ctx, _i: int = i):
            return {"step_mark": _i}

        g.add_node(f"n{i}", node)
        if i > 0:
            g.add_edge(f"n{i - 1}", f"n{i}")
    g.add_exit(f"n{steps - 1}")
    return g


def _leaf_graph(value: int = 1) -> Graph:
    """叶子子图：单节点返回 seed+value（供嵌套回流断言）。"""

    async def s1(ctx):
        return {"sub_value": ctx.state.get("seed", 0) + value}

    g = Graph(name="leaf", entry="s1")
    g.add_node("s1", s1)
    g.add_exit("s1")
    return g


def _decision_graph(route) -> Graph:
    g = Graph(name="decision", entry="route")
    g.add_node("route", route)
    g.add_exit("route")
    return g


async def test_spawn_depth_limit_rejects_child_when_max_is_one(memory_storage):
    """深度上限 1：根（深度 0）产一层子图合法（产品「策略层产 spawn」语义）；
    子图内再产 spawn = 深度 2 > 1，实例失败剔除（fail-closed 留痕）。"""

    async def b_route(ctx):
        return {SPAWN_KEY: [{"subgraph": _leaf_graph(), "state": {}, "index": 0}]}

    b = Graph(name="b", entry="b_route")
    b.add_node("b_route", b_route)
    b.add_exit("b_route")

    async def a_route(ctx):
        return {SPAWN_KEY: [{"subgraph": b, "state": {}, "index": 0}]}

    a = Graph(name="a", entry="a_route")
    a.add_node("a_route", a_route)
    a.add_exit("a_route")

    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": a, "state": {}, "index": 0}]}

    engine = make_engine(
        _decision_graph(route), storage=memory_storage, spawn_max_depth=1
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY  # 实例失败剔除，父链继续
    events = [e for e in engine.options.transports[0].events if e.type == "error"]
    assert any("嵌套深度超限" in (e.payload.get("message") or "") for e in events)


async def test_spawn_depth_limit_rejects_third_level_with_default(memory_storage):
    """默认深度 2：三层链（根→A→B 合法，B 内再 spawn）实例失败剔除留痕。"""

    async def b_route(ctx):
        return {SPAWN_KEY: [{"subgraph": _leaf_graph(), "state": {}, "index": 0}]}

    b = Graph(name="b", entry="b_route")
    b.add_node("b_route", b_route)
    b.add_exit("b_route")

    async def a_route(ctx):
        return {SPAWN_KEY: [{"subgraph": b, "state": {}, "index": 0}]}

    a = Graph(name="a", entry="a_route")
    a.add_node("a_route", a_route)
    a.add_exit("a_route")

    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": a, "state": {}, "index": 0}]}

    engine = make_engine(_decision_graph(route), storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY  # 实例失败剔除，父链继续
    events = [e for e in engine.options.transports[0].events if e.type == "error"]
    assert any("嵌套深度超限" in (e.payload.get("message") or "") for e in events)


async def test_spawn_depth_allows_nested_within_max(memory_storage):
    """默认深度 2：根→A→B 两层嵌套合法执行（护栏不误杀产品层约束）。"""

    async def a_route(ctx):
        return {SPAWN_KEY: [{"subgraph": _leaf_graph(), "state": {"seed": 1}, "index": 0}]}

    a = Graph(name="a", entry="a_route")
    a.add_node("a_route", a_route)
    a.add_exit("a_route")

    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": a, "state": {}, "index": 0}]}

    engine = make_engine(_decision_graph(route), storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state.get("sub_value") == 2


class AlwaysPassEvaluator:
    """确定性评估器：恒通过、恒正分（步数截止回归用）。"""

    async def evaluate(self, branch: SimulateSpec, overlay: dict) -> Evaluation:
        return Evaluation(score=1.0, passed=True, note="guardrail")


async def test_simulate_branch_steps_limit_overrun_is_node_error(memory_storage):
    """分支步数超限：3 节点分支在 limit=2 下失败，唯一分支全失败 = 节点失败。"""

    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [{"subgraph": _line_subgraph(3), "state": {}, "index": 0}]
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=AlwaysPassEvaluator(),
        simulate_max_branch_steps=2,
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.ERROR
    assert "步数超限" in (result.error or "")


async def test_simulate_branch_within_steps_limit_passes(memory_storage):
    """分支步数截止线以内：3 节点分支在 limit=3 下正常选题提交主线。"""

    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [{"subgraph": _line_subgraph(3), "state": {}, "index": 0}]
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=AlwaysPassEvaluator(),
        simulate_max_branch_steps=3,
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state.get("step_mark") == 2


def test_guardrail_defaults_are_data_driven():
    """护栏默认值回归（数据化参数，装配可按数据覆盖）。"""
    opts = RunOptions()
    assert opts.spawn_max_depth == 2
    assert opts.simulate_max_branch_steps == 16
    assert opts.spawn_depth == 0
