"""执行引擎单测：执行顺序/条件边/循环回路/终止信号/checkpoint 恢复/
interrupt 注入/事件顺序/嵌套图/异常处理/预算钩子/编辑重放截断。"""
from __future__ import annotations

import pytest
from conftest import (
    DemoBudgetPolicy,
    demo_conditional_graph,
    demo_linear_graph,
    demo_loop_graph,
    make_engine,
)

from engine_core.events import EngineEvent
from engine_core.exceptions import StorageError
from engine_core.executor import Engine
from engine_core.graph import Graph, TerminateReason
from engine_core.state import StateSchema


async def _execute(engine: Engine, state: dict | None = None, **kw):
    """测试直取内部执行（绕过流式，拿最终状态 + RunResult）。"""
    state = state or {}
    return await engine._execute(
        state=state,
        thread_id=kw.pop("thread_id", "t"),
        round_id=kw.pop("round_id", None),
        resume_from=kw.pop("resume_from", None),
        trace_id=kw.pop("trace_id", "trace"),
        queue=None,
        **kw,
    )


async def test_linear_execution_order(memory_storage):
    g = demo_linear_graph()
    engine = make_engine(g, storage=memory_storage)
    state, result = await _execute(engine, thread_id="t1", round_id="r1")
    assert state["count"] == 3
    assert result.reason == TerminateReason.REPLY
    assert result.checkpoint_id is not None
    # checkpoint 版本链落库
    cps = await memory_storage.list_checkpoints("t1")
    assert len(cps) >= 1


async def test_conditional_edge_yes_branch():
    g = demo_conditional_graph()
    engine = make_engine(g)
    state, result = await _execute(engine, {"want_yes": True})
    assert state["branch"] == "yes"
    assert result.reason == TerminateReason.REPLY


async def test_conditional_edge_no_branch():
    g = demo_conditional_graph()
    engine = make_engine(g)
    state, _ = await _execute(engine, {"want_yes": False})
    assert state["branch"] == "no"


async def test_loop_round_trip():
    g = demo_loop_graph()
    engine = make_engine(g)
    state, result = await _execute(engine)
    assert state["count"] == 3  # 循环 3 次后出边
    assert state["done"] is True
    assert result.reason == TerminateReason.REPLY


async def test_checkpoint_recovery_resumes(memory_storage):
    """checkpoint 恢复：断线续流从快照 + 事件日志重放。"""
    g = demo_linear_graph()
    engine = make_engine(g, storage=memory_storage)
    await _execute(engine, thread_id="t1", round_id="r1")
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None
    # 从最新 checkpoint 恢复：快照状态保留
    state, result = await _execute(
        engine, thread_id="t1", round_id="r2", resume_from=latest.checkpoint_id
    )
    assert state["count"] == 3
    assert result.reason == TerminateReason.REPLY


async def test_resume_missing_checkpoint_raises(memory_storage):
    g = demo_linear_graph()
    engine = make_engine(g, storage=memory_storage)
    with pytest.raises(StorageError):
        await _execute(engine, thread_id="t1", resume_from=99999)


async def test_terminate_signal_reply():
    """节点 terminate(reply) → 引擎记录终止原因。"""

    async def node(ctx):
        ctx.terminate(TerminateReason.REPLY)
        return {"done": True}

    g = Graph(name="g", entry="a")
    g.add_node("a", node)
    g.add_exit("a")
    engine = make_engine(g)
    state, result = await _execute(engine)
    assert result.reason == TerminateReason.REPLY
    assert state["done"] is True


async def test_terminate_signal_stop():
    async def node(ctx):
        ctx.terminate(TerminateReason.STOP)
        return {}

    g = Graph(name="g", entry="a")
    g.add_node("a", node)
    engine = make_engine(g)
    _, result = await _execute(engine)
    assert result.reason == TerminateReason.STOP


async def test_invalid_terminate_reason():
    async def node(ctx):
        ctx.terminate("bogus")
        return {}

    g = Graph(name="g", entry="a")
    g.add_node("a", node)
    engine = make_engine(g)
    with pytest.raises(ValueError):
        await _execute(engine)


