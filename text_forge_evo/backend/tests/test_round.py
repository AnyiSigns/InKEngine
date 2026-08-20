"""回合循环单测：图执行 + LLM 工具循环的事件流与容错。"""

from __future__ import annotations

import json

from ink_engine.core.events import CollectorTransport
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.llm import LLMChunk
from ink_engine.core.llm.messages import ToolCallDelta

from app import boot
from app.round import build_forge_graph

TOOL_CHUNKS = [
    LLMChunk(reasoning_token="让我先观察自身形态。"),
    LLMChunk(
        tool_calls_delta=[
            ToolCallDelta(index=0, id="call_1", name="inspect_graph", arguments_delta='{"limit":')
        ]
    ),
    LLMChunk(tool_calls_delta=[ToolCallDelta(index=0, arguments_delta="5}")]),
]

REPLY_CHUNKS = [
    LLMChunk(token="我是 Forge，"),
    LLMChunk(token="这是观察后的回复。"),
]

# 第二轮同样带推理：同一回合内两段思考应分属两张卡
THINKING_REPLY_CHUNKS = [
    LLMChunk(reasoning_token="让我组织一下答复。"),
    LLMChunk(token="这是两段思考后的回复。"),
]


class FakeLLM:
    """回合测试用假模型：首轮推理+工具调用，次轮纯正文回复。"""

    def __init__(self) -> None:
        self.turns = [TOOL_CHUNKS, REPLY_CHUNKS]
        self.index = 0

    async def astream(self, messages, *, tools=None, params=None):
        chunks = self.turns[min(self.index, len(self.turns) - 1)]
        self.index += 1
        for chunk in chunks:
            yield chunk

    async def aclose(self) -> None:
        pass


class RaisingLLM:
    """首轮即抛错的假模型（容错路径：节点内捕获并产出 error 事件）。"""

    async def astream(self, messages, *, tools=None, params=None):
        raise ConnectionError("网络不可达")
        yield  # pragma: no cover


async def _assembled_app():
    """轻量装配：内省流水线 + 回合图（绕过 HTTP 与全局单例）。"""
    return await boot.init_app()


async def _run_round(llm, *, storage=None):
    app = await _assembled_app()
    graph = build_forge_graph(
        llm,
        app.introspection_pipeline,
        app.introspection_specs,
        storage=storage or app.storage,
    )
    engine = Engine(
        graph,
        options=RunOptions(
            storage=storage or app.storage,
            registries=app.graph_registries,
            transports=[],
        ),
    )
    transport = CollectorTransport()
    await engine.ainvoke(
        {"input": "介绍一下你自己", "thread_id": "t1"},
        thread_id="t1",
        round_id="r1",
        transports=[transport],
    )
    return transport, app


class TwoSegmentThinkingLLM(FakeLLM):
    """两段推理的假模型：工具调用前后各思考一次，应各占一张思考卡。"""

    def __init__(self) -> None:
        self.turns = [TOOL_CHUNKS, THINKING_REPLY_CHUNKS]
        self.index = 0


async def test_round_thinking_segments_get_own_cards() -> None:
    # 同一回合内两段推理：thinking:1 / thinking:2 各自成卡，不互相堆叠
    transport, _app = await _run_round(TwoSegmentThinkingLLM())
    starts = [
        ev.step_id for ev in transport.events if ev.type == "thinking_start"
    ]
    ends = [ev.step_id for ev in transport.events if ev.type == "thinking_end"]
    assert starts == ["thinking:1", "thinking:2"]
    assert ends == ["thinking:1", "thinking:2"]
    # 每段思考的 token 都挂在各自段上
    tokens_by_step: dict[str, str] = {}
    for ev in transport.events:
        if ev.type == "thinking_token":
            tokens_by_step[ev.step_id or ""] = tokens_by_step.get(ev.step_id or "", "") + (
                ev.payload.get("token") or ""
            )
    assert "让我先观察自身形态。" in tokens_by_step["thinking:1"]
    assert "让我组织一下答复。" in tokens_by_step["thinking:2"]


