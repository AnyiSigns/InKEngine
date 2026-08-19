"""决策点推演（__simulate__）全链路单测：分支独立子链/评估择优/轨迹树回溯。

语义检查点：
- 节点返回 ``__simulate__`` = 关键决策点，引擎派生多个分支推演走向；
- 每个分支 = 独立子链执行（checkpoint 链隔离，落选分支不销毁）；
- 评估协议（Evaluator）打分 → 调配策略择优提交主线（单选或跨分支组装）；
- 落选分支保留轨迹树引用（分支事件 parent_step_id = 决策点 step_id，
  决策事件携带分支子链 thread 引用）——可回溯对比/换选；
- 分支失败/评估失败按部分失败语义剔除；评估/调配异常与全失败按节点
  失败收口（fail-fast，不静默提交空结果）。
"""
from __future__ import annotations

import pytest
from conftest import make_engine

from ink_engine.core.executor import Engine
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry
from ink_engine.core.scoring import DimensionScore
from ink_engine.core.simulation import (
    SIMULATE_KEY,
    BranchMixer,
    BranchSelection,
    Evaluation,
    Evaluator,
    ProvenanceNote,
    SimulateSpec,
    parse_simulate,
    simulate_thread_id,
)


def _branch_subgraph(delta: int) -> Graph:
    """分支子图：s1 节点按 delta 累加 seed 产出分支结果并发射事件。"""

    async def s1(ctx):
        await ctx.emit("branch_run", {"delta": delta})
        return {"branch_value": ctx.state.get("seed", 0) + delta}

    sub = Graph(name="sim", entry="s1")
    sub.add_node("s1", s1)
    sub.add_exit("s1")
    return sub


class FixedEvaluator:
    """确定性评估器：按分支序号给分（测试可控）。"""

    def __init__(self, scores: dict[int, float], passed: dict[int, bool] | None = None):
        self._scores = scores
        self._passed = passed or {}

    async def evaluate(self, branch: SimulateSpec, overlay: dict) -> Evaluation:
        score = self._scores.get(branch.index, 0.0)
        return Evaluation(
            score=score,
            passed=self._passed.get(branch.index, True),
            note=f"branch-{branch.index}",
        )


class ScoreEvaluator:
    """按分支结果 overlay 的 branch_value 打分（评估内容与执行结果挂钩）。"""

    async def evaluate(self, branch: SimulateSpec, overlay: dict) -> Evaluation:
        value = float(overlay.get("branch_value", 0.0))
        return Evaluation(
            score=min(value / 100.0, 1.0),
            passed=True,
            dimensions=(DimensionScore(name="value", score=min(value / 100.0, 1.0)),),
        )


def _decision_graph(route_fn) -> Graph:
    graph = Graph(name="decision", entry="route")
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


async def test_simulate_best_branch_submitted_to_mainline(memory_storage):
    """择优提交主线：最高分分支的回流增量进入父图状态。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "step_id": "step-1",
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 10}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 10}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.3, 1: 0.9}),
    )
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert state["branch_value"] == 12  # index=1 高分分支（10+2）


async def test_rejected_branch_not_submitted(memory_storage):
    """评估未通过的分支不参与择优（闸门语义）。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 10}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 10}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.9, 1: 0.8}, passed={1: False}),
    )
    state, _ = await _run(engine, thread_id="t1")
    assert state["branch_value"] == 11  # index=0（通过且最高分）


