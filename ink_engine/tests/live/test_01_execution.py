"""族 1：执行内核（test_01_execution.py）｜executor/budget/fanout/plan/
spawn/simulation/recovery/interrupt。

- 线性图真实回合（事件流/state/终止原因）；条件边；循环护栏
- 嵌套子图（graph_path 轨迹）
- checkpoint 恢复 / 图版本不匹配拒绝 / 恢复锚点 + 重放纪律
- 预算护栏 / error_on_exception 跳过 / 节点重试
- fan_out 并发发散（部分失败剔除）
- __plan__ 重规划（宽松域）/ __spawn__ 子任务（收集+护栏）/ __simulate__
  推演（打分+择优+落选分支保留）
- interrupt 挂起/注入/重入/持久化（跨实例恢复）

`real` 标记 = 真实 LLM 调用（族门禁②）；其余为确定性机制用例（零费用）。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.budget import BudgetManager, BudgetPolicy  # noqa: E402
from ink_engine.core.events import CollectorTransport  # noqa: E402
from ink_engine.core.exceptions import BudgetExceededError, GraphVersionMismatchError  # noqa: E402
from ink_engine.core.executor import Engine, RunOptions  # noqa: E402
from ink_engine.core.fanout import fan_out  # noqa: E402
from ink_engine.core.graph import Graph, TerminateReason  # noqa: E402
from ink_engine.core.llm.messages import user  # noqa: E402
from ink_engine.core.plan import PLAN_KEY  # noqa: E402
from ink_engine.core.simulation import (  # noqa: E402
    SIMULATE_KEY,
    BestBranchMixer,
    Evaluation,
)
from ink_engine.core.spawn import SPAWN_KEY  # noqa: E402


def _engine(graph: Graph, storage=None, **kw) -> Engine:
    return Engine(graph, options=RunOptions(storage=storage, transports=[CollectorTransport()], **kw))


def _sub_graph(seed: int) -> Graph:
    async def node(ctx):
        await ctx.emit("sub_run", {"seed": ctx.state.get("seed", 0)})
        return {"sub_value": ctx.state.get("seed", 0) + seed}

    g = Graph(name=f"sub{seed}", entry="s1")
    g.add_node("s1", node)
    g.add_exit("s1")
    return g


class StepBudgetPolicy(BudgetPolicy):
    """节点边界预算：访问计数超限即抛超限（fail-closed）。"""

    def __init__(self, max_nodes: int):
        self.max_nodes = max_nodes
        self.visited: list[str] = []

    async def check(self, ctx) -> None:
        node = getattr(ctx, "node", None)
        self.visited.append(node or "")
        if len(self.visited) > self.max_nodes:
            raise BudgetExceededError("nodes", self.max_nodes, len(self.visited))


# ----------------------------------------------------------------------
# 线性图真实回合（族门禁②：本族 ≥1 条真实 LLM 驱动用例）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_linear_round(live_llm):
    """真实 LLM 回合：节点闭包持真实模型 → 状态/事件/终止原因全断言。"""
    transport = CollectorTransport()

    async def llm_node(ctx):
        result = await live_llm.ainvoke([user("请用一句话回答：什么是人工智能？")])
        await ctx.emit("llm_reply", {"content": result.content})
        return {"answer": result.content}

    g = Graph(name="real_linear", entry="start")
    g.add_node("start", lambda ctx: {"count": 1})
    g.add_node("llm_node", llm_node)
    g.add_node("end", lambda ctx: {"done": True})
    g.add_edge("start", "llm_node")
    g.add_edge("llm_node", "end")
    g.add_exit("end")

    engine = Engine(g, options=RunOptions(transports=[transport]))
    result = await engine.ainvoke({}, thread_id="real-linear")
    assert result.reason == TerminateReason.REPLY
    assert isinstance(result.state["answer"], str) and result.state["answer"].strip()
    assert result.state["done"] is True
    # 节点内事件真实发射
    assert any(e.type == "llm_reply" and e.payload["content"] for e in transport.events)


# ----------------------------------------------------------------------
# 条件边 / 循环 / 嵌套子图
# ----------------------------------------------------------------------

async def test_conditional_branch(memory_storage):
    async def yes(ctx):
        return {"branch": "yes"}

    g = Graph(name="cond", entry="start")
    g.add_node("start", lambda ctx: {})
    g.add_node("yes", yes)
    g.add_node("no", lambda ctx: {"branch": "no"})
    g.add_conditional_edge("start", "yes", lambda ctx: True)
    g.add_conditional_edge("start", "no", lambda ctx: False)
    g.add_exit("yes")
    g.add_exit("no")
    engine = _engine(g, storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state["branch"] == "yes"


async def test_loop_within_guard(memory_storage):
    async def loop(ctx):
        count = ctx.state.get("count", 0) + 1
        await ctx.emit("loop_tick", {"count": count})
        return {"count": count}

    g = Graph(name="loop", entry="start")
    g.add_node("start", lambda ctx: {"count": 0})
    g.add_node("loop", loop)
    g.add_node("exit", lambda ctx: {"done": True})
    g.add_edge("start", "loop")
    g.add_conditional_edge("loop", "loop", lambda ctx: ctx.state.get("count", 0) < 3)
    g.add_conditional_edge("loop", "exit", lambda ctx: ctx.state.get("count", 0) >= 3)
    g.add_exit("exit")
    engine = _engine(g, storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.state["count"] == 3
    assert result.state["done"] is True
    ticks = [e for e in engine.options.transports[0].events if e.type == "loop_tick"]
    assert len(ticks) == 3


async def test_nested_subgraph_graph_path(memory_storage):
    async def inner(ctx):
        await ctx.emit("inner_run", {})
        return {"inner_done": True}

    sub = Graph(name="inner", entry="i1")
    sub.add_node("i1", inner)
    sub.add_exit("i1")

    async def outer(ctx):
        return {"outer": 1}

    g = Graph(name="outer", entry="o1")
    g.add_node("o1", outer)
    g.add_subgraph("sub", sub)
    g.add_edge("o1", "sub")
    g.add_exit("sub")
    engine = _engine(g, storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.state["inner_done"] is True
    inner_events = [e for e in engine.options.transports[0].events if e.type == "inner_run"]
    assert inner_events
    assert inner_events[0].graph_path == ("inner",)  # 路径 = 子图自身图名


# ----------------------------------------------------------------------
# checkpoint / 恢复 / 重放
# ----------------------------------------------------------------------

async def test_checkpoint_resume_and_replay(memory_storage):
    """断线续流：中断 checkpoint → 新引擎注入决议重入 → 锚点后增量日志重放。"""
    async def gate(ctx):
        await ctx.interrupt("gate", {"q": "继续?"})
        return {}

    async def node_b(ctx):
        await ctx.emit("work_b", {"n": 1})
        return {"b": 1}

    g = Graph(name="cp", entry="a")
    g.add_node("a", gate)
    g.add_node("b", node_b)
    g.add_edge("a", "b")
    g.add_exit("b")
    engine1 = _engine(g, storage=memory_storage)
    first = await engine1.ainvoke({}, thread_id="t")
    assert first.interrupt is not None and first.checkpoint_id is not None
    # 新引擎/新传输恢复：快照状态保留 + 锚点后增量日志重放（断线续流）
    engine2 = _engine(g, storage=memory_storage)
    resumed = await engine2.ainvoke(
        {}, thread_id="t", resume_from=first.checkpoint_id, inject={"gate": "accept"}
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state["b"] == 1
    replayed = [e for e in engine2.options.transports[0].events if e.type == "work_b"]
    assert replayed, "恢复重放未送达事件（断线续流）"


async def test_graph_version_mismatch_rejects_resume(memory_storage):
    g = Graph(name="v", entry="a")
    g.add_node("a", lambda ctx: {"v": 1})
    g.add_exit("a")
    engine = _engine(g, storage=memory_storage)
    first = await engine.ainvoke({}, thread_id="t")
    # 改图后 resume → 图版本不匹配显式拒绝（恢复语义不保证，不静默错位）
    g2 = Graph(name="v", entry="a")
    g2.add_node("a", lambda ctx: {"v": 2})
    g2.add_node("extra", lambda ctx: {"x": 1})
    g2.add_edge("a", "extra")
    g2.add_exit("extra")
    engine2 = _engine(g2, storage=memory_storage)
    with pytest.raises(GraphVersionMismatchError):
        await engine2.ainvoke({}, thread_id="t", resume_from=first.checkpoint_id)


async def test_recovery_anchors_collection(memory_storage):
    """恢复锚点收集：中断 checkpoint 沿版本链回溯产出顶层锚点 + 子图锚点表。"""
    from ink_engine.core.recovery import collect_resume_anchors

    async def hang(ctx):
        await ctx.interrupt("gate", {"q": "确认?"})
        return {}

    g = Graph(name="rec", entry="a")
    g.add_node("a", hang)
    g.add_exit("a")
    engine = _engine(g, storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.interrupt is not None and result.interrupt.key == "gate"
    latest = await memory_storage.get_latest_checkpoint("t")
    anchors, resume_map = await collect_resume_anchors(memory_storage, latest, {})
    assert isinstance(anchors, int) and anchors > 0
    assert resume_map == {}


# ----------------------------------------------------------------------
# 预算 / 异常跳过 / 重试
# ----------------------------------------------------------------------

async def test_budget_guard_terminates(memory_storage):
    g = Graph(name="b", entry="start")
    g.add_node("start", lambda ctx: {"n": 1})
    g.add_node("mid", lambda ctx: {"n": 2})
    g.add_node("end", lambda ctx: {"n": 3})
    g.add_edge("start", "mid")
    g.add_edge("mid", "end")
    g.add_exit("end")
    manager = BudgetManager()
    manager.register(StepBudgetPolicy(max_nodes=2))
    engine = _engine(g, storage=memory_storage, budget=manager)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.BUDGET_EXCEEDED
    assert result.error is not None


async def test_error_on_exception_false_skips(memory_storage):
    async def boom(ctx):
        raise ValueError("boom")

    g = Graph(name="e", entry="a")
    g.add_node("a", boom)
    g.add_node("b", lambda ctx: {"survived": True})
    g.add_edge("a", "b")
    g.add_exit("b")
    engine = _engine(g, storage=memory_storage, error_on_exception=False)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state["survived"] is True


async def test_node_retry(memory_storage):
    calls = {"n": 0}

    async def flaky(ctx):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValueError("首次失败")
        return {"ok": True}

    g = Graph(name="r", entry="a")
    g.add_node("a", flaky)
    g.add_exit("a")
    engine = _engine(g, storage=memory_storage, max_node_retries=1)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state["ok"] is True
    assert calls["n"] == 2


# ----------------------------------------------------------------------
# fan_out 并发发散
# ----------------------------------------------------------------------

async def test_fanout_partial_failure_pruned():
    async def ok_task(i: int):
        return i * 2

    async def fail_task(i: int):
        raise ValueError(f"task {i} 失败")

    result = await fan_out([ok_task, fail_task, ok_task, fail_task], limit=2)
    assert result.successes == [0, 4]  # 失败剔除，成功保留（索引注入）
    assert len(result.failures) == 2


# ----------------------------------------------------------------------
# 重规划 / 子任务 / 推演
# ----------------------------------------------------------------------

async def test_plan_replan_loose(memory_storage):
    """__plan__ 重规划（宽松域）：计划步按序执行，保留键不落状态。"""
    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["a", "b"]}]}

    g = Graph(name="p", entry="route")
    g.add_node("route", route)
    g.add_node("a", lambda ctx: {"seen": [*ctx.state.get("seen", []), "a"]})
    g.add_node("b", lambda ctx: {"seen": [*ctx.state.get("seen", []), "b"]})
    g.add_exit("b")
    engine = _engine(g, storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state["seen"] == ["a", "b"]
    assert PLAN_KEY not in result.state


async def test_spawn_collect_and_guard(memory_storage):
    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": _sub_graph(10), "state": {"seed": 1}, "index": 0},
                            {"subgraph": _sub_graph(20), "state": {"seed": 2}, "index": 1}]}

    g = Graph(name="sp", entry="route")
    g.add_node("route", route)
    g.add_exit("route")
    engine = _engine(g, storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    # 子图实例最终状态按 index 回流
    assert result.state["sub_value"] == 2 + 20
    sub_events = [e for e in engine.options.transports[0].events if e.type == "sub_run"]
    assert len(sub_events) == 2


async def test_spawn_guard_max_spawns(memory_storage):
    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": _sub_graph(i), "state": {}, "index": i} for i in range(3)]}

    g = Graph(name="spg", entry="route")
    g.add_node("route", route)
    g.add_exit("route")
    engine = _engine(g, storage=memory_storage, max_spawns=2)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.ERROR  # 清单超限 = 节点失败（fail-closed）


class _ScoringEvaluator:
    """打分评估器：按分支 index 返回分值与通过状态。"""

    def __init__(self, scores: dict, passed: dict):
        self._scores = scores
        self._passed = passed

    async def evaluate(self, branch, overlay: dict) -> Evaluation:
        return Evaluation(
            score=self._scores.get(branch.index, 0.0),
            passed=self._passed.get(branch.index, True),
            note=f"branch-{branch.index}",
        )


async def test_simulate_choose_best(memory_storage):
    """__simulate__ 推演：分支独立执行 → 打分择优 → 落选分支事件保留。"""
    async def decide(ctx):
        return {SIMULATE_KEY: {"branches": [
            {"subgraph": _sub_graph(1), "state": {"seed": 10}, "index": 0},
            {"subgraph": _sub_graph(2), "state": {"seed": 20}, "index": 1},
        ]}}

    g = Graph(name="sim", entry="decide")
    g.add_node("decide", decide)
    g.add_exit("decide")
    evaluator = _ScoringEvaluator(scores={1: 5.0, 0: 1.0}, passed={0: True, 1: True})
    engine = _engine(
        g,
        storage=memory_storage,
        evaluator=evaluator,
        branch_mixer=BestBranchMixer(),
    )
    result = await engine.ainvoke({}, thread_id="t")
    assert result.reason == TerminateReason.REPLY
    assert result.state["sub_value"] == 22  # 选中分支 index=1（20+2）
    branch_events = [e for e in engine.options.transports[0].events if e.type == "sub_run"]
    assert len(branch_events) == 2  # 落选分支保留（轨迹树引用存在）


# ----------------------------------------------------------------------
# interrupt 全形态
# ----------------------------------------------------------------------

async def test_interrupt_hang_inject_reenter_persist(memory_storage):
    """interrupt：挂起 → checkpoint 持久化 → 跨实例注入重入（重入幂等）。"""
    async def gate_node(ctx):
        decision = await ctx.interrupt("gate", {"question": "是否继续?"})
        return {"decision": decision}

    g = Graph(name="int", entry="a")
    g.add_node("a", gate_node)
    g.add_exit("a")
    engine1 = _engine(g, storage=memory_storage)
    result = await engine1.ainvoke({}, thread_id="t")
    assert result.interrupt is not None
    assert result.interrupt.key == "gate"
    assert result.reason == "interrupted"  # 挂起 = 中断终止（供宿主决议）
    # 挂起卡落库：新引擎实例（同存储）读回并注入决议重入
    engine2 = _engine(g, storage=memory_storage)
    latest = await engine2.get_latest_interrupt("t")
    assert latest is not None and latest.key == "gate"
    resumed = await engine2.ainvoke(
        {}, thread_id="t", resume_from=result.checkpoint_id, inject={"gate": "accept"}
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state["decision"] == "accept"


async def test_interrupt_without_inject_hangs_again(memory_storage):
    async def gate_node(ctx):
        await ctx.interrupt("gate", {"question": "?"})
        return {}

    g = Graph(name="int2", entry="a")
    g.add_node("a", gate_node)
    g.add_exit("a")
    engine = _engine(g, storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t")
    assert result.interrupt is not None
    # 无注入续跑 → 再次挂起（不静默放行）
    result2 = await engine.ainvoke({}, thread_id="t", resume_from=result.checkpoint_id)
    assert result2.interrupt is not None
    assert result2.interrupt.key == "gate"