async def test_interrupt_hang_and_resume(memory_storage):
    """interrupt 挂起 → checkpoint 持久化中断点 → 注入重入（重入幂等）。"""
    calls: list[str] = []

    async def gated(ctx):
        calls.append("enter")
        decision = await ctx.interrupt("gate", {"question": "是否写入?"})
        calls.append(f"decision={decision}")
        return {"approved": decision == "yes"}

    g = Graph(name="g", entry="a")
    g.add_node("a", gated)
    g.add_exit("a")
    engine = make_engine(g, storage=memory_storage)

    # 第一轮：无注入 → 挂起（InterruptSignal 被捕获）
    _state, result = await _execute(engine, thread_id="t1", round_id="r1")
    assert result.interrupt is not None
    assert result.interrupt.key == "gate"
    assert result.interrupt.node == "a"
    assert result.reason == "interrupted"
    assert calls == ["enter"]
    # 中断点状态随 checkpoint 持久化
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None

    # 注入重入：经 run(inject=...) 从 checkpoint 恢复，节点内获得注入值
    engine._coordinator.inject({"gate": "yes"})
    state2, result2 = await _execute(
        engine, thread_id="t1", round_id="r1", resume_from=latest.checkpoint_id
    )
    assert calls == ["enter", "enter", "decision=yes"]  # 重入从该节点重跑
    assert state2["approved"] is True
    assert result2.reason == TerminateReason.REPLY


async def test_interrupt_payload_persisted(memory_storage):
    async def gated(ctx):
        await ctx.interrupt("gate", {"q": 1})

    g = Graph(name="g", entry="a")
    g.add_node("a", gated)
    engine = make_engine(g, storage=memory_storage)
    _, result = await _execute(engine, thread_id="t1")
    assert result.interrupt is not None
    assert result.interrupt.payload == {"q": 1}
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None and latest.reason == "interrupted"


async def test_event_order_and_fields(memory_storage):
    """事件顺序 = 发射顺序；step_id/round_id/graph_path/trace_id 契约。"""

    async def emitter(ctx):
        await ctx.emit("thinking_start", {"text": "s"}, step_id="think:1")
        await ctx.emit("reply_token", {"text": "hi"}, step_id="reply:1")

    g = Graph(name="g", entry="a")
    g.add_node("a", emitter)
    g.add_exit("a")
    engine = make_engine(g, storage=memory_storage)
    events: list[EngineEvent] = []
    async for event in engine.run({}, thread_id="t1", round_id="r9", trace_id="tr1"):
        events.append(event)
    assert [e.type for e in events] == ["thinking_start", "reply_token"]
    assert events[0].step_id == "think:1"
    assert events[0].round_id == "r9"
    assert events[0].graph_path == ()
    assert events[0].trace_id == "tr1"
    # 事件日志落库（append-only，seq 有序递增）
    stored = await memory_storage.events_after("t1", 0)
    assert len(stored) == 2
    assert stored[0].seq < stored[1].seq


async def test_nested_subgraph_path_and_reflow():
    """嵌套图：graph_path 记录子图路径，子图输出回流父图（v3 T2 教训）。"""
    parent = Graph(name="parent", entry="sub")

    async def sub_start(ctx):
        return {"sub_count": 5}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_start)
    sub.add_exit("s1")
    parent.add_subgraph("sub", sub)

    async def after(ctx):
        return {"final": ctx.state.get("sub_count", 0) + 1}

    parent.add_node("after", after)
    parent.add_edge("sub", "after")
    parent.add_exit("after")

    engine = make_engine(parent)
    state, result = await _execute(engine)
    assert state["sub_count"] == 5  # 子图输出回流，不静默丢失
    assert state["final"] == 6
    assert result.reason == TerminateReason.REPLY


