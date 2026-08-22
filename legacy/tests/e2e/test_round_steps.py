"""回合步骤记录 e2e（引擎 core.round_steps 原语的产品化接线）。

- 传输包裹：事件流喂 RoundSteps（分类计数/流式拼卡/tool 复用/空卡丢弃）；
- 边界与快照：begin_round 换累积器，snapshot 为 checkpoint 回放形态；
- 种子恢复：checkpoint 步骤种子 → 续流 step_id 连续（不重号）；
- 挡位统计：评审管线 LLM 调用归因 main（TierCallStats → llm_calls_by_tier）。
"""
from __future__ import annotations

from conftest import SEED_ROOT, StubLLM

from host.host import boot_inkling
from host.round_steps_feed import RoundStepsTransport

from ink_engine.core.events import EngineEvent


def _event(etype: str, payload: dict | None = None, **kw) -> EngineEvent:
    return EngineEvent(type=etype, payload=payload or {}, **kw)


async def test_round_steps_transport_accumulates_protocol():
    """分类累积：thinking 流式拼卡、tool 卡复用、空 thinking 丢弃、user 幂等。"""
    recorder = RoundStepsTransport("round-1")
    feed = recorder.feed
    feed(_event("user", {"content": "研究墨引擎"}))
    feed(_event("user", {"content": "研究墨引擎"}))  # 幂等：回合边界单条
    feed(_event("thinking_start", {"content": ""}))
    feed(_event("thinking_token", {"token": "先检索"}))
    feed(_event("thinking_token", {"token": "再蒸馏"}))
    feed(_event("thinking_end", {}))
    feed(_event("plan_start", {}))
    feed(_event("plan_end", {}))  # 空规划卡丢弃
    feed(_event("tool_start", {"tool": "collect_material", "tool_call_id": "tc-1"}))
    feed(_event("tool_start", {"tool": "collect_material", "tool_call_id": "tc-1"}))  # 复用卡
    feed(_event("tool_end", {"tool_call_id": "tc-1", "success": True}))
    feed(_event("review_card", {"tool_call_id": "tc-2", "review_type": "gate", "node_id": "x", "node_label": "审批"}))
    feed(_event("error", {"content": "失败留痕"}))

    steps = recorder.snapshot()
    by_type = {s["type"]: s for s in steps}
    user_steps = [s for s in steps if s["type"] == "user"]
    assert len(user_steps) == 1  # 幂等
    assert by_type["thinking"]["payload"]["content"] == "先检索再蒸馏"
    assert by_type["thinking"]["payload"]["status"] == "completed"
    assert "plan" not in steps  # 空规划卡被丢弃
    assert [s["type"] for s in steps] == ["user", "thinking", "tool", "review_card", "error"]
    tool = by_type["tool"]
    assert tool["payload"]["status"] == "done"
    assert tool["payload"]["tool_call_id"] == "tc-1"
    # 事件 step_id 稳定（RoundSteps 生成与协议同 key）
    assert tool["step_id"] == "tool:tc-1"
    assert by_type["review_card"]["step_id"] == "card:1"
    assert by_type["error"]["step_id"] == "error:1"


async def test_round_steps_transport_seed_restore_continues_ids():
    """checkpoint 种子恢复：续流回合 step_id 与中断前连续（前端增量 key 不重号）。"""
    recorder = RoundStepsTransport(
        "round-2",
        seed=[
            {"step_id": "user", "type": "user", "payload": {"content": "上一轮"}},
            {"step_id": "think:1", "type": "thinking", "payload": {"status": "completed", "content": "既有思考"}},
            {"step_id": "card:1", "type": "review_card", "payload": {"payload": {"review_type": "gate"}}},
        ],
    )
    recorder.feed(_event("thinking_start"))
    recorder.feed(_event("thinking_token", {"token": "续流"}))
    recorder.feed(_event("thinking_end", {}))
    recorder.feed(_event("tool_start", {"tool": "search", "tool_call_id": ""}))
    ids = [s["step_id"] for s in recorder.snapshot()]
    assert ids == ["user", "think:1", "card:1", "think:2", "tool:1"]
    recorder.feed(_event("review_card", {"review_type": "gate", "node_id": "y", "node_label": "再审批"}))
    assert recorder.snapshot()[-1]["step_id"] == "card:2"


async def test_host_round_recorder_wrapped_and_tier_stats_recorded():
    """宿主接线：事件经 RoundStepsTransport 包裹；评审管线 LLM 调用归因 main。"""
    runtime, host, _mount = await boot_inkling(
        SEED_ROOT,
        llm=StubLLM(script={"你是评审器": {"reply": '{"score": 0.9, "reason": "ok"}'}}),
    )
    try:
        host.begin_round("wire-round")
        await host.review_pipeline(["候选文稿"])
        assert host.tier_stats.snapshot().get("main") is not None  # 归因统计
        # 传输包裹：事件流先喂 RoundSteps 再转下游收集器
        transport = host.build_transport()
        await transport.send(_event("user", {"content": "手动事件"}))
        assert host.round_recorder.snapshot()  # 步骤序列已累积
        # 挡位链：无环境配置 → 双挡位链均为 None（离线下确定性/无评审基线）
        assert host.tier_chains == {"main": None, "router": None}
    finally:
        await runtime.stop()
        await host.close()
