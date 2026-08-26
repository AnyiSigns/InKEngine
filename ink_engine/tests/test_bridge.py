"""接线桥单测：propose_patch op 走既有审批分级与补丁链（只追加面）。

覆盖（op 断言段）：
- op 登记面：propose_patch 已登记，op 名清单与工具声明对齐；
- L0 直过：theme 补丁（出厂 L0 档）不弹卡、自动落链生效；
- L1 弹卡：人工批准后落链生效，拒绝则留痕不落链；
- L2 沙箱验证：未装配验证钩子 = fail-closed 拒绝；验证通过 + 批准才落链；
- 非法参数 / 未知补丁类型 = invalid 拒绝（不挂卡不落链）。
"""
from __future__ import annotations

from ink_engine.core.approval import DECISION_ACCEPT, DECISION_AUTO, DECISION_REJECT
from ink_engine.core.bridge import OP_DISPATCH, op_names, propose_patch
from ink_engine.core.self_application import (
    ApprovalLevel,
    SelfApplicationPipeline,
)
from ink_engine.core.self_proposal import PatchKind, ProposalValidator
from ink_engine.core.storage import create_storage


class FakeCtx:
    """弹卡假上下文：预设注入值，未预设 = 显式拒绝。"""

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


def _pipeline(*, levels: dict[PatchKind, ApprovalLevel] | None = None,
              l2_vetting=None) -> SelfApplicationPipeline:
    return SelfApplicationPipeline(
        create_storage("memory://"),
        validator=ProposalValidator(
            allowed_components=("column",),
            allowed_channels=("state",),
            allowed_theme_tokens=("bg",),
        ),
        approval_levels=levels,
        l2_vetting=l2_vetting,
    )


def _theme_params(base_version: int = 1) -> dict:
    return {
        "kind": "theme",
        "payload": {"tokens": {"bg": "#111"}},
        "base_version": base_version,
        "rationale": "暗色主题",
    }


def test_op_registered_and_manifested():
    """op 登记面：propose_patch 已登记且清单唯一（与工具声明对齐）。"""
    assert "propose_patch" in OP_DISPATCH
    assert OP_DISPATCH["propose_patch"] is propose_patch
    assert op_names() == ("propose_patch",)


async def test_propose_patch_l0_auto_approve():
    """L0 直过：出厂 theme 档自动批准并落链生效，不弹卡。"""
    pipeline = _pipeline()
    ctx = FakeCtx()
    outcome = await propose_patch(pipeline, _theme_params(), round_id="r1")
    assert outcome["decision"] == DECISION_AUTO
    assert outcome["applied"] is True
    assert outcome["status"] == "applied"
    assert outcome["patch_id"] == 2
    assert not ctx.cards


async def test_propose_patch_l1_card_accept_and_reject():
    """L1 弹卡：批准后落链生效；拒绝则留痕不落链。"""
    pipeline = _pipeline(levels={PatchKind.THEME: ApprovalLevel.L1})
    ctx = FakeCtx()
    # 拒绝
    ctx.preset("patch:theme", {"decision": DECISION_REJECT})
    outcome = await propose_patch(pipeline, _theme_params(), ctx=ctx, round_id="r1")
    assert outcome["decision"] == DECISION_REJECT
    assert outcome["applied"] is False
    assert outcome["patch_id"] is None
    # 批准（重新基于当前版本 1 提案）
    ctx.preset("patch:theme", {"decision": DECISION_ACCEPT})
    outcome = await propose_patch(pipeline, _theme_params(), ctx=ctx, round_id="r2")
    assert outcome["decision"] == DECISION_ACCEPT
    assert outcome["applied"] is True
    assert outcome["patch_id"] == 2
    assert len(ctx.cards) == 2  # 两次弹卡


async def test_propose_patch_l2_vetting_gate():
    """L2 沙箱验证：未装配验证钩子 = fail-closed 拒绝；验证通过才弹卡。"""
    no_vetting = _pipeline(levels={PatchKind.THEME: ApprovalLevel.L2})
    outcome = await propose_patch(no_vetting, _theme_params())
    assert outcome["decision"] == DECISION_REJECT
    assert "沙箱验证未装配" in (outcome["reason"] or "")

    pipeline = _pipeline(
        levels={PatchKind.THEME: ApprovalLevel.L2},
        l2_vetting=lambda proposal: [],
    )
    ctx = FakeCtx()
    ctx.preset("patch:theme", {"decision": DECISION_ACCEPT})
    outcome = await propose_patch(pipeline, _theme_params(), ctx=ctx, round_id="r3")
    assert outcome["decision"] == DECISION_ACCEPT
    assert outcome["applied"] is True
    assert outcome["patch_id"] == 2


async def test_propose_patch_invalid_params_rejected():
    """非法参数 / 未知补丁类型 = invalid 拒绝（不挂卡不落链）。"""
    pipeline = _pipeline()
    bad_kind = await propose_patch(pipeline, {"kind": "nope", "payload": {}})
    assert bad_kind["status"] == "invalid"
    assert bad_kind["patch_id"] is None
    missing = await propose_patch(pipeline, {"kind": "theme"})
    assert missing["status"] == "invalid"
    # 合法形态但按类型校验失败 = invalid（如 theme token 不在白名单）
    off_whitelist = await propose_patch(
        pipeline, {"kind": "theme", "payload": {"tokens": {"ghost": "#000"}}}
    )
    assert off_whitelist["status"] == "invalid"