async def test_nested_subgraph_events_carry_path(memory_storage):
    parent = Graph(name="parent", entry="sub")

    async def sub_emit(ctx):
        await ctx.emit("node_start", {"name": "s1"}, step_id="n:1")

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_emit)
    sub.add_exit("s1")
    parent.add_subgraph("sub", sub)
    parent.add_exit("sub")

    engine = make_engine(parent, storage=memory_storage)
    events: list[EngineEvent] = []
    async for event in engine.run({}, thread_id="t1"):
        events.append(event)
    assert len(events) == 1
    assert events[0].graph_path == ("sub",)  # 子图路径显式记录（替代 ns 三元组）
    assert events[0].node == "s1"


async def test_nested_subgraph_interrupt(memory_storage):
    """子图内 interrupt：共享 coordinator，挂起/重入可用。"""

    async def sub_gate(ctx):
        await ctx.interrupt("sub_gate", {"q": "ok"})

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_gate)
    sub.add_exit("s1")
    parent = Graph(name="parent", entry="sub")
    parent.add_subgraph("sub", sub)
    parent.add_exit("sub")

    engine = make_engine(parent, storage=memory_storage)
    _, result = await _execute(engine, thread_id="t1")
    assert result.interrupt is not None
    assert result.interrupt.key == "sub_gate"


async def test_node_exception_terminates_with_error(memory_storage):
    """节点异常 → error 事件 + 图终止（ERROR），异常快照保留可诊断。"""

    async def boom(ctx):
        raise RuntimeError("boom")

    g = Graph(name="g", entry="a")
    g.add_node("a", boom)
    engine = make_engine(g, storage=memory_storage)
    events: list[EngineEvent] = []
    async for event in engine.run({}, thread_id="t1"):
        events.append(event)
    assert any(e.type == "error" for e in events)
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None
    assert latest.reason == TerminateReason.ERROR


async def test_node_exception_message_sanitized(memory_storage):
    """节点异常 → 事件/checkpoint 消息脱敏，内部细节只进日志（S4）。"""

    async def boom(ctx):
        raise RuntimeError("连接器串泄露: postgresql://user:pwd@host/db")

    g = Graph(name="g", entry="a")
    g.add_node("a", boom)
    engine = make_engine(g, storage=memory_storage)
    events: list[EngineEvent] = []
    async for event in engine.run({}, thread_id="t1"):
        events.append(event)
    error_events = [e for e in events if e.type == "error"]
    assert len(error_events) == 1
    assert "postgresql" not in error_events[0].payload["message"]
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None
    assert latest.error is not None
    assert "postgresql" not in latest.error


async def test_node_invalid_overlay_type_terminates(memory_storage):
    """节点返回非 dict 增量 → error 事件 + 图终止（N3，不裸崩溃）。"""

    async def bad(ctx):
        return "not-a-dict"

    g = Graph(name="g", entry="a")
    g.add_node("a", bad)
    g.add_exit("a")
    engine = make_engine(g, storage=memory_storage)
    events: list[EngineEvent] = []
    async for event in engine.run({}, thread_id="t1"):
        events.append(event)
    assert any(e.type == "error" for e in events)
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None
    assert latest.reason == TerminateReason.ERROR
    assert "非法增量类型" in (latest.error or "")


async def test_node_retry_then_success():
    """可配置重试：前 N 次失败，第 N+1 次成功（吸收 core/llm_retry 语义）。"""
    attempts = {"n": 0}

    async def flaky(ctx):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise RuntimeError("transient")
        return {"ok": True}

    g = Graph(name="g", entry="a")
    g.add_node("a", flaky)
    g.add_exit("a")
    engine = make_engine(g, max_node_retries=3)
    state, result = await _execute(engine)
    assert attempts["n"] == 3
    assert state["ok"] is True
    assert result.reason == TerminateReason.REPLY


async def test_node_retry_exhausted_fails():
    attempts = {"n": 0}

    async def flaky(ctx):
        attempts["n"] += 1
        raise RuntimeError("always")

    g = Graph(name="g", entry="a")
    g.add_node("a", flaky)
    engine = make_engine(g, max_node_retries=2)
    _, result = await _execute(engine)
    assert attempts["n"] == 3  # 1 次原试 + 2 次重试
    assert result.reason == TerminateReason.ERROR


