"""运行时重规划（__plan__）单测：顺序组/并行组/条件门/spawn 步骤/
checkpoint 计划快照/恢复续跑/非法计划拒绝。

语义检查点：节点返回下一跳计划清单 → 引擎按清单续跑、执行一段后再规划；
计划 = checkpoint 快照字段（随版本链落盘与回滚）；计划引用的节点必须
落在图内（宽松域 = 任意已注册节点，严格序 = 须满足图边约束）。
"""
from __future__ import annotations

import asyncio

import pytest
from conftest import make_engine

from ink_engine.core.executor import Engine
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.plan import KIND_NODES, PLAN_KEY, Plan
from ink_engine.core.registry import (
    EdgeConditionRegistry,
    GraphRegistries,
    NodeTypeRegistry,
)


def _tracker_graph(
    route_fn,
    *,
    nodes: dict[str, callable] | None = None,
    exits: tuple[str, ...] = ("end",),
) -> Graph:
    """规划测试图：路由节点（产 __plan__）+ 可选追加节点 + 出口。

    全部节点接向出口（end）：计划耗尽后转边定位可达 REPLY——计划节点
    本身不声明出边（下一跳完全由计划决定），测试聚焦计划语义。
    """
    graph = Graph(name="plan", entry="route")
    graph.add_node("route", route_fn)
    for name, fn in (nodes or {}).items():
        graph.add_node(name, fn)
    for exit_name in exits:
        if exit_name not in graph.nodes:
            graph.add_node(exit_name, lambda ctx: {})
        graph.add_exit(exit_name)
    for source in ("route", *(nodes or {})):
        if source not in exits:
            targets = {e.target for e in graph.edges.get(source, [])}
            for exit_name in exits:
                if exit_name not in targets:
                    graph.add_edge(source, exit_name)
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


def _registries(conditions: dict[str, callable] | None = None) -> GraphRegistries:
    edges = EdgeConditionRegistry()
    for name, fn in (conditions or {}).items():
        edges.register(name, fn)
    return GraphRegistries(edges=edges)


async def test_plan_nodes_run_in_order(memory_storage):
    """顺序节点组：计划节点按序执行，结果并入状态。"""
    log: list[str] = []

    async def a(ctx):
        log.append("a")
        return {"seen": [*ctx.state.get("seen", []), "a"]}

    async def b(ctx):
        log.append("b")
        return {"seen": [*ctx.state.get("seen", []), "b"]}

    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["a", "b"]}]}

    engine = make_engine(_tracker_graph(route, nodes={"a": a, "b": b}))
    state, result = await _run(engine)
    assert result.reason == TerminateReason.REPLY
    assert log == ["a", "b"]
    assert state["seen"] == ["a", "b"]


async def test_plan_then_edge_walk_continues(memory_storage):
    """计划耗尽后转边定位：末节点有出边则继续走边（计划与静态拓扑衔接）。"""
    log: list[str] = []

    async def a(ctx):
        log.append("a")
        return {}

    async def tail(ctx):
        log.append("tail")
        return {"done": True}

    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["a"]}]}

    graph = Graph(name="plan", entry="route")
    graph.add_node("route", route)
    graph.add_node("a", a)
    graph.add_node("tail", tail)
    graph.add_edge("a", "tail")
    graph.add_exit("tail")
    engine = make_engine(graph)
    state, result = await _run(engine)
    assert result.reason == TerminateReason.REPLY
    assert log == ["a", "tail"]
    assert state.get("done") is True


async def test_plan_key_not_leaked_into_state(memory_storage):
    """保留键不落状态：__plan__ 从增量弹出，状态里无残留。"""
    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["a"]}], "visible": 1}

    async def a(ctx):
        return {}

    engine = make_engine(_tracker_graph(route, nodes={"a": a}))
    state, result = await _run(engine)
    assert result.reason == TerminateReason.REPLY
    assert state.get("visible") == 1
    assert PLAN_KEY not in state