async def test_branch_instances_isolated_chains(memory_storage):
    """分支独立子链：分支 checkpoint 写入 :simulate: 子链，父链不受污染。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 1}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 1}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.5, 1: 0.6}),
    )
    await _run(engine, thread_id="t1")
    parent_cps = await memory_storage.list_checkpoints("t1")
    branch0_cps = await memory_storage.list_checkpoints("t1:simulate:0")
    branch1_cps = await memory_storage.list_checkpoints("t1:simulate:1")
    assert parent_cps
    assert branch0_cps
    assert branch1_cps


async def test_losing_branch_retained_for_swap(memory_storage, transport):
    """落选分支可回溯换选：分支子链保留 + 决策事件留痕（含分支引用）。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "step_id": "step-9",
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 5}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 5}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        transports=[transport],
        evaluator=FixedEvaluator({0: 0.9, 1: 0.4}),
    )
    state, _ = await _run(engine, thread_id="t1")
    assert state["branch_value"] == 6
    decisions = [e for e in transport.events if e.type == "simulate_decision"]
    assert len(decisions) == 1
    payload = decisions[0].payload
    assert payload["step_id"] == "step-9"
    assert payload["selected"] == [0]
    assert payload["threads"]["0"] == "t1:simulate:0"
    assert payload["threads"]["1"] == "t1:simulate:1"
    # 落选分支（index=1）子链 checkpoint 完整保留——可经链尾续跑换选
    losing_tail = await memory_storage.get_latest_checkpoint("t1:simulate:1")
    assert losing_tail is not None
    assert losing_tail.state.get("branch_value") == 7


async def test_swap_branch_replays_with_target_picked(memory_storage, transport):
    """回溯换选重放：决策点前锚点恢复 → 强制改选落选分支 → 主线状态换位。"""
    async def prepare(ctx):
        return {"prepared": True}

    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "step_id": "step-9",
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 5}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 5}, "index": 1},
                ],
            }
        }

    graph = Graph(name="decision", entry="prepare")
    graph.add_node("prepare", prepare)
    graph.add_node("route", route)
    graph.add_edge("prepare", "route")
    graph.add_exit("route")

    engine = make_engine(
        graph,
        storage=memory_storage,
        transports=[transport],
        evaluator=FixedEvaluator({0: 0.9, 1: 0.4}),
    )
    state, _ = await _run(engine, thread_id="t1")
    assert state["branch_value"] == 6  # 首跑择优选中分支 0
    assert state["prepared"] is True

    # 换选锚点 = 决策点节点执行前的 checkpoint（prepare 完成后、route 前）
    cps = await memory_storage.list_checkpoints("t1")
    before = min(c.checkpoint_id for c in cps)
    result = await engine.swap_branch(
        thread_id="t1",
        before_checkpoint_id=before,
        branch_index=1,
    )
    assert result.reason == TerminateReason.REPLY
    assert result.state["prepared"] is True  # 已完成节点不重跑
    assert result.state["branch_value"] == 7  # 换选后分支 1 的结果提交主线
    # 换选重放期间分支仍按独立子链执行（轨迹完整，可回溯对比）
    branch1_tail = await memory_storage.get_latest_checkpoint("t1:simulate:1")
    assert branch1_tail is not None
    assert branch1_tail.state.get("branch_value") == 7


async def test_swap_branch_unavailable_rejected(memory_storage):
    """换选目标不可用（未通过评估/不存在）显式报错，不静默回落择优。"""
    async def prepare(ctx):
        return {}

    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 5}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 5}, "index": 1},
                ],
            }
        }

    graph = Graph(name="decision", entry="prepare")
    graph.add_node("prepare", prepare)
    graph.add_node("route", route)
    graph.add_edge("prepare", "route")
    graph.add_exit("route")

    engine = make_engine(
        graph,
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.9, 1: 0.4}, passed={1: False}),
    )
    state, _ = await _run(engine, thread_id="t1")
    assert state["branch_value"] == 6

    cps = await memory_storage.list_checkpoints("t1")
    before = min(c.checkpoint_id for c in cps)
    # 目标分支未通过评估 → 显式拒绝
    result = await engine.swap_branch(
        thread_id="t1", before_checkpoint_id=before, branch_index=1
    )
    assert result.reason == TerminateReason.ERROR
    assert "换选分支不可用" in (result.error or "")
    # 目标分支不存在 → 同样拒绝
    result = await engine.swap_branch(
        thread_id="t1", before_checkpoint_id=before, branch_index=9
    )
    assert result.reason == TerminateReason.ERROR
    assert "换选分支不可用" in (result.error or "")


