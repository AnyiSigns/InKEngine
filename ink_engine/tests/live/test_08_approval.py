"""族 8：审批（test_08_approval.py）｜approval/interrupt/review_card。

- 单动作/合并卡；超时 reject(expired)；非法注入 reject(invalid)；
  edit 重新过校验
- 决议全集回流（accept/edit/reject/terminate/auto）；InterruptPolicy
  自定义（直过名单/窗口）
- review_card：四类卡（gate/body/audit/candidate）数据模型 + 门控分级
  注册表（gating_tier_of 优先级：用户覆盖 > 注册表 > L2 默认）

确定性机制用例（零模型调用）+ 1 条真实 LLM 用例（族门禁②）。
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.approval import (  # noqa: E402
    DECISION_ACCEPT,
    DECISION_AUTO,
    DECISION_EDIT,
    DECISION_REJECT,
    DECISION_TERMINATE,
    DefaultInterruptPolicy,
    approve_batch,
    approve_before_execute,
)
from ink_engine.core.review_card import (  # noqa: E402
    GatingTier,
    build_audit_card,
    build_body_card,
    build_candidate_card,
    gating_tier_of,
    validate_card,
)


class FakeCtx:
    """interrupt 原语替身（挂起/注入决议语义直控）。"""

    def __init__(self, injected: dict | None = None, clock=None):
        self._injected = injected or {}
        self._calls: list[tuple[str, dict]] = []
        self._clock = clock

    async def interrupt(self, key: str, payload: dict):
        self._calls.append((key, payload))
        return self._injected.get(key)

    async def get_interrupt_payload(self, key: str):
        return None


async def test_single_action_accept_and_reject():
    ctx = FakeCtx(injected={"write": "accept"})
    decision = await approve_before_execute(ctx, "write", {"tool": "file_ops", "args": {"path": "/tmp/x"}})
    assert decision.decision == DECISION_ACCEPT
    assert decision.action["tool"] == "file_ops"
    assert ctx._calls[0][0] == "write"
    card = ctx._calls[0][1]
    assert card["review_type"] == "gate"  # gate 卡形态

    ctx2 = FakeCtx(injected={"write": "reject"})
    decision2 = await approve_before_execute(ctx2, "write", {"tool": "file_ops"})
    assert decision2.decision == DECISION_REJECT


async def test_decision_matrix_full():
    for injected, expected in [
        ("accept", DECISION_ACCEPT),
        ("reject", DECISION_REJECT),
        ("terminate", DECISION_TERMINATE),
    ]:
        ctx = FakeCtx(injected={"k": injected})
        decision = await approve_before_execute(ctx, "k", {"tool": "t"})
        assert decision.decision == expected, f"{injected} → {expected}"
    # dict 形态同口径（auto 属策略直过来源，外部注入不得伪装直过）
    ctx_auto = FakeCtx(injected={"k": {"decision": "auto"}})
    decision_auto = await approve_before_execute(ctx_auto, "k", {"tool": "t"})
    assert decision_auto.decision == DECISION_REJECT  # 外部注入 auto → 拒绝（fail-closed）


async def test_edit_reapplies_validation():
    """edit 决议携带 edited_content（编辑后内容重新过校验路径）。"""
    ctx = FakeCtx(injected={"k": {"decision": "edit", "edited_content": "修正后的内容"}})
    decision = await approve_before_execute(ctx, "k", {"tool": "write", "args": {}})
    assert decision.decision == DECISION_EDIT
    assert decision.edited_content == "修正后的内容"


async def test_timeout_rejects_expired():
    """超时窗口：重入读回 expires_at，过期补批 → reject(expired)。"""

    now = [1000.0]
    ctx = FakeCtx(injected={"k": "accept"}, clock=lambda: now[0])
    policy = DefaultInterruptPolicy(timeout=10.0)
    decision = await approve_before_execute(ctx, "k", {"tool": "t"}, policy=policy, clock=lambda: now[0])
    assert decision.decision == DECISION_ACCEPT  # 窗口内有效
    # 过期后补批：需读回挂起卡 expires_at（挂起时写入）→ 过期 → reject
    saved_card = {"expires_at": now[0] + 10.0}

    class SavedCtx(FakeCtx):
        async def get_interrupt_payload(self, key):
            return saved_card

    expired_ctx = SavedCtx(injected={"k": "accept"})
    now[0] = 2000.0  # 时钟越过窗口
    decision2 = await approve_before_execute(
        expired_ctx, "k", {"tool": "t"}, policy=policy, clock=lambda: now[0]
    )
    assert decision2.decision == DECISION_REJECT  # 超时补批拒绝（fail-closed）
    assert decision2.source == "expired"


async def test_invalid_injection_rejected():
    """非法注入（非决议形态）→ reject（source=invalid，fail-closed）。"""
    ctx = FakeCtx(injected={"k": {"bogus": True}})
    decision = await approve_before_execute(ctx, "k", {"tool": "t"})
    assert decision.decision == DECISION_REJECT
    assert decision.source == "invalid"


async def test_policy_auto_approve_whitelist():
    """InterruptPolicy 自定义：直过名单（key/工具）不挂卡。"""
    policy = DefaultInterruptPolicy(
        auto_approve_keys=frozenset({"harmless"}),
        auto_approve_tools=frozenset({"read_only"}),
    )
    ctx = FakeCtx(injected={})
    decision = await approve_before_execute(ctx, "harmless", {"tool": "any"}, policy=policy)
    assert decision.decision == DECISION_AUTO and decision.source == "policy"
    assert not ctx._calls  # 未挂卡
    decision2 = await approve_before_execute(ctx, "other", {"tool": "read_only"}, policy=policy)
    assert decision2.decision == DECISION_AUTO
    # 名单外 → 挂卡
    decision3 = await approve_before_execute(ctx, "other", {"tool": "write"}, policy=policy)
    assert decision3.decision == DECISION_REJECT  # 无注入 → reject（占位语义）
    assert ctx._calls  # 已挂卡


async def test_approve_batch_merged_card():
    """合并卡：同回合多写聚合一张卡（一次挂起，决议作用于全部动作）。"""
    ctx = FakeCtx(injected={"batch": "accept"})
    actions = [{"tool": "a", "args": {}}, {"tool": "b", "args": {}}]
    decisions = await approve_batch(ctx, "batch", actions)
    assert len(ctx._calls) == 1  # 单次挂起
    assert ctx._calls[0][1]["review_type"] == "gate"
    assert all(d.decision == DECISION_ACCEPT for d in decisions)


# ----------------------------------------------------------------------
# review_card 数据模型 + 门控分级
# ----------------------------------------------------------------------

def test_review_card_four_types():
    gate = build_body_card(
        target_id=1, index=1, total=2, content="正文内容", node_label="正文卡", node_id="n1"
    )
    assert gate["review_type"] == "body"
    assert validate_card(gate)["review_type"] == "body"
    audit = build_audit_card(
        node_id="n1", node_label="质量卡", workflow_id="wf-1",
        output="输出内容", reason="质量不达标", target_id=1,
    )
    assert audit["review_type"] == "audit"
    candidate = build_candidate_card(
        target_id=1, workflow_id="wf-1", candidates=[{"node_id": "n1", "output": "o1"}], node_id="n1"
    )
    assert candidate["review_type"] == "candidate"
    # 非法卡拒绝（缺必填字段）
    with pytest.raises(ValueError):
        validate_card({"review_type": "gate"})


def test_gating_tier_priority():
    """门控分级：用户覆盖 > 注册表 > L2 默认。"""
    registry = {"safe_write": "l1", "danger_delete": "l3"}
    assert gating_tier_of("safe_write", registry=registry) == GatingTier.L1
    assert gating_tier_of("danger_delete", registry=registry) == GatingTier.L3
    assert gating_tier_of("unknown_write", registry=registry) == GatingTier.L2  # 默认保守弹卡
    # 用户覆盖优先（白名单校验；非法值忽略回退）
    overrides = {"danger_delete": "l1"}
    assert gating_tier_of("danger_delete", overrides=overrides, registry=registry) == GatingTier.L1
    bad = {"unknown_write": "l9"}
    assert gating_tier_of("unknown_write", overrides=bad, registry=registry) == GatingTier.L2


# ----------------------------------------------------------------------
# 真实 LLM 回合 + 审批挂卡 → 决议 → 重入收口（族门禁②）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_round_approval_gate_and_resume(live_llm, memory_storage):
    """真实 LLM 回合 + 审批挂卡（interrupt）→ 决议 accept → 重入收口。"""
    from ink_engine.core.events import CollectorTransport
    from ink_engine.core.executor import Engine, RunOptions
    from ink_engine.core.graph import Graph, TerminateReason
    from ink_engine.core.llm.messages import user

    async def llm_node(ctx):
        result = await live_llm.ainvoke([user("用一句话回答：审批链路验证")])
        return {"answer": result.content}

    async def gate(ctx):
        await ctx.interrupt("real_approve", {"tool": "write", "args": {}})
        return {}

    g = Graph(name="real_approval", entry="llm")
    g.add_node("llm", llm_node)
    g.add_node("gate", gate)
    g.add_edge("llm", "gate")
    g.add_exit("gate")
    engine1 = Engine(g, options=RunOptions(storage=memory_storage, transports=[CollectorTransport()]))
    first = await engine1.ainvoke({}, thread_id="real-approval")
    assert first.interrupt is not None and first.interrupt.key == "real_approve"
    assert first.state["answer"].strip()  # 真实回合先产出再挂卡
    engine2 = Engine(g, options=RunOptions(storage=memory_storage, transports=[CollectorTransport()]))
    resumed = await engine2.ainvoke(
        {}, thread_id="real-approval", resume_from=first.checkpoint_id,
        inject={"real_approve": "accept"},
    )
    assert resumed.reason == TerminateReason.REPLY
    assert resumed.state["answer"].strip()