async def test_parallel_group_merges_in_order(memory_storage):
    """并行组：成员并发执行（隔离状态），结果按声明序合并。"""
    running: list[str] = []

    def member(tag: str):
        async def node(ctx):
            running.append(tag)
            await asyncio.sleep(0.02)
            return {f"value_{tag}": tag}
        return node

    async def route(ctx):
        return {PLAN_KEY: [{"parallel": ["x", "y", "z"]}]}

    engine = make_engine(
        _tracker_graph(route, nodes={"x": member("x"), "y": member("y"), "z": member("z")})
    )
    state, result = await _run(engine)
    assert result.reason == TerminateReason.REPLY
    assert state["value_x"] == "x"
    assert state["value_y"] == "y"
    assert state["value_z"] == "z"


async def test_parallel_group_same_key_last_wins(memory_storage):
    """并行组成员写同键：声明序合并（后声明覆盖先声明）。"""
    async def route(ctx):
        return {PLAN_KEY: [{"parallel": ["first", "second"]}]}

    async def first(ctx):
        return {"shared": "first"}

    async def second(ctx):
        return {"shared": "second"}

    engine = make_engine(_tracker_graph(route, nodes={"first": first, "second": second}))
    state, _ = await _run(engine)
    assert state["shared"] == "second"


async def test_condition_gate_skips_step(memory_storage):
    """条件门：不满足的步骤跳过，满足的执行。"""
    log: list[str] = []

    async def a(ctx):
        log.append("a")
        return {}

    async def skip(ctx):
        log.append("skip")
        return {}

    async def want_skip(ctx):
        return ctx.state.get("skip_it", False) is True

    async def route(ctx):
        return {
            PLAN_KEY: [
                {"nodes": ["a"]},
                {"nodes": ["skip"], "condition": "want_skip"},
            ]
        }

    engine = make_engine(
        _tracker_graph(route, nodes={"a": a, "skip": skip}),
        registries=_registries({"want_skip": want_skip}),
    )
    _, result = await _run(engine)
    assert result.reason == TerminateReason.REPLY
    assert log == ["a"]  # 条件为假，跳过步未执行

    _, result2 = await _run(engine, state={"skip_it": True})
    assert result2.reason == TerminateReason.REPLY
    assert log == ["a", "a", "skip"]


async def test_plan_spawn_step_expands_instances(memory_storage):
    """计划 spawn 步：子任务清单经实例展开，结果回流。"""
    calls: list[int] = []

    def sub_factory(config: dict):
        async def sub_node(ctx):
            calls.append(ctx.state.get("seed", 0))
            return {"sub_total": ctx.state.get("seed", 0)}
        return sub_node

    nodes_registry = NodeTypeRegistry()
    nodes_registry.register("sub_node", sub_factory)
    sub = Graph(name="sub", entry="s1")
    sub.add_node_type("s1", "sub_node")
    sub.add_exit("s1")
    sub.resolve_types(nodes_registry)

    async def route(ctx):
        return {
            PLAN_KEY: [
                {
                    "spawns": [
                        {"subgraph": sub, "state": {"seed": 10}, "index": 0},
                        {"subgraph": sub, "state": {"seed": 20}, "index": 1},
                    ]
                }
            ]
        }

    # 计划内 spawn 的 Graph 入计划时已序列化为数据（计划快照纯数据契约），
    # 展开时经注册表重建——引擎须注入建图注册表
    engine = make_engine(
        _tracker_graph(route),
        storage=memory_storage,
        registries=GraphRegistries(nodes=nodes_registry),
    )
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert sorted(calls) == [10, 20]
    assert state["sub_total"] == 20  # 末项回流（裸通道覆盖）
    # 计划 spawn 实例走独立子链（与 __spawn__ 同口径）
    instance_cps = await memory_storage.list_checkpoints("t1:spawn:0")
    assert instance_cps


async def test_plan_spawn_with_data_subgraph(memory_storage):
    """计划 spawn 步携带图定义数据（子图 = 数据）：经注册表重建后展开。"""
    calls: list[int] = []

    def sub_factory(config: dict):
        async def sub_node(ctx):
            calls.append(config.get("tag"))
            return {"sub_tag": config.get("tag")}
        return sub_node

    nodes_registry = NodeTypeRegistry()
    nodes_registry.register("sub_node", sub_factory)
    sub = Graph(name="sub", entry="s1")
    sub.add_node_type("s1", "sub_node", {"tag": "decl"})
    sub.add_exit("s1")
    sub.resolve_types(nodes_registry)

    async def route(ctx):
        # 数据形态：subgraph 为图定义数据 dict（计划快照纯数据契约的产物）
        return {
            PLAN_KEY: [
                {"spawns": [{"subgraph": sub.to_dict(), "state": {}, "index": 0}]}
            ]
        }

    engine = make_engine(
        _tracker_graph(route), storage=memory_storage, registries=GraphRegistries(nodes=nodes_registry)
    )
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert calls == ["decl"]
    assert state["sub_tag"] == "decl"