async def test_node_skip_on_exception():
    """error_on_exception=False：异常节点跳过（无增量），图继续按边走。"""

    async def boom(ctx):
        raise RuntimeError("boom")

    async def after(ctx):
        return {"continued": True}

    g = Graph(name="g", entry="a")
    g.add_node("a", boom)
    g.add_node("after", after)
    g.add_edge("a", "after")
    g.add_exit("after")
    engine = make_engine(g, error_on_exception=False)
    state, result = await _execute(engine)
    assert state["continued"] is True  # 异常节点被跳过，后续节点正常执行
    assert result.reason == TerminateReason.REPLY


async def test_budget_policy_stops_execution():
    """执行预算钩子：超限终止（budget_exceeded，入轨迹与审计）。"""
    budget = DemoBudgetPolicy(max_nodes=3)
    engine = make_engine(demo_loop_graph(), budget=budget)
    _, result = await _execute(engine)
    assert result.reason == TerminateReason.BUDGET_EXCEEDED
    assert len(budget.visited) >= 3


async def test_budget_policy_normal_flow_passes():
    budget = DemoBudgetPolicy(max_nodes=10)
    engine = make_engine(demo_linear_graph(), budget=budget)
    _, result = await _execute(engine)
    assert result.reason == TerminateReason.REPLY


async def test_truncate_log_branch(memory_storage):
    """编辑重放：日志截断 + 新分支（T6 语义）。"""
    g = demo_linear_graph()
    engine = make_engine(g, storage=memory_storage)
    await _execute(engine, thread_id="t1", round_id="r1")
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None
    # 截断日志后从锚点分叉续跑（新回合无新事件）
    events: list[EngineEvent] = []
    async for event in engine.run(
        {},
        thread_id="t1",
        resume_from=latest.checkpoint_id,
        truncate_log_after=latest.event_seq,
    ):
        events.append(event)
    assert len(events) == 0  # 截断后无增量
    after = await memory_storage.events_after("t1", latest.event_seq)
    assert len(after) == 0  # 截断生效（旧日志删除）


async def test_checkpoint_event_seq_filled(memory_storage):
    """checkpoint.event_seq 回填：恢复重放 = 快照 + 该 seq 之后的增量（B3）。"""
    events_seen: list[int] = []

    async def emitter(ctx):
        await ctx.emit("reply_token", {"text": "a"}, step_id="r:1")
        await ctx.emit("reply_token", {"text": "b"}, step_id="r:2")
        return {"count": 1}

    g = Graph(name="g", entry="a")
    g.add_node("a", emitter)
    g.add_exit("a")
    engine = make_engine(g, storage=memory_storage)
    async for event in engine.run({}, thread_id="t1"):
        events_seen.append(event.seq or 0)
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None
    # 终态 checkpoint 已回填本 run 最大事件 seq（不再恒为 0）
    assert latest.event_seq > 0
    assert latest.event_seq == max(events_seen)
    # 恢复续跑：只重放 event_seq 之后的增量（非全量重放）
    replay: list[EngineEvent] = []
    async for event in engine.run(
        {}, thread_id="t1", round_id="r2", resume_from=latest.checkpoint_id
    ):
        replay.append(event)
    assert len(replay) == 0  # 无增量事件，旧事件不重复投递


async def test_resume_new_engine_instance_incremental(memory_storage):
    """跨实例恢复（服务重启/多 worker）：新 Engine 从 checkpoint 恢复不重复重放。"""

    async def emitter(ctx):
        await ctx.emit("reply_token", {"text": "a"}, step_id="r:1")
        return {"count": 1}

    g = Graph(name="g", entry="a")
    g.add_node("a", emitter)
    g.add_exit("a")
    engine1 = make_engine(g, storage=memory_storage)
    async for _ in engine1.run({}, thread_id="t1"):
        pass
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None and latest.event_seq > 0
    # 全新 Engine 实例（无任何内存态预热）
    engine2 = make_engine(g, storage=memory_storage)
    replay: list[EngineEvent] = []
    async for event in engine2.run({}, thread_id="t1", resume_from=latest.checkpoint_id):
        replay.append(event)
    assert len(replay) == 0  # 锚点来自存储，不重复重放旧事件
    cp2 = await memory_storage.get_latest_checkpoint("t1")
    assert cp2 is not None and cp2.event_seq == latest.event_seq  # 锚点不回退


