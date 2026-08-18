"""approve_before_execute / approve_batch 标准挂卡审批测试。

覆盖：全决议分支（accept/edit/reject/terminate/auto）、批处理合并卡、
策略钩子替换、超时默认拒绝、非法注入 fail-closed、gate 卡形态、
取消语义（打断重定向下挂起卡保留，引擎级挂起/重入）。
"""
from __future__ import annotations

from contextlib import suppress

from conftest import make_engine

from ink_engine.core.approval import (
    DECISION_ACCEPT,
    DECISION_AUTO,
    DECISION_EDIT,
    DECISION_REJECT,
    DECISION_TERMINATE,
    DefaultInterruptPolicy,
    approve_batch,
    approve_before_execute,
)
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.interrupt import InterruptSignal

ACTION_WRITE = {"tool": "write_file", "args": {"path": "a.md"}, "summary": "写入 a.md"}


class _FakeCtx:
    """鸭子类型节点上下文：无注入值挂起（抛 InterruptSignal），有则消费返回。

    on_interrupt 在挂起后调用（模拟"用户晚批"的时间流逝）。
    """

    def __init__(self, inject: dict | None = None, on_interrupt=None):
        self._inject = dict(inject or {})
        self._on_interrupt = on_interrupt
        self.hung: tuple[str, dict] | None = None

    async def interrupt(self, review_key: str, payload: dict):
        self.hung = (review_key, payload)
        if self._on_interrupt is not None:
            self._on_interrupt()
        if review_key in self._inject:
            return self._inject.pop(review_key)
        raise InterruptSignal(review_key, payload)


class _FakeClock:
    def __init__(self, start: float = 1000.0):
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


# ── 全决议分支（单动作）──


async def test_accept_inject_dict():
    ctx = _FakeCtx(inject={"gate": {"decision": DECISION_ACCEPT}})
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE)
    assert decision.decision == DECISION_ACCEPT
    assert decision.source == "inject"
    assert decision.action == ACTION_WRITE
    assert decision.edited_content is None


async def test_edit_passthrough_content():
    ctx = _FakeCtx(
        inject={"gate": {"decision": DECISION_EDIT, "edited_content": "替换后的正文"}}
    )
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE)
    assert decision.decision == DECISION_EDIT
    assert decision.edited_content == "替换后的正文"


async def test_reject_str_shorthand():
    ctx = _FakeCtx(inject={"gate": DECISION_REJECT})
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE)
    assert decision.decision == DECISION_REJECT
    assert decision.reason is None


async def test_terminate_with_reason():
    ctx = _FakeCtx(inject={"gate": {"decision": DECISION_TERMINATE, "reason": "用户取消"}})
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE)
    assert decision.decision == DECISION_TERMINATE
    assert decision.reason == "用户取消"


async def test_auto_when_policy_skips_key():
    policy = DefaultInterruptPolicy(auto_approve_keys=frozenset({"gate"}))
    ctx = _FakeCtx()  # 无注入：若误挂起会抛 InterruptSignal
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE, policy=policy)
    assert decision.decision == DECISION_AUTO
    assert decision.source == "policy"
    assert ctx.hung is None  # 未挂起


async def test_auto_when_policy_skips_tool():
    policy = DefaultInterruptPolicy(auto_approve_tools=frozenset({"write_file"}))
    ctx = _FakeCtx()
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE, policy=policy)
    assert decision.decision == DECISION_AUTO
    assert ctx.hung is None