async def test_plan_checkpoint_carries_snapshot(memory_storage):
    """计划快照随 checkpoint 落盘：链上快照携带 {steps, index}。"""
    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["a"]}, {"nodes": ["b"]}]}

    async def a(ctx):
        return {}

    async def b(ctx):
        return {}

    engine = make_engine(_tracker_graph(route, nodes={"a": a, "b": b}), storage=memory_storage)
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    cps = await memory_storage.list_checkpoints("t1")
    plan_snapshots = [cp.plan for cp in cps if cp.plan is not None]
    assert plan_snapshots  # 计划激活期间快照均携带计划
    # list_checkpoints 按 id 降序：最早的计划快照 = 计划起始（index 0）
    assert plan_snapshots[-1]["index"] == 0
    assert all(len(s["steps"]) == 2 for s in plan_snapshots)
    # 终态快照计划已耗尽（plan=None）
    tail = await memory_storage.get_latest_checkpoint("t1")
    assert tail is not None
    assert tail.plan is None


async def test_plan_resume_from_completed_checkpoint(memory_storage):
    """普通计划 checkpoint 恢复：不重跑产出节点与已完成步骤，从计划游标续跑。

    回归 P0-3：修复前恢复分支 current 未定位（仍为 graph.entry），重跑
    route 重新规划、覆盖 checkpoint 计划游标——已完成步骤重复执行。
    """
    log: list[str] = []

    async def route(ctx):
        log.append("route")
        return {PLAN_KEY: [{"nodes": ["a"]}, {"nodes": ["b"]}]}

    async def a(ctx):
        log.append("a")
        return {}

    async def b(ctx):
        log.append("b")
        return {}

    engine = make_engine(
        _tracker_graph(route, nodes={"a": a, "b": b}), storage=memory_storage
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert log == ["route", "a", "b"]

    # 取「a 已完成、b 未执行」的 checkpoint（计划游标 index=1）resume
    cps = await memory_storage.list_checkpoints("t1")
    mid = next(cp for cp in cps if cp.plan is not None and cp.plan.get("index") == 1)
    assert mid.node == "a"
    _, result2 = await _run(engine, thread_id="t1", resume_from=mid.checkpoint_id)
    assert result2.reason == TerminateReason.REPLY
    # 恢复后只补执行剩余步骤 b——route/a 不重跑（计划游标不丢失）
    assert log == ["route", "a", "b", "b"]


async def test_plan_parallel_interrupt_resume_reenters_work_step(memory_storage):
    """并行步中断恢复：重入计划工作步而非产出节点（route 不重跑、不重新规划）。

    回归 P0-3：修复前中断 checkpoint（node=产出节点）恢复会重跑 route，
    新计划覆盖中断步游标——注入值丢失、中断成员无法续跑。
    """
    done: list[str] = []
    route_calls = 0
    resume_injected = False

    async def route(ctx):
        nonlocal route_calls
        route_calls += 1
        return {PLAN_KEY: [{"parallel": ["gated", "slow"]}]}

    async def gated(ctx):
        if not resume_injected:
            await ctx.interrupt("review:parallel", {"q": "?"})
        done.append("gated")
        return {"gated_done": True}

    async def slow(ctx):
        await asyncio.sleep(0.05)
        done.append("slow")
        return {"slow_done": True}

    engine = make_engine(
        _tracker_graph(route, nodes={"gated": gated, "slow": slow}),
        storage=memory_storage,
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == "interrupted"
    assert result.interrupt is not None
    assert route_calls == 1
    # 中断 checkpoint：node = 产出节点 route，计划游标停在工作步
    tail = await memory_storage.get_latest_checkpoint("t1")
    assert tail is not None and tail.plan is not None
    assert tail.node == "route"
    assert tail.plan["index"] == 0

    resume_injected = True
    _, result2 = await _run(engine, thread_id="t1", resume_from=tail.checkpoint_id)
    assert result2.reason == TerminateReason.REPLY
    # route 不重跑（计划游标保留）；工作步重入：gated 拿注入值完成、slow 执行
    # （首跑 gated 在完成前中断、slow 被取消，两者均未计入 done）
    assert route_calls == 1
    assert done == ["gated", "slow"]


async def test_plan_spawn_step_max_spawns_guard(memory_storage):
    """计划 spawn 步超 max_spawns 上限 → 计划失败终止（成本护栏）。

    回归 P1-2：修复前计划 spawn 步绕过 max_spawns 检查（主路径 __spawn__
    有护栏），单步可携带无限实例。
    """
    calls: list[int] = []

    def sub_factory(config: dict):
        async def sub_node(ctx):
            calls.append(ctx.state.get("seed", 0))
            return {"sub_total": ctx.state.get("seed", 0)}
        return sub_node

    nodes_registry = NodeTypeRegistry()
    nodes_registry.register("sub_node", sub_factory)
    sub = Graph(name="sub", entry="s1")
    sub.add_node_type("s1", "sub_node")
    sub.add_exit("s1")
    sub.resolve_types(nodes_registry)

    async def route(ctx):
        return {
            PLAN_KEY: [
                {
                    "spawns": [
                        {"subgraph": sub, "state": {"seed": 10}, "index": 0},
                        {"subgraph": sub, "state": {"seed": 20}, "index": 1},
                    ]
                }
            ]
        }

    engine = make_engine(
        _tracker_graph(route),
        storage=memory_storage,
        registries=GraphRegistries(nodes=nodes_registry),
        max_spawns=1,
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "超限" in (result.error or "")
    assert calls == []  # 超限拒绝后不展开任何实例


async def test_plan_spawn_step_error_terminates_by_default(memory_storage):
    """计划 spawn 步实例失败：error_on_exception=True = 计划失败终止；
    False = 失败实例剔除、计划继续。

    回归 P1-3：修复前计划 spawn 步无论 error_on_exception 一律剔除继续
    （与并行组「失败即中止」语义分裂）。
    """
    def sub_factory(config: dict):
        async def sub_node(ctx):
            if config.get("boom"):
                raise RuntimeError("instance boom")
            return {"sub_tag": config.get("tag")}
        return sub_node

    nodes_registry = NodeTypeRegistry()
    nodes_registry.register("sub_node", sub_factory)
    sub = Graph(name="sub", entry="s1")
    sub.add_node_type("s1", "sub_node", {"boom": False, "tag": "ok"})
    sub.add_exit("s1")
    boom = Graph(name="boom", entry="s1")
    boom.add_node_type("s1", "sub_node", {"boom": True})
    boom.add_exit("s1")

    async def route(ctx):
        return {
            PLAN_KEY: [
                {
                    "spawns": [
                        {"subgraph": sub, "state": {}, "index": 0},
                        {"subgraph": boom, "state": {}, "index": 1},
                    ]
                }
            ]
        }

    engine = make_engine(
        _tracker_graph(route),
        storage=memory_storage,
        registries=GraphRegistries(nodes=nodes_registry),
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "失败" in (result.error or "")

    engine2 = make_engine(
        _tracker_graph(route),
        storage=memory_storage,
        registries=GraphRegistries(nodes=nodes_registry),
        error_on_exception=False,
    )
    state, result2 = await _run(engine2, thread_id="t2")
    assert result2.reason == TerminateReason.REPLY
    assert state.get("sub_tag") == "ok"



    """中断恢复续跑计划：注入后从计划的剩余步骤继续（不重跑已完成节点）。"""
    log: list[str] = []
    resume_injected = False

    async def gated(ctx):
        log.append("gated")
        if not resume_injected:
            await ctx.interrupt("review:gate", {"q": "?"})
        return {"gated_done": True}

    async def after(ctx):
        log.append("after")
        return {"after_done": True}

    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["gated"]}, {"nodes": ["after"]}]}

    engine = make_engine(
        _tracker_graph(route, nodes={"gated": gated, "after": after}),
        storage=memory_storage,
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == "interrupted"

    resume_injected = True
    tail = await memory_storage.get_latest_checkpoint("t1")
    assert tail is not None
    events: list = []
    async for event in engine.run(
        {},
        thread_id="t1",
        resume_from=tail.checkpoint_id,
        inject={"review:gate": "yes"},
    ):
        events.append(event)
    snap = await memory_storage.get_latest_checkpoint("t1")
    assert snap is not None
    assert snap.state.get("after_done") is True
    assert snap.reason == TerminateReason.REPLY
    # 恢复后：中断节点重入一次（拿到注入值），计划剩余步骤（after）执行
    assert log == ["gated", "gated", "after"]


async def test_plan_resume_mid_plan_skips_completed(memory_storage):
    """计划中间中断 → 恢复后从剩余步骤续跑（已完成的计划节点不重跑）。"""
    log: list[str] = []

    async def first(ctx):
        log.append("first")
        return {"first_done": True}

    async def gate(ctx):
        log.append("gate")
        await ctx.interrupt("review:mid", {"q": "?"})
        return {"gate_done": True}

    async def last(ctx):
        log.append("last")
        return {"last_done": True}

    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["first"]}, {"nodes": ["gate"]}, {"nodes": ["last"]}]}

    engine = make_engine(
        _tracker_graph(route, nodes={"first": first, "gate": gate, "last": last}),
        storage=memory_storage,
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == "interrupted"
    assert log == ["first", "gate"]

    tail = await memory_storage.get_latest_checkpoint("t1")
    assert tail is not None and tail.plan is not None
    # 中断时计划快照 index 指向 gate 之后的步骤（last）
    assert tail.plan["index"] == 2
    async for _event in engine.run(
        {},
        thread_id="t1",
        resume_from=tail.checkpoint_id,
        inject={"review:mid": "ok"},
    ):
        pass
    snap = await memory_storage.get_latest_checkpoint("t1")
    assert snap is not None
    assert snap.state.get("last_done") is True
    assert snap.reason == TerminateReason.REPLY
    # 恢复后：gate 重入拿注入值，last 执行——first 不重跑
    assert log == ["first", "gate", "gate", "last"]


async def test_plan_parallel_interrupt_propagates(memory_storage):
    """并行组内中断 → 提升为父图挂起卡（兄弟成员取消，不残留后台执行）。"""
    done: list[str] = []

    async def gated_member(ctx):
        await ctx.interrupt("review:parallel", {"q": "?"})
        return {}

    async def slow_member(ctx):
        await asyncio.sleep(0.3)
        done.append("slow")
        return {}

    async def route(ctx):
        return {PLAN_KEY: [{"parallel": ["gated", "slow"]}]}

    engine = make_engine(
        _tracker_graph(route, nodes={"gated": gated_member, "slow": slow_member}),
        storage=memory_storage,
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == "interrupted"
    assert result.interrupt is not None
    assert result.interrupt.key == "review:parallel"
    assert "slow" not in done


async def test_plan_parallel_error_terminates_by_default(memory_storage):
    """并行组成员失败：error_on_exception=True = 整组失败（reason=error）。"""
    async def boom(ctx):
        raise RuntimeError("member boom")

    async def ok(ctx):
        return {"ok": True}

    async def route(ctx):
        return {PLAN_KEY: [{"parallel": ["ok", "boom"]}]}

    engine = make_engine(_tracker_graph(route, nodes={"ok": ok, "boom": boom}))
    _, result = await _run(engine)
    assert result.reason == TerminateReason.ERROR
    assert "并行组" in (result.error or "")


async def test_plan_parallel_error_skips_failed(memory_storage):
    """并行组成员失败：error_on_exception=False = 失败成员剔除，成功结果合并。"""
    async def boom(ctx):
        raise RuntimeError("member boom")

    async def ok(ctx):
        return {"ok": True}

    async def route(ctx):
        return {PLAN_KEY: [{"parallel": ["ok", "boom"]}]}

    engine = make_engine(
        _tracker_graph(route, nodes={"ok": ok, "boom": boom}),
        error_on_exception=False,
    )
    state, result = await _run(engine)
    assert result.reason == TerminateReason.REPLY
    assert state.get("ok") is True


def test_plan_parse_rejects_unknown_node():
    """计划引用未知节点 → 建图期拒绝（不等到执行期）。"""
    from ink_engine.core.exceptions import GraphDefinitionError

    graph = _tracker_graph(lambda ctx: {})
    with pytest.raises(GraphDefinitionError, match="未知节点"):
        Plan.parse(
            [{"nodes": ["ghost"]}],
            graph=graph,
        )


def test_plan_parse_rejects_unregistered_condition():
    """计划条件未注册 → 建图期拒绝。"""
    from ink_engine.core.exceptions import GraphDefinitionError

    graph = _tracker_graph(lambda ctx: {})
    graph.add_node("a", lambda ctx: {})
    with pytest.raises(GraphDefinitionError, match="条件未注册"):
        Plan.parse(
            [{"nodes": ["a"], "condition": "missing"}],
            graph=graph,
            edge_registry=_registries().edges,
        )


def test_plan_parse_rejects_empty_and_oversized():
    """空计划/步数超限 → 建图期拒绝（成本护栏）。"""
    from ink_engine.core.exceptions import GraphDefinitionError

    graph = _tracker_graph(lambda ctx: {})
    with pytest.raises(GraphDefinitionError, match="为空"):
        Plan.parse([], graph=graph)
    with pytest.raises(GraphDefinitionError, match="超限"):
        Plan.parse([{"nodes": ["route"]}] * 3, graph=graph, max_steps=2)


def test_plan_parse_rejects_ambiguous_step():
    """一步同时声明 nodes 与 parallel → 拒绝（声明歧义不猜意图）。"""
    from ink_engine.core.exceptions import GraphDefinitionError

    graph = _tracker_graph(lambda ctx: {})
    with pytest.raises(GraphDefinitionError, match="恰好声明"):
        Plan.parse([{"nodes": ["route"], "parallel": ["route"]}], graph=graph)


def test_plan_step_expansion_normalizes_sequence():
    """顺序组在解析时展开为单节点步（每节点 checkpoint 粒度、恢复续跑精确）。"""
    graph = _tracker_graph(lambda ctx: {})
    graph.add_node("a", lambda ctx: {})
    graph.add_node("b", lambda ctx: {})
    plan = Plan.parse([{"nodes": ["a", "b"]}], graph=graph)
    assert [step.kind for step in plan.steps] == [KIND_NODES, KIND_NODES]
    assert plan.steps[0].nodes == ("a",)
    assert plan.steps[1].nodes == ("b",)


def test_plan_strict_policy_rejects_unrelated_steps():
    """严格序策略：相邻计划步无图边关联 → 拒绝。"""
    from ink_engine.core.exceptions import GraphDefinitionError

    graph = Graph(name="g", entry="route")
    graph.add_node("route", lambda ctx: {})
    graph.add_node("a", lambda ctx: {})
    graph.add_node("b", lambda ctx: {})
    graph.add_edge("route", "a")
    graph.add_exit("b")
    with pytest.raises(GraphDefinitionError, match="无边关联"):
        Plan.parse(
            [{"nodes": ["a"]}, {"nodes": ["b"]}],
            graph=graph,
            policy="strict",
        )
    # 有边关联的严格序计划通过
    graph2 = Graph(name="g2", entry="route")
    graph2.add_node("route", lambda ctx: {})
    graph2.add_node("a", lambda ctx: {})
    graph2.add_node("b", lambda ctx: {})
    graph2.add_edge("route", "a")
    graph2.add_edge("a", "b")
    graph2.add_exit("b")
    plan = Plan.parse([{"nodes": ["a"]}, {"nodes": ["b"]}], graph=graph2, policy="strict")
    assert len(plan.steps) == 2


# ── 工作流约束域（__plan__ 落在 WorkflowSpec 声明的可执行计划空间内）──


def _workflow_spec(**kw):
    """工作流规格构造（a → b → c 链 + 孤立节点 x）。"""
    from ink_engine.core.workflow import WorkflowEdgeSpec, WorkflowNodeSpec, WorkflowSpec

    nodes = (
        WorkflowNodeSpec(id="a", type="t"),
        WorkflowNodeSpec(id="b", type="t"),
        WorkflowNodeSpec(id="c", type="t"),
        WorkflowNodeSpec(id="x", type="t"),
    )
    edges = (
        WorkflowEdgeSpec(source="a", target="b"),
        WorkflowEdgeSpec(source="b", target="c"),
    )
    return WorkflowSpec(name="wf", nodes=nodes, edges=edges, **kw)


def test_plan_loose_with_workflow_domain():
    """宽松域：提供工作流时计划节点落在工作流节点集内（自由选序）。"""
    graph = Graph(name="g", entry="a")
    for name in ("a", "b", "c"):
        graph.add_node(name, lambda ctx: {})
    graph.add_exit("c")
    plan = Plan.parse(
        [{"nodes": ["c"]}, {"nodes": ["a"]}],
        graph=graph,
        workflow=_workflow_spec(),
    )
    assert len(plan.steps) == 2  # 节点都在工作流域内，宽松序通过


def test_plan_workflow_domain_rejects_outside_node():
    """工作流约束域：计划引用域外节点 → 建期拒绝（宽松域同样生效）。"""
    from ink_engine.core.exceptions import GraphDefinitionError

    graph = Graph(name="g", entry="a")
    for name in ("a", "ghost"):
        graph.add_node(name, lambda ctx: {})
    graph.add_exit("ghost")
    with pytest.raises(GraphDefinitionError, match="工作流约束域外"):
        Plan.parse([{"nodes": ["ghost"]}], graph=graph, workflow=_workflow_spec())


def test_plan_strict_with_workflow_domain():
    """严格序 + 工作流：计划步骤须与工作流边关联（按序执行）。"""
    graph = Graph(name="g", entry="a")
    for name in ("a", "b", "c"):
        graph.add_node(name, lambda ctx: {})
    graph.add_exit("c")
    plan = Plan.parse(
        [{"nodes": ["a"]}, {"nodes": ["b"]}, {"nodes": ["c"]}],
        graph=graph,
        policy="strict",
        workflow=_workflow_spec(),
    )
    assert len(plan.steps) == 3


def test_plan_strict_workflow_rejects_unlinked_steps():
    """严格序 + 工作流：计划步骤无工作流边关联 → 拒绝（图有边也不放行）。"""
    from ink_engine.core.exceptions import GraphDefinitionError

    graph = Graph(name="g", entry="a")
    for name in ("a", "b", "c", "x"):
        graph.add_node(name, lambda ctx: {})
    graph.add_edge("a", "b")
    graph.add_edge("b", "x")  # 图里有 a→b→x 的边，但工作流约束域没有
    graph.add_exit("x")
    with pytest.raises(GraphDefinitionError, match="工作流约束域"):
        Plan.parse(
            [{"nodes": ["a"]}, {"nodes": ["b"]}, {"nodes": ["x"]}],
            graph=graph,
            policy="strict",
            workflow=_workflow_spec(),
        )


async def test_plan_workflow_domain_via_run_options(memory_storage):
    """执行器接线：RunOptions.plan_workflow 传入，计划落在工作流约束域内。"""
    from ink_engine.core.workflow import WorkflowEdgeSpec, WorkflowNodeSpec, WorkflowSpec

    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["b"]}]}

    graph = Graph(name="g", entry="route")
    graph.add_node("route", route)
    graph.add_node("a", lambda ctx: {})
    graph.add_node("b", lambda ctx: {"b": True})
    graph.add_exit("b")

    wf = WorkflowSpec(
        name="wf",
        nodes=(
            WorkflowNodeSpec(id="route", type="t"),
            WorkflowNodeSpec(id="b", type="t"),
        ),
        edges=(WorkflowEdgeSpec(source="route", target="b"),),
    )
    engine = make_engine(
        graph,
        plan_policy="strict",
        plan_workflow=wf,
    )
    state, result = await _run(engine)
    assert result.reason == TerminateReason.REPLY
    assert state.get("b") is True

    # 域外计划经执行器接线同样拒绝
    async def route2(ctx):
        return {PLAN_KEY: [{"nodes": ["x"]}]}

    graph2 = Graph(name="g2", entry="route2")
    graph2.add_node("route2", route2)
    graph2.add_node("x", lambda ctx: {})
    graph2.add_exit("x")
    engine2 = make_engine(graph2, plan_workflow=wf)
    _, result2 = await _run(engine2)
    assert result2.reason == TerminateReason.ERROR
    assert "工作流约束域外" in (result2.error or "")