async def test_subgraph_events_anchor_resume_no_duplicate(memory_storage):
    """子图事件计入父 checkpoint 锚点：resume 不重复投递子图事件（F1）。"""

    async def sub_emit(ctx):
        await ctx.emit("node_start", {"name": "s1"}, step_id="n:1")
        return {"done": True}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_emit)
    sub.add_exit("s1")
    parent = Graph(name="parent", entry="sub")
    parent.add_subgraph("sub", sub)
    parent.add_exit("sub")
    engine = make_engine(parent, storage=memory_storage)
    events: list[EngineEvent] = []
    async for event in engine.run({}, thread_id="t1"):
        events.append(event)
    assert len(events) == 1
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None and latest.event_seq > 0
    replay: list[EngineEvent] = []
    async for event in engine.run({}, thread_id="t1", resume_from=latest.checkpoint_id):
        replay.append(event)
    assert len(replay) == 0  # 子图事件已计入锚点，不重复投递


async def test_interrupt_payload_stripped(memory_storage):
    """中断负载（审批卡）敏感键剥离后才返回宿主（F13）。"""

    async def gated(ctx):
        await ctx.interrupt("gate", {"question": "ok", "api_key": "sk-secret"})

    g = Graph(name="g", entry="a")
    g.add_node("a", gated)
    g.add_exit("a")
    engine = make_engine(g, storage=memory_storage)
    _, result = await _execute(engine, thread_id="t1")
    assert result.interrupt is not None
    assert result.interrupt.payload["api_key"] == ""
    assert result.interrupt.payload["question"] == "ok"


async def test_patch_chain_node_mutation_no_duplicate():
    """补丁链通道：节点读链→就地追加→整链返回不重复追加（N1）。"""
    from engine_core.patch_chain import Patch, PatchChain, PatchOp
    from engine_core.state import StateSchema

    schema = StateSchema(channels={"draft": "patch_chain"})

    async def seed(ctx):
        return {"draft": PatchChain(base={"text": ""})}

    async def append(ctx):
        chain = ctx.state.get("draft")
        chain.apply(Patch(op=PatchOp.APPEND, path=("text",), value="段落A"))
        return {"draft": chain}

    g = Graph(name="g", entry="seed")
    g.add_node("seed", seed)
    g.add_node("append", append)
    g.add_edge("seed", "append")
    g.add_exit("append")
    engine = make_engine(g, schema=schema)
    state, _ = await _execute(engine)
    chain = state["draft"]
    assert chain.length == 1  # 不重复追加
    assert chain.assemble() == {"text": ["段落A"]}


async def test_subgraph_patch_chain_reflow_no_duplicate():
    """子图回流：patch_chain 通道输出回流父图不重复追加（N1+S5）。"""
    from engine_core.patch_chain import Patch, PatchChain, PatchOp
    from engine_core.state import StateSchema

    schema = StateSchema(channels={"content": "patch_chain"})
    parent = Graph(name="parent", entry="sub")

    async def sub_work(ctx):
        return {"content": Patch(op=PatchOp.APPEND, path=("text",), value="子图内容")}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_work)
    sub.add_exit("s1")
    parent.add_subgraph("sub", sub)

    async def after(ctx):
        return {}

    parent.add_node("after", after)
    parent.add_edge("sub", "after")
    parent.add_exit("after")
    engine = make_engine(parent, schema=schema)
    state, _ = await _execute(
        engine, {"content": PatchChain(base={})}
    )
    chain = state["content"]
    assert chain.length == 1
    assert chain.assemble() == {"text": ["子图内容"]}