async def test_custom_policy_hook_replaced():
    """策略钩子可替换：宿主自定义 should_approve/timeout_for 生效。"""

    class _ReviewOnlyPolicy:
        def should_approve(self, key: str, action: dict) -> bool:
            return action.get("tool") != "read_file"

        def timeout_for(self, key: str, action: dict) -> float | None:
            return None

    ctx = _FakeCtx(inject={"gate": {"decision": DECISION_ACCEPT}})
    read = await approve_before_execute(ctx, "gate", {"tool": "read_file"}, policy=_ReviewOnlyPolicy())
    assert read.decision == DECISION_AUTO
    ctx2 = _FakeCtx(inject={"gate": {"decision": DECISION_ACCEPT}})
    write = await approve_before_execute(ctx2, "gate", ACTION_WRITE, policy=_ReviewOnlyPolicy())
    assert write.decision == DECISION_ACCEPT
    assert ctx2.hung is not None


# ── 超时默认拒绝（fail-closed 兜底）──


async def test_timeout_defaults_reject():
    clock = _FakeClock(start=1000.0)
    policy = DefaultInterruptPolicy(timeout=30.0)
    ctx = _FakeCtx(
        inject={"gate": {"decision": DECISION_ACCEPT}},
        on_interrupt=lambda: clock.advance(31.0),  # 挂起后流逝 31 秒（晚批）
    )
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE, policy=policy, clock=clock)
    assert decision.decision == DECISION_REJECT
    assert decision.source == "expired"
    assert "超时" in (decision.reason or "")


async def test_timeout_within_window_still_applies():
    clock = _FakeClock(start=1000.0)
    policy = DefaultInterruptPolicy(timeout=30.0)
    ctx = _FakeCtx(
        inject={"gate": {"decision": DECISION_ACCEPT}},
        on_interrupt=lambda: clock.advance(29.0),
    )
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE, policy=policy, clock=clock)
    assert decision.decision == DECISION_ACCEPT


async def test_no_timeout_by_default():
    ctx = _FakeCtx(inject={"gate": {"decision": DECISION_ACCEPT}})
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE)
    assert decision.decision == DECISION_ACCEPT
    assert "expires_at" not in ctx.hung[1]  # 默认不限时，不写 expires_at


async def test_timeout_reads_back_hung_card_expires_at():
    """重入场景：超时判定读回挂起卡持久化的 expires_at（不重算窗口）。

    修复前：重入时 expires_at 按 now+timeout 重算，now 恒小于重算值，
    "超时默认拒绝"永不触发——超时后补批照样通过。
    """
    clock = _FakeClock(start=1000.0)
    policy = DefaultInterruptPolicy(timeout=30.0)

    class _PersistentCtx(_FakeCtx):
        def __init__(self, saved_card, on_interrupt=None):
            super().__init__(inject={"gate": {"decision": DECISION_ACCEPT}}, on_interrupt=on_interrupt)
            self._saved = saved_card

        async def get_interrupt_payload(self, review_key):
            return self._saved

    # 首次挂起：expires_at = 1000 + 30 = 1030（随挂起卡持久化）
    first = _FakeCtx()
    with suppress(InterruptSignal):
        await approve_before_execute(first, "gate", ACTION_WRITE, policy=policy, clock=clock)
    saved_card = dict(first.hung[1])
    # 重入：时钟已流逝 31 秒，读回 1030 → 过期默认拒绝（fail-closed 生效）
    ctx = _PersistentCtx(saved_card, on_interrupt=lambda: clock.advance(31.0))
    decision = await approve_before_execute(ctx, "gate", ACTION_WRITE, policy=policy, clock=clock)
    assert decision.decision == DECISION_REJECT
    assert decision.source == "expired"


# ── 非法注入 fail-closed ──


async def test_invalid_inject_fail_closed():
    for bad in (
        {"foo": 1},  # 无 decision
        {"decision": "maybe"},  # 非法决议值
        {"decision": DECISION_AUTO},  # auto 只由策略产生，注入无效
        {"decision": DECISION_EDIT},  # edit 缺 edited_content
        "edit",  # 字符串简写不含 edit
        "auto",  # 字符串 auto 与 dict 分支同口径：不得伪装策略直过
        42,
    ):
        ctx = _FakeCtx(inject={"gate": bad})
        decision = await approve_before_execute(ctx, "gate", ACTION_WRITE)
        assert decision.decision == DECISION_REJECT
        assert decision.source == "invalid", f"注入 {bad!r} 应为 invalid"