async def test_plan_disabled_rejects_plan(memory_storage):
    """max_plan_steps=0：计划禁用，节点返回 __plan__ 按节点失败终止。"""
    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["route"]}]}

    engine = make_engine(_tracker_graph(route), max_plan_steps=0)
    _, result = await _run(engine)
    assert result.reason == TerminateReason.ERROR
    assert "禁用" in (result.error or "")


async def test_invalid_plan_fails_node(memory_storage):
    """非法计划（未知节点）→ 节点失败（reason=error，不穿出异常）。"""
    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["ghost"]}]}

    engine = make_engine(_tracker_graph(route))
    _, result = await _run(engine)
    assert result.reason == TerminateReason.ERROR
    assert "未知节点" in (result.error or "")


async def test_plan_in_subgraph_and_instance(memory_storage):
    """计划在子图/spawn 实例内同样生效（机制随引擎实例传播）。"""
    log: list[str] = []

    async def a(ctx):
        log.append("sub-a")
        return {}

    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["a"]}]}

    sub = Graph(name="sub", entry="route")
    sub.add_node("route", route)
    sub.add_node("a", a)
    sub.add_exit("a")

    parent = Graph(name="parent", entry="sub")
    parent.add_subgraph("sub", sub)
    parent.add_exit("sub")

    engine = make_engine(parent, storage=memory_storage)
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert log == ["sub-a"]