async def test_parent_step_id_trace_tree(memory_storage, transport):
    """轨迹树字段验收：分支事件 parent_step_id = 决策点 step_id。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "step_id": "decision-42",
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {}, "index": 0},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        transports=[transport],
        evaluator=FixedEvaluator({0: 0.5}),
    )
    await _run(engine, thread_id="t1")
    branch_events = [
        e for e in transport.events if e.graph_path == ("sim", "0")
    ]
    assert branch_events
    assert all(e.parent_step_id == "decision-42" for e in branch_events)
    # 顶层事件不带父引用（默认 None，增量演进不破坏既有语义）
    top_events = [e for e in transport.events if not e.graph_path]
    assert all(e.parent_step_id is None for e in top_events)


async def test_cross_branch_assembly_with_provenance(memory_storage, transport):
    """分支结果调配：跨分支组装（分支 A 的部分 + 分支 B 的部分）+ 来源留痕。"""
    class PartialMixer(BranchMixer):
        """示例调配策略：取每个分支的设定值（第一键）与结果值（第二键）组装。"""

        async def mix(self, branches, *, budget=None):
            merged: dict = {}
            provenance: list[ProvenanceNote] = []
            for evaluated in branches:
                for key, value in evaluated.overlay.items():
                    merged[key] = value
                    provenance.append(
                        ProvenanceNote(
                            branch_index=evaluated.spec.index,
                            key=key,
                            note="跨分支组装",
                        )
                    )
            return BranchSelection(
                selected=tuple(b.spec.index for b in branches),
                overlay=merged,
                provenance=tuple(provenance),
            )

    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 10}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 20}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        transports=[transport],
        evaluator=FixedEvaluator({0: 0.3, 1: 0.7}),
        branch_mixer=PartialMixer(),
    )
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    # 跨分支组装：两分支的同键结果按声明序合并（后序覆盖）——留痕完整
    assert state["branch_value"] == 22
    decisions = [e for e in transport.events if e.type == "simulate_decision"]
    payload = decisions[0].payload
    assert payload["selected"] == [0, 1]
    keys = {p["key"] for p in payload["provenance"]}
    assert keys == {"branch_value", "seed"}


async def test_all_branches_failed_is_node_error(memory_storage):
    """全部分支执行失败 = 决策点无产出，按节点失败收口（不静默提交）。"""
    async def bad(ctx):
        raise RuntimeError("boom")

    sub = Graph(name="bad", entry="b1")
    sub.add_node("b1", bad)
    sub.add_exit("b1")

    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": sub, "state": {}, "index": 0},
                    {"subgraph": sub, "state": {}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({}),
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "全部分支执行失败" in (result.error or "")


async def test_partial_branch_failure_tolerated(memory_storage):
    """部分分支失败剔除（spawn 同语义）：成功分支照常参与择优。"""
    async def ok(ctx):
        return {"branch_value": 100}

    async def bad(ctx):
        raise RuntimeError("boom")

    ok_sub = Graph(name="ok", entry="o1")
    ok_sub.add_node("o1", ok)
    ok_sub.add_exit("o1")
    bad_sub = Graph(name="bad", entry="b1")
    bad_sub.add_node("b1", bad)
    bad_sub.add_exit("b1")

    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": ok_sub, "state": {}, "index": 0},
                    {"subgraph": bad_sub, "state": {}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=ScoreEvaluator(),
    )
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert state["branch_value"] == 100


async def test_evaluation_failure_branch_excluded(memory_storage):
    """评估失败的分支剔除（无可信评分不得参与择优），成功者照常提交。"""
    class FlakyEvaluator(Evaluator):
        def __init__(self):
            self._calls = 0

        async def evaluate(self, branch: SimulateSpec, overlay: dict) -> Evaluation:
            self._calls += 1
            if self._calls == 1:
                raise RuntimeError("评估器不可用")
            return Evaluation(score=0.8, passed=True)

    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 10}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 10}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FlakyEvaluator(),
    )
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert state["branch_value"] == 12  # index=1 成功评估


async def test_all_evaluations_failed_is_node_error(memory_storage):
    """全部评估失败 = 无可择优候选，按节点失败收口。"""
    class AlwaysFailEvaluator(Evaluator):
        async def evaluate(self, branch: SimulateSpec, overlay: dict) -> Evaluation:
            raise RuntimeError("评估器不可用")

    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {}, "index": 0},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=AlwaysFailEvaluator(),
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "评估失败" in (result.error or "")


async def test_simulate_without_evaluator_rejected(memory_storage):
    """未注入评估器时节点返回 __simulate__ 显式拒绝（fail-fast）。"""
    async def route(ctx):
        return {SIMULATE_KEY: {"branches": [{"subgraph": _branch_subgraph(1), "state": {}, "index": 0}]}}

    engine = make_engine(_decision_graph(route), storage=memory_storage)
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "评估器" in (result.error or "")


async def test_simulate_disabled_rejected(memory_storage):
    """max_simulations=0 时推演禁用，节点返回 __simulate__ 显式拒绝。"""
    async def route(ctx):
        return {SIMULATE_KEY: {"branches": [{"subgraph": _branch_subgraph(1), "state": {}, "index": 0}]}}

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.5}),
        max_simulations=0,
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "推演已禁用" in (result.error or "")


async def test_invalid_simulate_list_fails_node(memory_storage):
    """非法推演清单（空分支）按节点失败终止。"""
    async def route(ctx):
        return {SIMULATE_KEY: {"branches": []}}

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({}),
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "至少一个分支" in (result.error or "")


async def test_simulate_limit_enforced(memory_storage):
    """分支数超限拒绝（成本护栏）。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.5, 1: 0.6}),
        max_simulations=1,
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "超限" in (result.error or "")