# ── gate 卡形态 ──


async def test_gate_card_shape():
    ctx = _FakeCtx()  # 无注入 → 挂起
    with suppress(InterruptSignal):
        await approve_before_execute(ctx, "gate", ACTION_WRITE)
    assert ctx.hung is not None
    key, card = ctx.hung
    assert key == "gate"
    assert card["review_type"] == "gate"
    assert card["node_id"] == "write_file"
    assert card["action"] == ACTION_WRITE
    assert card["output_preview"] == "写入 a.md"


async def test_gate_card_payload_override_and_expires_at():
    clock = _FakeClock(start=1000.0)
    policy = DefaultInterruptPolicy(timeout=60.0)
    payload = {"node_id": "custom_node", "node_label": "自定义卡", "diff": "宿主摘要"}
    ctx = _FakeCtx()
    with suppress(InterruptSignal):
        await approve_before_execute(ctx, "gate", ACTION_WRITE, payload=payload, policy=policy, clock=clock)
    assert ctx.hung is not None
    card = ctx.hung[1]
    assert card["node_id"] == "custom_node"  # 宿主 payload 优先
    assert card["review_type"] == "gate"  # 缺省字段补全
    assert card["expires_at"] == 1060.0


# ── 批处理合并卡（approve_batch）──

_ACTIONS = [
    {"tool": "write_file", "args": {"path": "a.md"}, "summary": "写入 a.md"},
    {"tool": "update_entity", "args": {"name": "林晚"}, "summary": "更新角色"},
    {"tool": "write_file", "args": {"path": "b.md"}, "summary": "写入 b.md"},
]


async def test_batch_accept():
    ctx = _FakeCtx(inject={"batch": {"decision": DECISION_ACCEPT}})
    decisions = await approve_batch(ctx, "batch", _ACTIONS)
    assert len(decisions) == 3
    assert all(d.decision == DECISION_ACCEPT for d in decisions)
    assert [d.action for d in decisions] == _ACTIONS


async def test_batch_edit_contents_aligned():
    ctx = _FakeCtx(
        inject={"batch": {"decision": DECISION_EDIT, "edited_contents": ["a'", "b'", "c'"]}}
    )
    decisions = await approve_batch(ctx, "batch", _ACTIONS)
    assert [d.decision for d in decisions] == [DECISION_EDIT] * 3
    assert [d.edited_content for d in decisions] == ["a'", "b'", "c'"]


async def test_batch_edit_misaligned_fail_closed():
    ctx = _FakeCtx(
        inject={"batch": {"decision": DECISION_EDIT, "edited_contents": ["a'"]}}
    )
    decisions = await approve_batch(ctx, "batch", _ACTIONS)
    assert all(d.decision == DECISION_REJECT for d in decisions)
    assert all(d.source == "invalid" for d in decisions)


async def test_batch_reject_all():
    ctx = _FakeCtx(inject={"batch": {"decision": DECISION_REJECT, "reason": "全部取消"}})
    decisions = await approve_batch(ctx, "batch", _ACTIONS)
    assert all(d.decision == DECISION_REJECT for d in decisions)
    assert decisions[0].reason == "全部取消"


async def test_batch_auto_all_when_policy_skips():
    policy = DefaultInterruptPolicy(auto_approve_tools=frozenset({"write_file", "update_entity"}))
    ctx = _FakeCtx()
    decisions = await approve_batch(ctx, "batch", _ACTIONS, policy=policy)
    assert all(d.decision == DECISION_AUTO for d in decisions)
    assert ctx.hung is None


async def test_batch_gate_card_single_hang():
    ctx = _FakeCtx()
    with suppress(InterruptSignal):
        await approve_batch(ctx, "batch", _ACTIONS)
    assert ctx.hung is not None
    key, card = ctx.hung
    assert key == "batch"  # 单次挂起
    assert card["review_type"] == "gate"
    assert len(card["actions"]) == 3