async def test_plan_step_serialization_round_trip():
    """计划快照纯数据往返（checkpoint 落盘/恢复还原的格式契约）。"""
    graph = _tracker_graph(lambda ctx: {})
    graph.add_node("a", lambda ctx: {})
    edges = EdgeConditionRegistry()

    async def cond(ctx):
        return True

    edges.register("c", cond)
    plan = Plan.parse(
        [{"nodes": ["a"]}, {"nodes": ["a"], "condition": "c"}, {"spawns": [{"subgraph": {"x": 1}, "index": 0}]}],
        graph=graph,
        edge_registry=edges,
    )
    data = plan.to_dict()
    rebuilt = Plan.from_dict(data)
    assert rebuilt.steps[0].nodes == ("a",)
    assert rebuilt.steps[1].condition == "c"
    assert rebuilt.steps[2].kind == "spawns"
    assert data["index"] == 0


def test_plan_step_kinds_and_spawn_validation():
    """spawn 步骤形态校验：缺 subgraph/序号非法 → 拒绝。"""
    from ink_engine.core.exceptions import GraphDefinitionError

    graph = _tracker_graph(lambda ctx: {})
    with pytest.raises(GraphDefinitionError, match="缺 subgraph"):
        Plan.parse([{"spawns": [{"state": {}}]}], graph=graph)
    with pytest.raises(GraphDefinitionError, match="序号非法"):
        Plan.parse([{"spawns": [{"subgraph": {"x": 1}, "index": "bad"}]}], graph=graph)


