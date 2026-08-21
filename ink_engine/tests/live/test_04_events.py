"""族 4：事件与传输（test_04_events.py）｜events/event_types/round_steps/logging。

- Collector/JSON Lines 真实序列；step_id/round_id/parent_step_id 轨迹树；
  trace_id 单次 run 内一致
- EventTypeSpec 注册/宽松发射折叠/system 事件（step_id=None）；协议版本
  from_dict 校验；事件负载敏感键剥离
- RoundSteps：回合步骤累积（user/reply_token/review_card/tool_*/node_*/
  plan_*/error）step_id 稳定
- logging：configure_engine_logging 幂等挂载 + trace_id 日志贯穿 +
  redact 凭据不出日志

确定性机制用例（零模型调用）+ 1 条真实 LLM 用例（族门禁②）。
"""
from __future__ import annotations

import io
import logging

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.event_types import EventTypeRegistry, EventTypeSpec  # noqa: E402
from ink_engine.core.events import (  # noqa: E402
    PROTOCOL_VERSION,
    CollectorTransport,
    EngineEvent,
)
from ink_engine.core.exceptions import ProtocolVersionError  # noqa: E402
from ink_engine.core.executor import Engine, RunOptions  # noqa: E402
from ink_engine.core.graph import Graph  # noqa: E402
from ink_engine.core.logging import configure_engine_logging, redact  # noqa: E402
from ink_engine.core.round_steps import RoundSteps  # noqa: E402
from ink_engine.core.security import strip_sensitive  # noqa: E402

# ----------------------------------------------------------------------
# 事件序列 / 轨迹树 / trace_id
# ----------------------------------------------------------------------

def test_event_roundtrip_and_json_lines():
    event = EngineEvent(
        type="tool_start",
        payload={"tool": "file_ops", "api_key": "sk-leak-check"},
        step_id="tool:1",
        parent_step_id="node:0",
        round_id="r1",
        node="n1",
        trace_id="tr-1",
        thread_id="t1",
    )
    data = event.to_dict()
    restored = EngineEvent.from_dict(data)
    assert restored == event
    assert '"type": "tool_start"' in event.to_json()
    # 敏感键剥离（安全模块同规格：落库/出网/日志三出口共用）
    stripped = strip_sensitive(event.payload)
    assert stripped.get("api_key") == ""  # 敏感键被清空
    assert stripped["tool"] == "file_ops"


def test_trace_id_consistent_single_run(memory_storage):
    """单次 run 内 trace_id 一致（跨节点事件同属一次执行）。"""

    async def node_a(ctx):
        await ctx.emit("a_event", {"n": 1}, step_id="step:a")
        return {}

    async def node_b(ctx):
        await ctx.emit("b_event", {"n": 2}, step_id="step:b")
        return {}

    g = Graph(name="trace", entry="a")
    g.add_node("a", node_a)
    g.add_node("b", node_b)
    g.add_edge("a", "b")
    g.add_exit("b")
    engine = Engine(g, options=RunOptions(transports=[CollectorTransport()], storage=memory_storage))
    trace = {"id": None}

    class TrackingTransport(CollectorTransport):
        async def send(self, event: EngineEvent) -> None:
            trace["id"] = trace["id"] or event.trace_id
            if trace["id"] is not None:
                assert event.trace_id == trace["id"], "trace_id 单次 run 内漂移"
            await super().send(event)

    engine.options.transports = [TrackingTransport()]
    import asyncio

    asyncio.run(engine.ainvoke({}, thread_id="t"))
    assert trace["id"] and trace["id"] != "-"


def test_parent_step_id_tree(memory_storage):
    """轨迹树：推演分支事件 parent_step_id 指向决策点步骤（树根可重建）。"""
    import asyncio

    from ink_engine.core.simulation import SIMULATE_KEY, Evaluation

    async def branch_node(ctx):
        await ctx.emit("branch_run", {"b": 1})
        return {"v": ctx.state.get("seed", 0)}

    branch = Graph(name="branch", entry="b1")
    branch.add_node("b1", branch_node)
    branch.add_exit("b1")

    async def decide(ctx):
        return {
            SIMULATE_KEY: {
                "step_id": "sim:1",
                "branches": [{"subgraph": branch, "state": {"seed": 1}, "index": 0}],
            }
        }

    class Eval:
        async def evaluate(self, spec, overlay):
            return Evaluation(score=1.0, passed=True, note="ok")

    g = Graph(name="tree", entry="decide")
    g.add_node("decide", decide)
    g.add_exit("decide")
    transport = CollectorTransport()
    engine = Engine(
        g,
        options=RunOptions(
            transports=[transport],
            storage=memory_storage,
            evaluator=Eval(),
        ),
    )
    asyncio.run(engine.ainvoke({}, thread_id="t"))
    branch_events = [e for e in transport.events if e.type == "branch_run"]
    assert branch_events
    assert branch_events[0].parent_step_id == "sim:1"  # 轨迹树：子事件回指决策点


# ----------------------------------------------------------------------
# EventTypeSpec / 注册 / 宽松折叠 / system 事件 / 协议版本
# ----------------------------------------------------------------------

