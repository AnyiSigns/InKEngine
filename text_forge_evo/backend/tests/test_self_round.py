"""自指回合闭环单测：演化工具在回合内完成「提案 → 审批 → 落链 → 生效」。

覆盖：L0 补丁（主题）在回合内直过落链；L1 补丁（工具）挂审批卡
（回合挂起）→ 决议注入重入 → 落链生效；审计留痕可读。
"""
from __future__ import annotations

from ink_engine.core.events import CollectorTransport
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.llm import LLMChunk
from ink_engine.core.llm.messages import ToolCallDelta

from app import boot
from app.round import build_forge_graph

PATCH_THEME_CHUNKS = [
    LLMChunk(
        tool_calls_delta=[
            ToolCallDelta(
                index=0,
                id="call_theme",
                name="apply_patch",
                arguments_delta=(
                    '{"kind": "theme", "payload": {"tokens": {"bg": "#123456"}},'
                    ' "rationale": "换深色主题"}'
                ),
            )
        ]
    ),
]

PATCH_TOOL_CHUNKS = [
    LLMChunk(
        tool_calls_delta=[
            ToolCallDelta(
                index=0,
                id="call_tool",
                name="apply_patch",
                arguments_delta=(
                    '{"kind": "tool", "payload": {"name": "list_workspace",'
                    ' "description": "列出工作区文件",'
                    ' "permissions": ["filesystem:read:/workspace"],'
                    ' "endpoint": "file_ops", "endpoint_config": {"root": "/workspace"}},'
                    ' "rationale": "注册工作区查看工具"}'
                ),
            )
        ]
    ),
]

REPLY_CHUNKS = [
    LLMChunk(token="补丁已落地。"),
]


class PatchLLM:
    """回合测试用假模型：首轮演化工具调用，次轮纯正文回复。"""

    def __init__(self, chunks) -> None:
        self.turns = [chunks, REPLY_CHUNKS]
        self.index = 0

    async def astream(self, messages, *, tools=None, params=None):
        chunks = self.turns[min(self.index, len(self.turns) - 1)]
        self.index += 1
        for chunk in chunks:
            yield chunk

    async def aclose(self) -> None:
        pass


async def _assembled_app():
    return await boot.init_app()


def _engine(app, llm):
    graph = build_forge_graph(
        llm,
        app.tool_pipeline,
        [
            *app.introspection_specs,
            *app.self_specs,
            *app.tool_registry.values(),
        ],
        storage=app.storage,
    )
    return Engine(
        graph,
        options=RunOptions(
            storage=app.storage,
            registries=app.graph_registries,
            transports=[],
            system_events=app.event_type_registry.system_events(),
        ),
    )


async def test_l0_theme_patch_applies_within_round() -> None:
    # L0（主题）直过：回合内提案 → 落链 → 活跃态生效，无挂起
    app = await _assembled_app()
    engine = _engine(app, PatchLLM(PATCH_THEME_CHUNKS))
    transport = CollectorTransport()
    await engine.ainvoke(
        {"input": "把主题换成深色", "thread_id": "t-l0"},
        thread_id="t-l0",
        round_id="r-l0",
        transports=[transport],
    )
    # 无挂起卡（L0 直过）
    assert await engine.get_latest_interrupt("t-l0") is None
    # 链已落补丁，主题生效
    state = await app.self_pipeline.chain.assemble()
    assert state["theme"] == {"bg": "#123456"}
    # 审计留痕（applied）
    log = await app.self_pipeline.audit_log()
    assert any(entry["kind"] == "theme" and entry["status"] == "applied" for entry in log)
    # 事件流含 end（回合完成）
    assert any(e.type == "end" for e in transport.events)


async def test_l1_tool_patch_gates_and_resume_applies() -> None:
    # L1（工具注册）挂卡：回合挂起（无 end），决议注入 accept 后重入完成
    app = await _assembled_app()
    engine = _engine(app, PatchLLM(PATCH_TOOL_CHUNKS))
    transport = CollectorTransport()
    await engine.ainvoke(
        {"input": "注册一个工作区工具", "thread_id": "t-l1"},
        thread_id="t-l1",
        round_id="r-l1",
        transports=[transport],
    )
    # 回合挂起：无 end 事件，链尾有审批卡
    assert not any(e.type == "end" for e in transport.events)
    # 审批卡进事件流：review_card 随 SSE 直出（前端据此渲染审批卡）
    review_cards = [e for e in transport.events if e.type == "review_card"]
    assert len(review_cards) == 1
    assert review_cards[0].payload["review_type"] == "gate"
    interrupt = await engine.get_latest_interrupt("t-l1")
    assert interrupt is not None
    assert interrupt.key == "patch:tool"
    card = interrupt.payload
    assert card["review_type"] == "gate"
    assert card["patch"]["kind"] == "tool"
    assert card["patch"]["payload"]["name"] == "list_workspace"
    # 链未落（挂起等待决议）
    state = await app.self_pipeline.chain.assemble()
    assert "list_workspace" not in (state.get("tools") or {})

    # 决议注入重入（同引擎实例续流：锚点 = 挂起卡 checkpoint）
    latest = await app.storage.get_latest_checkpoint("t-l1")
    assert latest is not None and latest.interrupt is not None
    transport2 = CollectorTransport()
    await engine.ainvoke(
        {},
        thread_id="t-l1",
        round_id="r-l1-resume",
        resume_from=latest.checkpoint_id,
        inject={interrupt.key: {"decision": "accept"}},
        transports=[transport2],
    )
    assert any(e.type == "end" for e in transport2.events)
    state = await app.self_pipeline.chain.assemble()
    assert state["tools"]["list_workspace"]["name"] == "list_workspace"
    # 活跃态生效：工具表可见（inspect_tools 同源）
    assert "list_workspace" in app.tool_registry
    assert any(
        entry["kind"] == "tool" and entry["status"] == "applied"
        for entry in await app.self_pipeline.audit_log()
    )


async def test_l1_patch_reject_leaves_chain_untouched() -> None:
    # 拒绝决议：卡在回合内被拒 → 不落链，工具表不变
    app = await _assembled_app()
    engine = _engine(app, PatchLLM(PATCH_TOOL_CHUNKS))
    transport = CollectorTransport()
    await engine.ainvoke(
        {"input": "注册工具", "thread_id": "t-rej"},
        thread_id="t-rej",
        round_id="r-rej",
        transports=[transport],
    )
    interrupt = await engine.get_latest_interrupt("t-rej")
    assert interrupt is not None
    latest = await app.storage.get_latest_checkpoint("t-rej")
    assert latest is not None and latest.interrupt is not None
    transport2 = CollectorTransport()
    await engine.ainvoke(
        {},
        thread_id="t-rej",
        round_id="r-rej-resume",
        resume_from=latest.checkpoint_id,
        inject={interrupt.key: {"decision": "reject", "reason": "暂不需要"}},
        transports=[transport2],
    )
    state = await app.self_pipeline.chain.assemble()
    assert "list_workspace" not in (state.get("tools") or {})
    assert "list_workspace" not in app.tool_registry
    assert any(
        entry["kind"] == "tool" and entry["status"] == "rejected"
        for entry in await app.self_pipeline.audit_log()
    )