async def test_plan_update_state_keeps_plan_snapshot(memory_storage):
    """外部状态补丁（update_state）不得丢链尾计划快照（回归 P1-9）。

    修复前 update_state 写入的新链尾 plan=None——弹卡注入路径下
    计划版本化破口（推演回溯锚点受影响）。
    """
    async def route(ctx):
        return {PLAN_KEY: [{"nodes": ["a"]}, {"nodes": ["b"]}]}

    async def a(ctx):
        return {"a_done": True}

    async def b(ctx):
        await ctx.interrupt("review:gate", {"q": "?"})
        return {"b_done": True}

    engine = make_engine(
        _tracker_graph(route, nodes={"a": a, "b": b}), storage=memory_storage
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == "interrupted"
    tail = await memory_storage.get_latest_checkpoint("t1")
    assert tail is not None and tail.plan is not None
    assert tail.plan["index"] == 2
    # 外部补丁（模拟弹卡注入 review_decision）
    await engine.update_state("t1", {"review_decision": "ok"})
    tail2 = await memory_storage.get_latest_checkpoint("t1")
    assert tail2 is not None
    assert tail2.state.get("review_decision") == "ok"
    # 链尾继承计划快照（游标不丢）：计划版本化在注入路径也成立
    assert tail2.plan is not None
    assert tail2.plan["index"] == 2