async def test_stale_inject_cleaned_after_run():
    """注入值一次性：run 结束后未消费的注入残留被清理（N2）。"""

    async def gated(ctx):
        decision = await ctx.interrupt("gate", {"q": "?"})
        return {"decision": decision}

    g = Graph(name="g", entry="a")
    g.add_node("a", gated)
    g.add_exit("a")
    engine = make_engine(g)
    # run 未消费注入即结束（图路径根本不经过中断点）→ 残留应被清理
    async def no_interrupt_node(ctx):
        return {}

    g2 = Graph(name="g2", entry="n")
    g2.add_node("n", no_interrupt_node)
    g2.add_exit("n")
    engine2 = make_engine(g2)
    async for _ in engine2.run({}, thread_id="t", inject={"gate": "stale"}):
        pass
    assert "gate" not in engine2._coordinator.pending_inject
    # 下一次 run（同引擎）无注入：中断点不再拿到残留值，正常挂起
    _, result = await _execute(engine, thread_id="t2")
    assert result.interrupt is not None and result.interrupt.key == "gate"


async def test_run_stream_converges_cleanly():
    """事件流以哨兵收敛（无超时残留）。"""
    g = demo_linear_graph()
    engine = make_engine(g)
    count = 0
    async for _ in engine.run({}, thread_id="t"):
        count += 1
    assert count == 0


async def test_run_state_with_schema():
    schema = StateSchema(channels={"messages": "add_messages"})
    g = demo_linear_graph()
    engine = make_engine(g, schema=schema)
    state, _ = await _execute(engine, {"messages": [{"id": "m0"}]})
    assert state["count"] == 3  # schema 外键裸覆盖照常


async def test_transport_failure_does_not_block():
    """传输异常不阻断主流程（观测不阻断执行）。"""

    class BrokenTransport:
        async def send(self, event):
            raise RuntimeError("broken")

    async def emitter(ctx):
        await ctx.emit("reply_token", {"text": "hi"})

    g = Graph(name="g", entry="a")
    g.add_node("a", emitter)
    g.add_exit("a")
    engine = make_engine(g, transports=[BrokenTransport()])
    events: list[EngineEvent] = []
    async for event in engine.run({}, thread_id="t"):
        events.append(event)
    assert len(events) == 1


async def test_subgraph_additive_reducer_reflow_delta():
    """additive reducer 声明化：滚动追加族子图回流按条目差集（不二次追加）。

    业务自定义追加型 reducer 经 register_reducer(additive=True) 声明后，
    嵌套子图回流增量 = 终态 − 入口条目（父图滚动追加恰好一次）。
    """
    from engine_core.state import register_reducer

    def roll_summary(base, overlay):
        items = list(base or [])
        for item in overlay or []:
            if isinstance(item, dict) and item.get("text"):
                items.append(dict(item))
        return items[-3:]

    register_reducer("roll_summary", roll_summary, additive=True)
    schema = StateSchema({"summary": "roll_summary"})
    parent = Graph(name="parent", entry="sub")

    async def sub_work(ctx):
        return {"summary": [{"kind": "k", "text": "子图新增"}]}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_work)
    sub.add_exit("s1")
    parent.add_subgraph("sub", sub)
    parent.add_exit("sub")

    engine = make_engine(parent, schema=schema)
    state, _ = await _execute(
        engine, {"summary": [{"kind": "k", "text": "既有"}]}
    )
    # 回流只带新增条目 → 父图滚动追加恰好一次（无「既有」重复）
    assert state["summary"] == [
        {"kind": "k", "text": "既有"},
        {"kind": "k", "text": "子图新增"},
    ]


