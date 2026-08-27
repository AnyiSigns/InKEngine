"""自指应用管线单测：集补丁链 + 分级审批落链 + 回退 + 旁路写防护。

覆盖：链版本/组装/回退边界、L0 直过/L1 挂卡/L2 沙箱验证、编辑
决议重新校验、并发冲突拒绝、非法提案拒绝、审计 append-only、
回退审批与链尾限制、GuardedStorage 拦截与机制豁免。
"""
from __future__ import annotations

import pytest

from ink_engine.core.approval import (
    DECISION_ACCEPT,
    DECISION_AUTO,
    DECISION_REJECT,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.patch_chain import Patch, PatchOp
from ink_engine.core.self_application import (
    AUDIT_STATUS_APPLIED,
    AUDIT_STATUS_CONFLICT,
    AUDIT_STATUS_INVALID,
    AUDIT_STATUS_REJECTED,
    AUDIT_STATUS_REVERTED,
    ApprovalLevel,
    GuardedStorage,
    SelfApplicationPipeline,
    SetPatchChain,
)
from ink_engine.core.self_proposal import PatchKind, ProposalValidator, SelfProposal
from ink_engine.core.storage import create_storage


class FakeCtx:
    """挂卡审批的假节点上下文：预设注入值，未预设 = 显式报错。"""

    def __init__(self) -> None:
        self.injects: dict[str, object] = {}
        self.cards: list[dict] = []

    async def interrupt(self, key: str, payload: dict):
        self.cards.append({"key": key, "payload": payload})
        if key not in self.injects:
            raise AssertionError(f"未预设注入值: {key}")
        return self.injects.pop(key)

    async def get_interrupt_payload(self, key: str):
        return None

    def preset(self, key: str, value: object) -> None:
        self.injects[key] = value


@pytest.fixture
def pipeline() -> SelfApplicationPipeline:
    return SelfApplicationPipeline(
        create_storage("memory://"),
        validator=ProposalValidator(
            allowed_components=("column",),
            allowed_channels=("state",),
            allowed_theme_tokens=("bg",),
        ),
    )


def _theme_proposal(base_version: int = 1) -> SelfProposal:
    return SelfProposal(
        kind=PatchKind.THEME,
        payload={"tokens": {"bg": "#111"}},
        base_version=base_version,
        rationale="换主题",
    )


async def test_chain_version_and_assemble() -> None:
    chain = SetPatchChain(create_storage("memory://"))
    assert await chain.current_version() == 1
    assert await chain.assemble() == {}
    await chain.append(Patch(op=PatchOp.REPLACE, path=("theme",), value={"bg": "#000"}))
    assert await chain.current_version() == 2
    state = await chain.assemble()
    assert state["theme"] == {"bg": "#000"}
    # 版本化取用：版本 1 = 空基线（组装不丢历史）
    assert await chain.assemble(version=1) == {}
    with pytest.raises(GraphDefinitionError, match="越界"):
        await chain.assemble(version=99)


async def test_chain_revert_limits() -> None:
    chain = SetPatchChain(create_storage("memory://"))
    await chain.append(Patch(op=PatchOp.REPLACE, path=("theme",), value={"bg": "#000"}))
    await chain.append(Patch(op=PatchOp.REPLACE, path=("theme",), value={"bg": "#111"}))
    assert await chain.current_version() == 3
    with pytest.raises(GraphDefinitionError, match="回退目标须低于当前版本"):
        await chain.revert_to(3)
    state = await chain.revert_to(2)
    assert state["theme"] == {"bg": "#000"}
    # 回退后新链从目标形态起步（版本回到 1，历史在审计中保留）
    assert await chain.current_version() == 1
    assert await chain.assemble() == {"theme": {"bg": "#000"}}


async def test_chain_append_optimistic_version_check() -> None:
    """ENG1-8：append 乐观版本校验（CAS）——基准版本过期 = 并发冲突拒绝。

    旧实现 append 是读改写非原子：复验到写入间存在 await 窗口，并发两
    提案可互相覆盖；expected_version 把窗口内的版本前进显式化为冲突。
    """
    chain = SetPatchChain(create_storage("memory://"))
    patch = Patch(op=PatchOp.REPLACE, path=("theme",), value={"bg": "#000"})
    with pytest.raises(GraphDefinitionError, match="并发冲突"):
        await chain.append(patch, expected_version=5)  # 当前 1 ≠ 5
    assert await chain.current_version() == 1  # 未落链
    assert await chain.append(patch, expected_version=1) == 2  # 版本匹配
    # 落链后过期基准再试 = 冲突
    with pytest.raises(GraphDefinitionError, match="并发冲突"):
        await chain.append(patch, expected_version=1)
    # 不传 expected_version = 向后兼容（无校验）
    assert await chain.append(patch) == 3


async def test_chain_revert_optimistic_version_check() -> None:
    """ENG1-8：revert_to 乐观版本校验（CAS）——审批挂起窗口后链前进 =
    冲突拒绝，不误回退新补丁。"""
    chain = SetPatchChain(create_storage("memory://"))
    patch = Patch(op=PatchOp.REPLACE, path=("theme",), value={"bg": "#000"})
    await chain.append(patch)
    await chain.append(patch)
    assert await chain.current_version() == 3
    # 调用方基准过期（2，实际 3）：回退冲突拒绝，不误回退新补丁
    with pytest.raises(GraphDefinitionError, match="回退冲突"):
        await chain.revert_to(1, expected_version=2)
    # 正确基准（当前 3，回退目标 2）通过
    state = await chain.revert_to(2, expected_version=3)
    assert state["theme"] == {"bg": "#000"}


async def test_guard_token_with_plain_storage_no_type_error() -> None:
    """ENG1-7：守卫令牌 + 非 GuardedStorage 后端不 TypeError。

    旧实现非空令牌即透传 guard_token kwarg——Storage 协议未声明该形参，
    普通后端（memory 等）直接 TypeError；令牌只对 GuardedStorage 包装
    层有意义，其余后端不传令牌同样安全。
    """
    chain = SetPatchChain(
        create_storage("memory://"), guard_token="tok-1"
    )
    patch = Patch(op=PatchOp.REPLACE, path=("theme",), value={"bg": "#000"})
    version = await chain.append(patch)  # 不抛 TypeError
    assert version == 2
    assert await chain.assemble() == {"theme": {"bg": "#000"}}
    # 管线审计写入同样不炸（内存后端 + 令牌）
    sa = SelfApplicationPipeline(
        create_storage("memory://"),
        guard_token="tok-2",
        validator=ProposalValidator(
            allowed_components=("column",),
            allowed_channels=("state",),
            allowed_theme_tokens=("bg",),
        ),
    )
    outcome = await sa.apply(FakeCtx(), _theme_proposal())
    assert outcome.applied is True
    # GuardedStorage 包装层仍正确消费令牌（令牌透传路径保留）
    raw = create_storage("memory://")
    guarded = GuardedStorage(raw, guard_token="tok-3")
    pipeline = SelfApplicationPipeline(
        guarded,
        guard_token="tok-3",
        validator=ProposalValidator(
            allowed_components=("column",),
            allowed_channels=("state",),
            allowed_theme_tokens=("bg",),
        ),
    )
    out = await pipeline.apply(FakeCtx(), _theme_proposal())
    assert out.applied is True
    assert await guarded.get_record("set_patch_chain", "chain") is not None


async def test_apply_l0_auto_approve(pipeline) -> None:
    ctx = FakeCtx()
    outcome = await pipeline.apply(ctx, _theme_proposal())
    assert outcome.applied is True
    assert outcome.decision == DECISION_AUTO
    assert outcome.patch_id == 2
    assert not ctx.cards  # L0 直过：未挂卡
    state = await pipeline.chain.assemble()
    assert state["theme"] == {"bg": "#111"}


async def test_apply_l1_gate_card(pipeline) -> None:
    ctx = FakeCtx()
    proposal = SelfProposal(
        kind=PatchKind.TOOL,
        payload={
            "name": "listfiles",
            "description": "列出文件",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
        base_version=1,
        rationale="注册文件工具",
    )
    ctx.preset("patch:tool", {"decision": "accept"})
    outcome = await pipeline.apply(ctx, proposal)
    assert outcome.applied is True
    assert outcome.decision == DECISION_ACCEPT
    assert len(ctx.cards) == 1
    card = ctx.cards[0]["payload"]
    assert card["review_type"] == "gate"
    assert card["patch"]["kind"] == "tool"
    state = await pipeline.chain.assemble()
    assert state["tools"]["listfiles"]["name"] == "listfiles"


async def test_apply_reject_decision(pipeline) -> None:
    ctx = FakeCtx()
    ctx.preset("patch:tool", {"decision": "reject", "reason": "权限过大"})
    proposal = SelfProposal(
        kind=PatchKind.TOOL,
        payload={
            "name": "t",
            "description": "x",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
        base_version=1,
    )
    outcome = await pipeline.apply(ctx, proposal)
    assert outcome.applied is False
    assert outcome.decision == DECISION_REJECT
    assert outcome.status == AUDIT_STATUS_REJECTED
    assert await pipeline.chain.current_version() == 1  # 未落链


async def test_apply_edit_revalidates(pipeline) -> None:
    ctx = FakeCtx()
    # 编辑决议：把合法提案替换为另一合法工具（重新过校验）→ 落链新内容
    ctx.preset("patch:tool", {"decision": "edit", "edited_content": {
        "name": "fixedtool",
        "description": "x",
        "permissions": ["filesystem:read:/workspace"],
        "endpoint": "file_ops",
        "endpoint_config": {"root": "/workspace"},
    }})
    proposal = SelfProposal(
        kind=PatchKind.TOOL,
        payload={
            "name": "origtool",
            "description": "x",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
        base_version=1,
    )
    outcome = await pipeline.apply(ctx, proposal)
    assert outcome.applied is True
    state = await pipeline.chain.assemble()
    assert "fixedtool" in state["tools"]
    assert "origtool" not in state["tools"]


async def test_apply_edit_invalid_never_applies(pipeline) -> None:
    ctx = FakeCtx()
    # 编辑为非法内容（权限缺失）→ 重新校验失败，拒绝落链
    ctx.preset("patch:tool", {"decision": "edit", "edited_content": {"name": "bad"}})
    proposal = SelfProposal(
        kind=PatchKind.TOOL,
        payload={
            "name": "origtool",
            "description": "x",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
        base_version=1,
    )
    outcome = await pipeline.apply(ctx, proposal)
    assert outcome.applied is False
    assert "重新校验未通过" in (outcome.reason or "")
    assert await pipeline.chain.current_version() == 1


async def test_apply_conflict_rejects(pipeline) -> None:
    ctx = FakeCtx()
    # 基于版本 1 提案，但链已推进到版本 2（他人已应用）→ 冲突拒绝
    await pipeline.apply(ctx, _theme_proposal())
    stale = _theme_proposal(base_version=1)
    stale = SelfProposal(
        kind=PatchKind.THEME,
        payload={"tokens": {"bg": "#222"}},
        base_version=1,
    )
    outcome = await pipeline.apply(ctx, stale)
    assert outcome.status == AUDIT_STATUS_CONFLICT
    assert "并发冲突" in (outcome.reason or "")
    assert await pipeline.chain.current_version() == 2


async def test_apply_invalid_payload_rejected(pipeline) -> None:
    ctx = FakeCtx()
    outcome = await pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.THEME,
            payload={"tokens": {"evil": "#000"}},
            base_version=1,
        ),
    )
    assert outcome.status == AUDIT_STATUS_INVALID
    assert await pipeline.chain.current_version() == 1


async def test_apply_l2_vetting_gate(pipeline) -> None:
    vetoed = SelfApplicationPipeline(
        create_storage("memory://"),
        validator=ProposalValidator(),
        approval_levels={
            PatchKind.ARTIFACT: ApprovalLevel.L2,
        },
        l2_vetting=lambda proposal: ["产物包含可疑符号"],
    )
    ctx = FakeCtx()
    outcome = await vetoed.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.ARTIFACT,
            payload={
                "artifact_id": "a-1",
                "kind": "js_bundle",
                "hashes": {"index.js": "a" * 64},
            },
            base_version=1,
        ),
    )
    assert outcome.applied is False
    assert "L2 沙箱验证未通过" in (outcome.reason or "")
    assert not ctx.cards


async def test_apply_target_hook(pipeline) -> None:
    applied: list[tuple[dict, int]] = []

    class Target:
        name = "theme"

        async def apply(self, payload, patch_id):
            applied.append((payload, patch_id))

    pipeline.register_target(PatchKind.THEME, Target())
    ctx = FakeCtx()
    outcome = await pipeline.apply(ctx, _theme_proposal())
    assert outcome.applied is True
    assert applied == [({"tokens": {"bg": "#111"}}, 2)]


async def test_revert_requires_approval_and_chain_tail(pipeline) -> None:
    ctx = FakeCtx()
    await pipeline.apply(ctx, _theme_proposal())
    await pipeline.apply(ctx, _theme_proposal(base_version=2))
    # 回退非链尾补丁（#2，其上还有 #3）→ 拒绝（保持链完整性）
    with pytest.raises(GraphDefinitionError, match="仅允许回退链尾补丁"):
        await pipeline.revert(ctx, 2)
    # 回退链尾 #3：审批后落地
    ctx.preset("revert:3", {"decision": "accept"})
    outcome = await pipeline.revert(ctx, 3, reason="换回旧主题")
    assert outcome.status == AUDIT_STATUS_REVERTED
    state = await pipeline.chain.assemble()
    assert state["theme"] == {"bg": "#111"}
    # 审计保留回退记录（历史不撒谎）
    log = await pipeline.audit_log()
    assert any(entry["status"] == AUDIT_STATUS_REVERTED for entry in log)


async def test_revert_then_repeat_revert_rejected(pipeline) -> None:
    # 回退幂等：回退后链版本复位（1），对已回退的补丁再次回退 = 越界
    # 拒绝（同目标不会重复回退，链保持有序）
    ctx = FakeCtx()
    await pipeline.apply(ctx, _theme_proposal())
    ctx.preset("revert:2", {"decision": "accept"})
    outcome = await pipeline.revert(ctx, 2, reason="换回")
    assert outcome.status == AUDIT_STATUS_REVERTED
    assert await pipeline.chain.current_version() == 1
    with pytest.raises(GraphDefinitionError, match="仅允许回退链尾补丁"):
        await pipeline.revert(ctx, 2, reason="再次回退")


async def test_audit_is_append_only(pipeline) -> None:
    ctx = FakeCtx()
    await pipeline.apply(ctx, _theme_proposal())
    # 第二条走 L1 挂卡并拒绝（theme 是 L0 直过，用 tool 补丁验证拒绝留痕）
    ctx.preset("patch:tool", {"decision": "reject", "reason": "不注册"})
    outcome = await pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.TOOL,
            payload={
                "name": "t",
                "description": "x",
                "permissions": ["filesystem:read:/workspace"],
                "endpoint": "file_ops",
                "endpoint_config": {"root": "/workspace"},
            },
            base_version=2,
        ),
    )
    assert outcome.status == AUDIT_STATUS_REJECTED
    log = await pipeline.audit_log()
    statuses = [entry["status"] for entry in log]
    assert statuses == [AUDIT_STATUS_APPLIED, AUDIT_STATUS_REJECTED]
    assert all(entry["payload"] is not None for entry in log)