async def test_round_event_sequence() -> None:
    transport, _app = await _run_round(FakeLLM())
    types = [ev.type for ev in transport.events]
    assert types == [
        "thinking_start",
        "thinking_token",
        "thinking_end",
        "tool_start",
        "tool_audit",
        "tool_end",
        "reply_token",
        "reply_token",
        "end",
    ]
    tool_start = next(ev for ev in transport.events if ev.type == "tool_start")
    assert tool_start.payload["tool"] == "inspect_graph"
    assert tool_start.payload["category"] == "query"
    assert tool_start.step_id == "tool:call_1"
    assert tool_start.round_id == "r1"
    tool_end = next(ev for ev in transport.events if ev.type == "tool_end")
    assert tool_end.payload["success"] is True
    end = next(ev for ev in transport.events if ev.type == "end")
    assert "我是 Forge" in end.payload["reply"]
    assert end.payload["thread_id"] == "t1"
    assert end.payload["round_id"] == "r1"


async def test_round_tool_result_feeds_next_turn() -> None:
    # 工具结果回填消息：第二轮 LLM 收到 tool 角色消息（含内省快照）
    captured: list[list] = []

    class CapturingLLM(FakeLLM):
        async def astream(self, messages, *, tools=None, params=None):
            captured.append(list(messages))
            async for chunk in super().astream(messages, tools=tools, params=params):
                yield chunk

    await _run_round(CapturingLLM())
    second_turn = captured[1]
    tool_msg = [m for m in second_turn if m.role == "tool"]
    assert len(tool_msg) == 1
    assert tool_msg[0].tool_call_id == "call_1"
    assert json.loads(tool_msg[0].content)["graph"]["name"] == "forge_round"


async def test_round_llm_error_emits_error_and_end() -> None:
    transport, _app = await _run_round(RaisingLLM())
    types = [ev.type for ev in transport.events]
    assert "error" in types
    assert types[-1] == "end"
    error = next(ev for ev in transport.events if ev.type == "error")
    assert "模型调用失败" in error.payload["message"]


async def test_round_unknown_tool_rejected() -> None:
    # 模型请求未知工具：tool_end success=False，回合正常收尾
    chunks = [
        LLMChunk(
            tool_calls_delta=[
                ToolCallDelta(index=0, id="c9", name="inspect_nothing", arguments_delta="{}")
            ]
        ),
        REPLY_CHUNKS[0],
    ]

    class WeirdLLM(FakeLLM):
        def __init__(self) -> None:
            self.turns = [chunks, REPLY_CHUNKS]
            self.index = 0

    transport, _app = await _run_round(WeirdLLM())
    tool_end = next(ev for ev in transport.events if ev.type == "tool_end")
    assert tool_end.payload["success"] is False
    assert "未知工具" in tool_end.payload["message"]
    assert transport.events[-1].type == "end"


async def test_introspection_pipeline_denies_unknown_permission() -> None:
    app = await _assembled_app()
    from ink_engine.core.llm.tools import ToolSpec

    bare = ToolSpec(name="inspect_graph", description="无权限声明", parameters={})
    result = await app.introspection_pipeline.execute(None, bare, {})
    assert result.ok is False


async def test_round_injects_ui_context_note() -> None:
    # 用户位置感知汇入：预置位置快照 + 交互事件 → 回合 system 消息携带摘要
    app = await _assembled_app()
    await app.storage.put_record(
        "ui_context",
        "latest",
        {
            "active_app": "forge",
            "active_view": "chat",
            "current_layout": "boot.panel",
            "focused_component": "agent_input",
            "selection": None,
        },
    )
    await app.storage.put_record(
        "ui_events",
        "evt-1",
        {"type": "click", "component": "agent_input", "detail": "", "ts": 1.0},
    )
    captured: list[list] = []

    class CapturingLLM(FakeLLM):
        async def astream(self, messages, *, tools=None, params=None):
            captured.append(list(messages))
            async for chunk in super().astream(messages, tools=tools, params=params):
                yield chunk

    transport, _app = await _run_round(CapturingLLM())
    first_turn = captured[0]
    system_text = "".join(m.content for m in first_turn if m.role == "system")
    assert "## 用户位置感知（ui_context）" in system_text
    assert "当前布局" in system_text or "current_layout" in system_text
    assert "boot.panel" in system_text
    assert "最近交互：click agent_input" in system_text
    assert transport.events[-1].type == "end"