async def test_subgraph_merge_dicts_reflow_accumulates():
    """merge_dicts 通道（domain_windows 同款）：多次子图访问逐次累加不互覆。

    合并累加族通道入口剥离归零、终态整体回流——两次子图写入不同键时
    父图 merge 恰好一次，后访问不覆盖先访问（裸覆盖通道会互覆丢值）。
    """
    from functools import partial

    schema = StateSchema({"group": None, "windows": "merge_dicts"})
    parent = Graph(name="parent", entry="first")

    async def set_group(ctx, group: str):
        return {"group": group}

    async def sub_work(ctx):
        return {"windows": {ctx.state.get("group"): {"digest": f"d-{ctx.state.get('group')}"}}}

    sub = Graph(name="sub", entry="s1")
    sub.add_node("s1", sub_work)
    sub.add_exit("s1")

    parent.add_node("first", partial(set_group, group="query"))
    parent.add_node("second", partial(set_group, group="entity"))
    parent.add_subgraph("sub", sub)
    parent.add_node("done", lambda ctx: {})

    async def again(ctx):
        return ctx.state.get("group") == "query"

    async def to_done(ctx):
        return ctx.state.get("group") == "entity"

    parent.add_edge("first", "sub")
    parent.add_conditional_edge("sub", "second", again)
    parent.add_edge("second", "sub")
    parent.add_conditional_edge("sub", "done", to_done)
    parent.add_exit("done")

    engine = make_engine(parent, schema=schema)
    state, _ = await _execute(engine)
    assert state["windows"] == {
        "query": {"digest": "d-query"},
        "entity": {"digest": "d-entity"},
    }


async def test_resume_from_subgraph_checkpoint_graph_path_aware(memory_storage):
    """graph_path 感知恢复：锚点落在嵌套子图 checkpoint 时从子图内继续。

    断线续流锚点 = 内层子图中断 checkpoint：沿版本链回溯各级最近锚点，
    顶层/中间层从各自最近 checkpoint 恢复（祖先节点不重跑），内层重入
    中断节点（inject 值继续），最终状态正确。
    """
    calls = {"top": 0, "tool": 0, "gate": 0, "finish": 0}

    async def top(ctx):
        calls["top"] += 1
        return {"top_done": True}

    async def tool_entry(ctx):
        calls["tool"] += 1
        return {}

    async def gate(ctx):
        calls["gate"] += 1
        decision = await ctx.interrupt("inner_gate", {"q": "?"})
        return {"passed": decision == "yes"}

    async def finish(ctx):
        calls["finish"] += 1
        return {"inner_done": True}

    domain = Graph(name="domain", entry="gate")
    domain.add_node("gate", gate)
    domain.add_node("finish", finish)
    domain.add_edge("gate", "finish")
    domain.add_exit("finish")

    tool = Graph(name="tool", entry="tool_entry")
    tool.add_node("tool_entry", tool_entry)
    tool.add_subgraph("domain", domain)
    tool.add_edge("tool_entry", "domain")
    tool.add_exit("domain")

    parent = Graph(name="parent", entry="top")
    parent.add_node("top", top)
    parent.add_subgraph("tool", tool)
    parent.add_edge("top", "tool")
    parent.add_exit("tool")

    engine = make_engine(parent, storage=memory_storage)
    _, result = await _execute(engine, thread_id="t1")
    assert result.interrupt is not None and result.interrupt.key == "inner_gate"
    assert calls == {"top": 1, "tool": 1, "gate": 1, "finish": 0}

    # 锚点 = 最近 checkpoint（顶层中断锚点，graph_path=()）；恢复逻辑沿版本链
    # 回溯各级子图锚点（("tool",) / ("tool","domain")）并下沉恢复
    anchor = await memory_storage.get_latest_checkpoint("t1")
    assert anchor is not None and anchor.graph_path == ()
    engine._coordinator.inject({"inner_gate": "yes"})
    state, result = await _execute(
        engine,
        thread_id="t1",
        resume_from=anchor.checkpoint_id,
    )
    assert result.reason == TerminateReason.REPLY
    assert state["passed"] is True
    assert state["inner_done"] is True
    # 祖先节点（top/tool_entry）不重跑；gate 中断重入执行一次
    assert calls == {"top": 1, "tool": 1, "gate": 2, "finish": 1}  # 执行未被打断