async def test_guarded_storage_blocks_direct_write() -> None:
    inner = create_storage("memory://")
    guarded = GuardedStorage(inner)
    with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
        await guarded.put_record("ui", "boot.panel", {"spec": {}})
    # 机制通道不受限
    await guarded.put_record("ui_context", "latest", {"active_view": "panel"})
    assert await guarded.get_record("ui_context", "latest") == {
        "active_view": "panel"
    }


async def test_guarded_storage_mechanism_allowance() -> None:
    guarded = GuardedStorage(create_storage("memory://"))
    # 无豁免 = 拦截
    with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
        await guarded.put_record("event_types", "thinking_start", {"name": "x"})
    # 显式豁免上下文内放行，退出后恢复拦截
    with guarded.allow_mechanism("event_types"):
        await guarded.put_record("event_types", "thinking_start", {"name": "x"})
    with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
        await guarded.put_record("event_types", "tool_start", {"name": "y"})
    assert await guarded.get_record("event_types", "thinking_start") == {
        "name": "x"
    }


async def test_guarded_storage_passthrough() -> None:
    inner = create_storage("memory://")
    guarded = GuardedStorage(inner)
    # 其余 Storage 方法（checkpoint/事件日志）透传
    from ink_engine.core.events import EngineEvent

    seq = await guarded.append_event("t1", EngineEvent(type="reply", payload={}))
    assert seq == 1
    events = await guarded.events_after("t1", 0)
    assert len(events) == 1
    assert await guarded.latest_event_seq("t1") == 1


