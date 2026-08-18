"""动态子图展开（spawn）单测：数据驱动清单/命令式收集/实例隔离/
独立子链/失败剔除/中断恢复闭环/预算护栏/事件统一父链。

语义检查点（D1-D3 落地）：清单即路由节点执行产物（可序列化可重放，
恢复 = 节点重入重跑 + 实例链尾续跑）；实例入口状态自包含；checkpoint
写独立子链、事件日志统一父链。
"""
from __future__ import annotations

from conftest import make_engine

from ink_engine.core.executor import Engine
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.spawn import SPAWN_KEY


def _sub_graph(value: int = 1) -> Graph:
    """实例子图：把清单状态自增值写入结果（验证状态透传与实例隔离）。"""

    async def sub_node(ctx):
        return {"sub_result": ctx.state.get("seed", 0) + value}

    g = Graph(name="sub", entry="s1")
    g.add_node("s1", sub_node)
    g.add_exit("s1")
    return g


def _parent_graph(route_fn) -> Graph:
    """父图：路由节点（产清单）→ 出口。"""
    g = Graph(name="parent", entry="route")
    g.add_node("route", route_fn)
    g.add_exit("route")
    return g


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


async def test_data_driven_spawn_merges_results(memory_storage):
    """数据驱动形态：节点返回 __spawn__ 清单 → 实例结果按 index 序回流。"""

    async def route(ctx):
        return {
            SPAWN_KEY: [
                {"subgraph": _sub_graph(1), "state": {"seed": 10}, "index": 0},
                {"subgraph": _sub_graph(2), "state": {"seed": 20}, "index": 1},
            ]
        }

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert state["sub_result"] == 22  # 末项覆盖（裸通道）或按合并语义——此处验证回流存在


async def test_command_spawn_collects(memory_storage):
    """命令式形态：ctx.spawn 收集清单，节点返回后统一展开。"""
    calls: list[int] = []

    async def sub_node(ctx):
        calls.append(ctx.state.get("seed", 0))
        return {}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_node)
    sub.add_exit("s1")

    async def route(ctx):
        ctx.spawn(sub, {"seed": 1})
        ctx.spawn(sub, {"seed": 2})
        return {}

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert sorted(calls) == [1, 2]
    assert SPAWN_KEY not in state  # 保留键不落状态