async def test_duplicate_branch_index_rejected(memory_storage):
    """分支序号重复拒绝（子链归属冲突）。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {}, "index": 0},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.5}),
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "序号重复" in (result.error or "")


def _data_registry() -> NodeTypeRegistry:
    nodes = NodeTypeRegistry()

    def sub_factory(config: dict):
        async def node(ctx):
            return {"branch_value": ctx.state.get("seed", 0) + config.get("delta", 1)}
        return node

    nodes.register("sim_add", sub_factory)
    return nodes


def _data_branch(delta: int) -> dict:
    sub = Graph(name="sim", entry="s1")
    sub.add_node_type("s1", "sim_add", {"delta": delta})
    sub.add_exit("s1")
    sub.resolve_types(_data_registry())
    return sub.to_dict()


async def test_data_form_branch_with_registry(memory_storage):
    """图定义数据形态分支：经建图注册表重建后执行（图数据化产物复用）。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _data_branch(1), "state": {"seed": 10}, "index": 0},
                    {"subgraph": _data_branch(2), "state": {"seed": 10}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        registries=GraphRegistries(nodes=_data_registry()),
        evaluator=FixedEvaluator({0: 0.2, 1: 0.8}),
    )
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert state["branch_value"] == 12


async def test_data_form_branch_without_registry_rejected(memory_storage):
    """未注入注册表时图定义数据形态显式拒绝（防静默当作缺子图）。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _data_branch(1), "state": {}, "index": 0},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.5}),
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "注册表" in (result.error or "")


async def test_best_branch_mixer_deterministic(memory_storage):
    """默认调配策略确定性：平分取序号小者（可断言）。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 1}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 1}, "index": 1},
                ],
            }
        }

    engine = make_engine(
        _decision_graph(route),
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.5, 1: 0.5}),
    )
    state, _ = await _run(engine, thread_id="t1")
    assert state["branch_value"] == 2  # index=0（平分取序号小者）


async def test_simulate_then_plan_coexist(memory_storage):
    """推演与计划共存：决策点推演择优后按计划续跑（保留键独立消费）。"""
    async def route(ctx):
        return {
            SIMULATE_KEY: {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "state": {"seed": 10}, "index": 0},
                    {"subgraph": _branch_subgraph(2), "state": {"seed": 10}, "index": 1},
                ],
            },
            "__plan__": [{"nodes": ["after"]}],
        }

    async def after(ctx):
        return {"planned": ctx.state.get("branch_value", 0) + 1}

    graph = _decision_graph(route)
    graph.add_node("after", after)
    graph.add_edge("route", "after")
    graph.add_exit("after")

    engine = make_engine(
        graph,
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.3, 1: 0.9}),
    )
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert state["branch_value"] == 12
    assert state["planned"] == 13