async def test_guarded_storage_covers_harness_and_knowledge_prefix() -> None:
    # 旁路写防护覆盖 harness 与 knowledge 前缀集合（知识/规则条目
    # 落 knowledge:<user> 动态集合，规则以 kind=rule 条目同受守卫）
    guarded = GuardedStorage(create_storage("memory://"))
    with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
        await guarded.put_record("harness", "forge", {"name": "forge"})
    with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
        await guarded.put_record("knowledge:default", "chain", {"base": {}})
    # 前缀豁免放行（启动装配/应用管线延伸路径）
    with guarded.allow_mechanism("harness"):
        await guarded.put_record("harness", "forge", {"name": "forge"})
    with guarded.allow_mechanism():
        await guarded.put_record("knowledge:default", "chain", {"base": {}})
    # 退出豁免后恢复拦截
    with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
        await guarded.put_record("harness", "other", {"name": "other"})


async def test_guarded_storage_covers_all_knowledge_user_collections() -> None:
    """ENG1-20：知识集权威集合命名核对——knowledge:<user_id> 动态集合
    全部受守卫（无精确名 "knowledge" 集合，前缀即完整覆盖）。

    知识集持久化 = knowledge_collection(user_id)（knowledge_set.py 前缀
    "knowledge:"），任意用户 id 的集合直写一律拦截（不含精确名集合的
    缺口）。
    """
    guarded = GuardedStorage(create_storage("memory://"))
    for user_id in ("default", "u-1", "u-42"):
        with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
            await guarded.put_record(
                f"knowledge:{user_id}", "chain", {"base": {}}
            )
    # 近前缀（非知识集）集合不受误伤
    await guarded.put_record("knowledge_frag", "k", {"v": 1})
    assert await guarded.get_record("knowledge_frag", "k") == {"v": 1}