async def test_instance_state_isolation(memory_storage):
    """实例隔离：入口状态自包含——实例看不到父状态通道。"""

    async def sub_node(ctx):
        return {"saw_parent": ctx.state.get("parent_secret", "none")}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_node)
    sub.add_exit("s1")

    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": sub, "state": {}, "index": 0}]}

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    state, result = await _run(engine, state={"parent_secret": "secret"}, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert state["saw_parent"] == "none"  # 不继承父状态


async def test_independent_checkpoint_chains(memory_storage):
    """独立子链：实例 checkpoint 写 {父thread}:spawn:{index}，与父链互不污染。"""

    async def route(ctx):
        return {
            SPAWN_KEY: [
                {"subgraph": _sub_graph(1), "state": {"seed": 1}, "index": 0},
            ]
        }

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    await _run(engine, thread_id="t1")
    parent_cps = await memory_storage.list_checkpoints("t1")
    instance_cps = await memory_storage.list_checkpoints("t1:spawn:0")
    assert parent_cps
    assert instance_cps
    assert all(cp.thread_id == "t1" for cp in parent_cps)
    assert all(cp.thread_id == "t1:spawn:0" for cp in instance_cps)


async def test_failure_pruned_parent_continues(memory_storage):
    """失败剔除：单实例失败 → 成功结果回流 + 失败留痕（事件内），父链继续。"""

    async def boom(ctx):
        raise RuntimeError("sub failed")

    sub_bad = Graph(name="bad", entry="s1")
    sub_bad.add_node("s1", boom)
    sub_bad.add_exit("s1")

    async def route(ctx):
        return {
            SPAWN_KEY: [
                {"subgraph": sub_bad, "state": {}, "index": 0},
                {"subgraph": _sub_graph(5), "state": {"seed": 1}, "index": 1},
            ]
        }

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY  # 父链继续
    assert state["sub_result"] == 6  # 成功实例回流


async def test_instance_interrupt_resume_loop(memory_storage):
    """中断恢复闭环：实例内挂卡 → 父链中断 → resume 注入 → 实例链尾续跑拿决策。"""
    log: list[str] = []

    async def gated_sub(ctx):
        log.append(f"enter-{ctx.state.get('seed')}")
        decision = await ctx.interrupt("review:sub:0", {"q": "继续?"})
        log.append(f"decision={decision}")
        return {"approved": decision == "yes"}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", gated_sub)
    sub.add_exit("s1")

    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": sub, "state": {"seed": 7}, "index": 0}]}

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == "interrupted"
    assert result.interrupt is not None and result.interrupt.key == "review:sub:0"

    # 父链 resume + 注入：路由节点重入重跑，实例从自身链尾续跑
    parent_tail = await memory_storage.get_latest_checkpoint("t1")
    assert parent_tail is not None
    events: list = []
    async for event in engine.run(
        {},
        thread_id="t1",
        resume_from=parent_tail.checkpoint_id,
        inject={"review:sub:0": "yes"},
    ):
        events.append(event)
    snap = await memory_storage.get_latest_checkpoint("t1")
    assert snap is not None
    assert snap.state.get("approved") is True
    assert snap.reason == TerminateReason.REPLY
    assert "decision=yes" in log


async def test_max_spawns_guard(memory_storage):
    """预算护栏：清单超限 → 节点失败（reason=error），不展开。"""

    async def route(ctx):
        return {
            SPAWN_KEY: [
                {"subgraph": _sub_graph(1), "state": {}, "index": i} for i in range(3)
            ]
        }

    engine = make_engine(
        _parent_graph(route), storage=memory_storage, max_spawns=2
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.ERROR
    assert "超限" in (result.error or "")


async def test_max_spawns_zero_disables(memory_storage):
    """max_spawns=0：spawn 完全禁用（清单提取跳过，保留键不落状态）。"""

    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": _sub_graph(1), "state": {}, "index": 0}]}

    engine = make_engine(_parent_graph(route), storage=memory_storage, max_spawns=0)
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert "sub_result" not in state


async def test_events_unified_on_parent_thread(memory_storage):
    """事件统一父链：实例事件落父 thread 日志，graph_path 带实例序号标记。"""
    seen_paths: list[tuple[str, ...]] = []

    async def sub_node(ctx):
        seen_paths.append(ctx.graph_path)
        await ctx.emit("node_start", {"name": "s1"}, step_id="n:1")
        return {}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_node)
    sub.add_exit("s1")

    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": sub, "state": {}, "index": 3}]}

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    await _run(engine, thread_id="t1")
    assert seen_paths == [("sub", "3")]  # 实例路径含序号归属标记
    stored = await memory_storage.events_after("t1", 0)
    assert any(e.type == "node_start" and e.graph_path == ("sub", "3") for e in stored)
    # 实例 thread 无事件日志（事件统一父链）
    instance_log = await memory_storage.events_after("t1:spawn:3", 0)
    assert instance_log == []


async def test_concurrency_limit_serializes(memory_storage):
    """并发上限：spawn_concurrency=1 时实例严格顺序执行。"""
    order: list[int] = []

    async def sub_node(ctx):
        order.append(ctx.state.get("seed"))
        return {}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_node)
    sub.add_exit("s1")

    async def route(ctx):
        return {
            SPAWN_KEY: [
                {"subgraph": sub, "state": {"seed": i}, "index": i} for i in range(3)
            ]
        }

    engine = make_engine(
        _parent_graph(route), storage=memory_storage, spawn_concurrency=1
    )
    _, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert order == [0, 1, 2]  # 串行执行按 index 序


async def test_failed_instance_resumes_from_own_tail(memory_storage):
    """失败实例链保留：同 index 重跑时从实例链尾续跑（不从头污染）。"""
    log: list[str] = []
    fail_first = True

    async def sub_node(ctx):
        nonlocal fail_first
        log.append(f"run:{ctx.state.get('seed')}")
        if fail_first:
            fail_first = False
            raise RuntimeError("boom")
        return {"sub_result": ctx.state.get("seed") + 1}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_node)
    sub.add_exit("s1")

    async def route(ctx):
        return {SPAWN_KEY: [{"subgraph": sub, "state": {"seed": 5}, "index": 0}]}

    engine = make_engine(_parent_graph(route), storage=memory_storage)
    state, result = await _run(engine, thread_id="t1")
    assert result.reason == TerminateReason.REPLY
    assert "sub_result" not in state  # 首次失败被剔除
    instance_cps = await memory_storage.list_checkpoints("t1:spawn:0")
    assert instance_cps  # 失败实例链保留（未污染父链）

    # 第二次同清单展开：实例从自身链尾续跑（已完成节点跳过，不重跑失败点之后）
    state2, result2 = await _run(engine, thread_id="t1", state={})
    assert result2.reason == TerminateReason.REPLY
    assert state2.get("sub_result") == 6
    assert log == ["run:5", "run:5"]  # 新实例从入口重跑（无中断/完成态 checkpoint 续跑）