async def test_batch_timeout_defaults_reject():
    clock = _FakeClock(start=1000.0)
    policy = DefaultInterruptPolicy(timeout=10.0)
    ctx = _FakeCtx(
        inject={"batch": {"decision": DECISION_ACCEPT}},
        on_interrupt=lambda: clock.advance(11.0),
    )
    decisions = await approve_batch(ctx, "batch", _ACTIONS, policy=policy, clock=clock)
    assert all(d.decision == DECISION_REJECT for d in decisions)
    assert all(d.source == "expired" for d in decisions)


# ── 引擎级：挂起 → checkpoint 保留 → 注入重入（取消语义）──


def _approval_graph():
    async def tool_node(ctx):
        decision = await approve_before_execute(ctx, "approve_write", ACTION_WRITE)
        if decision.decision == DECISION_ACCEPT:
            return {"executed": "accepted"}
        if decision.decision == DECISION_EDIT:
            return {"executed": "edited", "content": decision.edited_content}
        if decision.decision == DECISION_TERMINATE:
            ctx.terminate(TerminateReason.CANCELLED)
            return {}
        return {"executed": decision.decision, "source": decision.source}

    g = Graph(name="approval", entry="tool")
    g.add_node("tool", tool_node)
    g.add_exit("tool")
    return g


async def test_engine_hang_then_resume_accept(memory_storage):
    """挂起卡保留（中断 checkpoint 不丢）→ 注入 accept 重入 → 决议生效。"""
    engine = make_engine(_approval_graph(), storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t1")
    assert result.reason == "interrupted"
    assert result.interrupt is not None
    assert result.interrupt.key == "approve_write"
    assert result.interrupt.payload["review_type"] == "gate"
    latest = await memory_storage.get_latest_checkpoint("t1")
    assert latest is not None and latest.reason == "interrupted"  # 卡保留在 checkpoint
    resumed = await engine.ainvoke(
        {},
        thread_id="t1",
        resume_from=result.checkpoint_id,
        inject={"approve_write": {"decision": DECISION_ACCEPT}},
    )
    assert resumed.state["executed"] == "accepted"
    assert resumed.reason == TerminateReason.REPLY


async def test_engine_resume_edit(memory_storage):
    engine = make_engine(_approval_graph(), storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t2")
    resumed = await engine.ainvoke(
        {},
        thread_id="t2",
        resume_from=result.checkpoint_id,
        inject={"approve_write": {"decision": DECISION_EDIT, "edited_content": "改写正文"}},
    )
    assert resumed.state["executed"] == "edited"
    assert resumed.state["content"] == "改写正文"


async def test_engine_resume_terminate(memory_storage):
    engine = make_engine(_approval_graph(), storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t3")
    resumed = await engine.ainvoke(
        {},
        thread_id="t3",
        resume_from=result.checkpoint_id,
        inject={"approve_write": {"decision": DECISION_TERMINATE, "reason": "用户取消"}},
    )
    assert resumed.reason == TerminateReason.CANCELLED
    assert resumed.state.get("executed") is None  # 终止未执行动作


async def test_engine_hang_without_inject_keeps_card(memory_storage):
    """新回合（无注入）再次执行同一线程：卡仍挂起，不静默执行。"""
    engine = make_engine(_approval_graph(), storage=memory_storage)
    result = await engine.ainvoke({}, thread_id="t4")
    assert result.reason == "interrupted"
    again = await engine.ainvoke({}, thread_id="t4", resume_from=result.checkpoint_id)
    # 无注入重入：interrupt 无注入值 → 再次挂起（不执行动作，fail-closed）
    assert again.reason == "interrupted"
    assert again.interrupt is not None and again.interrupt.key == "approve_write"
    assert "executed" not in again.state