async def test_revert_to_enforces_tail_only_at_storage_layer() -> None:
    # 链完整性在存储层强制：跳过链尾回退（一次回退多步）被拒绝
    chain = SetPatchChain(create_storage("memory://"))
    await chain.append(Patch(op=PatchOp.REPLACE, path=("theme",), value={"bg": "#000"}))
    await chain.append(Patch(op=PatchOp.REPLACE, path=("theme",), value={"bg": "#111"}))
    await chain.append(Patch(op=PatchOp.REPLACE, path=("theme",), value={"bg": "#222"}))
    assert await chain.current_version() == 4
    with pytest.raises(GraphDefinitionError, match="仅允许回退链尾补丁"):
        await chain.revert_to(2)
    # 链尾单步回退仍可用（版本 4 → 3）
    state = await chain.revert_to(3)
    assert state["theme"] == {"bg": "#111"}


async def test_apply_l2_without_vetting_hook_fails_closed() -> None:
    # L2 类型未装配沙箱验证钩子 = 显式拒绝（不静默降级为 L1）
    pipeline = SelfApplicationPipeline(
        create_storage("memory://"),
        validator=ProposalValidator(),
        approval_levels={
            PatchKind.ARTIFACT: ApprovalLevel.L2,
        },
    )
    ctx = FakeCtx()
    outcome = await pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.ARTIFACT,
            payload={
                "artifact_id": "a-1",
                "kind": "js_bundle",
                "hashes": {"index.js": "a" * 64},
            },
            base_version=1,
        ),
    )
    assert outcome.applied is False
    assert "沙箱验证未装配" in (outcome.reason or "")
    assert not ctx.cards  # 未挂卡（闸门口拒绝）
    assert await pipeline.chain.current_version() == 1


async def test_approval_timeout_expired_rejects(pipeline) -> None:
    # 审批挂起窗口：卡已过期（expires_at 早于当前）→ 重入一律拒绝
    # （fail-closed：超时后补批被拦截并留痕）
    class ExpiredCtx(FakeCtx):
        async def get_interrupt_payload(self, key):
            return {"expires_at": 1.0}  # 早已过期

    ctx = ExpiredCtx()
    ctx.preset("patch:tool", {"decision": "accept"})

    proposal = SelfProposal(
        kind=PatchKind.TOOL,
        payload={
            "name": "t",
            "description": "x",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
        base_version=1,
    )
    outcome = await pipeline.apply(ctx, proposal)
    assert outcome.applied is False
    assert outcome.decision == DECISION_REJECT
    assert "超时" in (outcome.reason or "")
    assert await pipeline.chain.current_version() == 1