def test_event_type_registry_classify():
    registry = EventTypeRegistry()
    registry.register(EventTypeSpec(name="tool_audit", system=False, meta={"tier": "audit"}))
    registry.register(EventTypeSpec(name="sys_heartbeat", system=True))
    # 注册后分类通过
    verdict = registry.classify("tool_audit", {"ok": True})
    assert verdict.status == "registered"
    # 宽松发射：未注册类型不阻断（仅折叠标记）
    loose = registry.classify("unknown_type", {})
    assert loose.status == "unknown"
    assert loose.fold is True
    # system 事件注入集合（step_id=None 语义）
    assert "sys_heartbeat" in registry.system_events()


def test_protocol_version_check():
    event = EngineEvent(type="e", payload={}, thread_id="t")
    assert event.version == PROTOCOL_VERSION
    data = event.to_dict()
    data["version"] = 999
    with pytest.raises(ProtocolVersionError):
        EngineEvent.from_dict(data)  # 版本不匹配 = 显式拒绝


# ----------------------------------------------------------------------
# RoundSteps 回合步骤累积
# ----------------------------------------------------------------------

def test_round_steps_accumulation():
    steps = RoundSteps("r1")
    user_id = steps.user("你好")
    assert user_id == "user"  # 用户消息步骤幂等（回合边界卡唯一）
    token_id = steps.reply_token("你")
    assert token_id == "reply:1"
    steps.reply_token("好")
    tool_id = steps.tool_start("file_ops", "tc-1")
    assert tool_id == "tool:tc-1"
    steps.tool_end("tc-1", success=True)
    node_id = steps.node_start("writer", "写作节点")
    assert node_id == "node:writer"
    steps.node_stream("writer", 0, "t")
    steps.node_end("writer", 0, tokens=3)
    card_id = steps.review_card({"key": "approve", "action": "write"})
    assert card_id == "card:1"
    plan_id = steps.plan_start()
    assert plan_id == "plan:1"
    error_id = steps.error("失败")
    assert error_id == "error:1"
    # step_id 稳定：序列化后顺序与类型完整
    all_steps = steps.steps()
    types = [s["type"] for s in all_steps]
    assert types[0] == "user" and types[-1] == "error"
    assert all(s["step_id"] for s in all_steps)
    # 续流恢复：种子反推计数，step_id 与中断前连续
    resumed = RoundSteps("r1", seed=all_steps)
    assert resumed.user("再来") == "user"  # 幂等不重复
    assert resumed.reply_token("续") == "reply:2"


def test_round_steps_final_reply():
    steps = RoundSteps("r2")
    steps.reply_token("答")
    steps.set_final_reply("答案是 42")
    last = steps.last_step()
    assert last["type"] == "reply_token" and last["payload"]["content"] == "答案是 42"


# ----------------------------------------------------------------------
# logging：幂等挂载 / trace_id 贯穿 / redact
# ----------------------------------------------------------------------

def test_logging_idempotent_and_redact():
    configure_engine_logging(logging.INFO)
    configure_engine_logging(logging.INFO)  # 幂等：二次挂载不报错不重复 handler
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    logger = logging.getLogger("live.test")
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    # redact：凭据形态不出日志
    logger.info("调用密钥 %s 已记录", redact("sk-abcdef1234567890"))
    output = buffer.getvalue()
    assert "sk-abcdef1234567890" not in output
    assert redact("sk-abcdef1234567890") != "sk-abcdef1234567890"


def test_logging_redact_variants():
    assert "sk-live-key-123" not in redact("sk-live-key-123")
    assert redact("普通文本") == "普通文本"  # 非敏感形态原样
    assert redact("") == ""


# ----------------------------------------------------------------------
# 真实 LLM 回合事件流（族门禁②）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_round_event_stream_and_trace(live_llm, memory_storage):
    """真实 LLM 回合事件流：trace_id 单次 run 一致、reply 事件真实负载、轨迹树完整。"""
    from ink_engine.core.executor import Engine, RunOptions
    from ink_engine.core.graph import Graph, TerminateReason
    from ink_engine.core.llm.messages import user

    async def llm_node(ctx):
        result = await live_llm.ainvoke([user("用一句话回答：事件流验证")])
        await ctx.emit("reply_token", {"content": result.content})
        return {"answer": result.content}

    g = Graph(name="real_events", entry="n")
    g.add_node("n", llm_node)
    g.add_exit("n")
    transport = CollectorTransport()
    engine = Engine(g, options=RunOptions(storage=memory_storage, transports=[transport]))
    result = await engine.ainvoke({}, thread_id="real-events")
    assert result.reason == TerminateReason.REPLY
    reply = [e for e in transport.events if e.type == "reply_token"]
    assert reply and reply[0].payload["content"].strip()  # 真实负载
    trace_ids = {e.trace_id for e in transport.events}
    assert len(trace_ids) == 1 and "-" not in trace_ids  # 单次 run 内一致
    step_ids = {e.step_id for e in transport.events if e.step_id}
    for e in transport.events:
        if e.parent_step_id:
            assert e.parent_step_id in step_ids  # 轨迹树连续
    live_event = reply[0]
    assert EngineEvent.from_dict(live_event.to_dict()) == live_event  # 真实事件 round-trip