async def test_simulate_in_parallel_member_rejected(memory_storage):
    """并行组成员返回 __simulate__ 显式拒绝（推演仅主循环，防静默丢失）。"""
    async def route(ctx):
        return {"__plan__": [{"parallel": ["p1", "p2"]}]}

    async def p1(ctx):
        return {SIMULATE_KEY: {"branches": [{"subgraph": _branch_subgraph(1), "state": {}, "index": 0}]}}

    async def p2(ctx):
        return {"value": 1}

    graph = _decision_graph(route)
    graph.add_node("p1", p1)
    graph.add_node("p2", p2)
    graph.add_edge("route", "p1")
    graph.add_edge("route", "p2")
    graph.add_exit("p1")
    graph.add_exit("p2")

    engine = make_engine(
        graph,
        storage=memory_storage,
        evaluator=FixedEvaluator({0: 0.5}),
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "并行组失败" in (result.error or "")


# ── 数据面单元（parse_simulate / 模型 round-trip）──


async def test_parse_simulate_shape_validation():
    """parse_simulate 形态校验：信封/分支/序号/预算逐项拒绝非法声明。"""
    with pytest.raises(Exception, match="信封"):
        parse_simulate([], max_branches=4)
    with pytest.raises(Exception, match="至少一个分支"):
        parse_simulate({"branches": []}, max_branches=4)
    with pytest.raises(Exception, match="超限"):
        parse_simulate(
            {"branches": [{"subgraph": _branch_subgraph(1), "index": i} for i in range(3)]},
            max_branches=2,
        )
    with pytest.raises(Exception, match="序号重复"):
        parse_simulate(
            {
                "branches": [
                    {"subgraph": _branch_subgraph(1), "index": 0},
                    {"subgraph": _branch_subgraph(1), "index": 0},
                ]
            },
            max_branches=4,
        )
    with pytest.raises(Exception, match="预算"):
        parse_simulate(
            {"branches": [{"subgraph": _branch_subgraph(1), "index": 0}], "budget": -1},
            max_branches=4,
        )
    with pytest.raises(Exception, match="缺子图"):
        parse_simulate({"branches": [{"index": 0}]}, max_branches=4)


async def test_parse_simulate_graph_form():
    """Graph 实例直通（无需解析器），step_id/budget 原样透传。"""
    step_id, budget, branches = parse_simulate(
        {
            "step_id": "s-1",
            "budget": 4000,
            "branches": [{"subgraph": _branch_subgraph(1), "state": {"x": 1}, "index": 3}],
        },
        max_branches=4,
    )
    assert step_id == "s-1"
    assert budget == 4000
    assert branches[0].index == 3
    assert branches[0].state == {"x": 1}


async def test_spec_evaluation_roundtrip():
    """SimulateSpec/Evaluation 序列化 round-trip（checkpoint/事件留痕契约）。"""
    # 序列化需要声明式图（函数直挂图不可序列化——Graph 契约，防静默丢失）
    spec = SimulateSpec(
        subgraph=Graph.from_dict(_data_branch(1), registry=_data_registry()),
        state={"x": 1},
        index=2,
        description="d",
    )
    rebuilt = SimulateSpec.from_dict(
        spec.to_dict(), registry=_data_registry()
    )
    assert rebuilt.index == 2
    assert rebuilt.state == {"x": 1}
    assert rebuilt.description == "d"
    assert rebuilt.subgraph.name == "sim"

    evaluation = Evaluation(score=0.8, passed=True, note="n")
    assert Evaluation.from_dict(evaluation.to_dict()) == evaluation


async def test_simulate_thread_id_format():
    """分支子链命名格式（回溯/换选定位锚点）。"""
    assert simulate_thread_id("parent", 0) == "parent:simulate:0"
    assert simulate_thread_id("parent", 12) == "parent:simulate:12"
