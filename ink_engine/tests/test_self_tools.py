"""契约自指元工具单测：4 契约工具的 ToolSpec/判定/执行行为（内核侧）。

覆盖：契约工具清单与权限声明；操作判定（propose/apply × patch）；
提案校验（形态非法/合法 + 集版本）；L0 直过落链；L1 挂卡 → 决议注入
重入；收敛管制前置闸门（可选钩子拒绝）；回退（仅链尾 + 审批）；领域
生成器（重名拒绝/工具形态预校验/相关经验检索）；未知名显式拒绝。
行为与既有宿主实现逐条等价（宿主侧 test_self_round 为闭环回归线）。
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from ink_engine.core.approval import DECISION_ACCEPT, DECISION_REJECT
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.harness import HarnessRegistry
from ink_engine.core.interrupt import InterruptSignal
from ink_engine.core.knowledge_set import SOURCE_MODEL, KnowledgeEntry, KnowledgeSet
from ink_engine.core.self_application import ApprovalLevel, SelfApplicationPipeline
from ink_engine.core.self_proposal import PatchKind, ProposalValidator
from ink_engine.core.self_tools import (
    PERMISSION_APPLY,
    PERMISSION_PROPOSE,
    SELF_TOOL_CONTRACT,
    SelfToolContext,
    make_self_executor,
    operation_of,
    self_tool_specs,
)


class _StubCtx:
    """工具执行测试用节点上下文桩（interrupt 注入语义与引擎一致）。

    已注入的 key 直接返回值（重入语义）；未注入 = 挂起（抛 InterruptSignal，
    与引擎节点中断同语义），挂起清单留痕供断言。
    """

    def __init__(self, injections: dict | None = None, *, round_id: str = "r-1") -> None:
        self.round_id = round_id
        self.injections = dict(injections or {})
        self.suspended: list[tuple[str, dict]] = []

    async def interrupt(self, key: str, payload: dict) -> Any:
        if key in self.injections:
            return self.injections.pop(key)
        self.suspended.append((key, payload))
        raise InterruptSignal(key, payload)

    async def get_interrupt_payload(self, key: str) -> dict | None:
        return None


def _specs() -> dict[str, Any]:
    return {spec.name: spec for spec in self_tool_specs()}


def _make_tools(storage, *, approval_levels=None, convergence=None):
    """装配最小自指工具执行环境（内存存储 + 分级表 + 可选前置闸门）。"""
    validator = ProposalValidator(
        allowed_components=("column", "message_list", "agent_input"),
        allowed_channels=("state",),
        allowed_theme_tokens=("bg", "fg", "accent"),
    )
    pipeline = SelfApplicationPipeline(
        storage,
        validator=validator,
        approval_levels=approval_levels
        or {PatchKind.THEME: ApprovalLevel.L0, PatchKind.KNOWLEDGE: ApprovalLevel.L0},
    )
    harness_registry = HarnessRegistry()
    knowledge_set = KnowledgeSet("test", storage=storage)
    context = SelfToolContext(
        self_pipeline=pipeline,
        harness_registry=harness_registry,
        knowledge_set=knowledge_set,
        convergence=convergence,
    )
    executor = make_self_executor(pipeline, lambda: context)
    return pipeline, executor, context


def test_contract_tools_exact():
    """契约工具清单 = 4 个演化工具（名称与 seeds/boot 契约同源）。"""
    names = {spec.name for spec in self_tool_specs()}
    assert names == set(SELF_TOOL_CONTRACT)
    assert set(SELF_TOOL_CONTRACT) == {
        "propose_patch",
        "apply_patch",
        "revert_patch",
        "propose_domain_manifest",
    }
    by_name = {spec.name: spec for spec in self_tool_specs()}
    # 权限声明（自定义域：propose/apply）
    assert by_name["propose_patch"].permissions == (PERMISSION_PROPOSE,)
    assert by_name["propose_domain_manifest"].permissions == (PERMISSION_PROPOSE,)
    assert by_name["apply_patch"].permissions == (PERMISSION_APPLY,)
    assert by_name["revert_patch"].permissions == (PERMISSION_APPLY,)


def test_operation_of():
    """操作判定：propose/apply × patch 目标（单一判定来源）。"""
    specs = _specs()
    assert operation_of(specs["propose_patch"]) == ("propose", "patch")
    assert operation_of(specs["propose_domain_manifest"]) == ("propose", "patch")
    assert operation_of(specs["apply_patch"]) == ("apply", "patch")
    assert operation_of(specs["revert_patch"]) == ("apply", "patch")


async def test_propose_validates_shape(memory_storage):
    """提案校验：非法类型显式报错（结构化拒绝，不击穿执行）。"""
    _pipeline, executor, _ctx = _make_tools(memory_storage)
    specs = _specs()
    # 非法类型
    result = await executor(
        _StubCtx(),
        specs["propose_patch"],
        {"kind": "bogus", "payload": {}},
        None,
    )
    assert '"ok": false' in result and "补丁类型非法" in result
    # 非法 payload 形态
    result = await executor(
        _StubCtx(),
        specs["propose_patch"],
        {"kind": "theme", "payload": "nope"},
        None,
    )
    assert '"ok": false' in result and "payload 须为对象" in result


async def test_propose_valid_returns_version(memory_storage):
    """合法提案：返回当前集版本（供 apply_patch 引用基准）。"""
    pipeline, executor, _ctx = _make_tools(memory_storage)
    result = await executor(
        _StubCtx(),
        _specs()["propose_patch"],
        {"kind": "theme", "payload": {"tokens": {"bg": "#123456"}}, "rationale": "换色"},
        None,
    )
    assert '"ok": true' in result
    assert '"current_version": 1' in result
    assert await pipeline.chain.current_version() == 1  # 只校验不落链


async def test_apply_l0_theme_applies_without_suspension(memory_storage):
    """L0（主题）直过：校验 → 审批直过 → 落链，不挂卡。"""
    pipeline, executor, _ctx = _make_tools(memory_storage)
    ctx = _StubCtx()
    result = await executor(
        ctx,
        _specs()["apply_patch"],
        {"kind": "theme", "payload": {"tokens": {"bg": "#123456"}}},
        None,
    )
    assert not ctx.suspended  # 无挂起
    # 集版本语义：补丁数 + 1（首条补丁 = 版本 2）
    assert '"ok": true' in result and '"patch_id": 2' in result
    state = await pipeline.chain.assemble()
    assert state["theme"] == {"bg": "#123456"}
    log = await pipeline.audit_log()
    assert log[-1]["status"] == "applied"


async def test_apply_l1_suspends_then_inject_applies(memory_storage):
    """L1（工具）挂卡：回合挂起（InterruptSignal），决议注入 accept 后落链。"""
    pipeline, executor, _ctx = _make_tools(
        memory_storage, approval_levels={PatchKind.TOOL: ApprovalLevel.L1}
    )
    specs = _specs()
    args = {
        "kind": "tool",
        "payload": {
            "name": "list_workspace",
            "description": "列出工作区文件",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
        "rationale": "注册工作区查看工具",
    }
    ctx = _StubCtx()
    with pytest.raises(InterruptSignal) as exc_info:
        await executor(ctx, specs["apply_patch"], args, None)
    key, card = exc_info.value.key, exc_info.value.payload
    assert key == "patch:tool"
    assert card["review_type"] == "gate"
    assert card["patch"]["kind"] == "tool"
    # 挂起期间未落链
    assert "list_workspace" not in (await pipeline.chain.assemble()).get("tools", {})
    # 决议注入重入
    ctx2 = _StubCtx(injections={"patch:tool": "accept"})
    result = await executor(ctx2, specs["apply_patch"], args, None)
    assert '"ok": true' in result and '"patch_id": 2' in result
    assert (await pipeline.chain.assemble())["tools"]["list_workspace"]["name"] == "list_workspace"


async def test_apply_reject_leaves_chain_untouched(memory_storage):
    """L1 拒绝决议：不落链，审计留痕 rejected。"""
    pipeline, executor, _ctx = _make_tools(
        memory_storage, approval_levels={PatchKind.TOOL: ApprovalLevel.L1}
    )
    specs = _specs()
    args = {
        "kind": "tool",
        "payload": {
            "name": "list_workspace",
            "description": "列出工作区文件",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
    }
    ctx = _StubCtx(injections={"patch:tool": DECISION_REJECT})
    result = await executor(ctx, specs["apply_patch"], args, None)
    assert '"ok": false' in result and '"status": "rejected"' in result
    assert "list_workspace" not in (await pipeline.chain.assemble()).get("tools", {})
    assert (await pipeline.audit_log())[-1]["status"] == "rejected"


async def test_apply_convergence_gate_blocks(memory_storage):
    """收敛管制前置闸门（可选钩子）：冷却期显式拒绝，AI 据此换方向。"""
    calls = []

    class _BlockingConvergence:
        async def assess(self, records, kind, payload):
            calls.append(kind)
            return SimpleNamespace(
                allowed=False,
                state="cooldown",
                target=f"{kind}:theme",
                reason="近窗口重写过频，冷却中",
            )

    pipeline, executor, _ctx = _make_tools(
        memory_storage, convergence=_BlockingConvergence()
    )
    result = await executor(
        _StubCtx(),
        _specs()["apply_patch"],
        {"kind": "theme", "payload": {"tokens": {"bg": "#000000"}}},
        None,
    )
    assert calls == ["theme"]
    assert '"ok": false' in result and '"status": "cooldown"' in result
    assert (await pipeline.chain.current_version()) == 1  # 未落链


async def test_apply_without_convergence_hook_runs_normally(memory_storage):
    """前置闸门未装配（convergence=None）：走正常审批管线。"""
    pipeline, executor, _ctx = _make_tools(memory_storage)
    result = await executor(
        _StubCtx(),
        _specs()["apply_patch"],
        {"kind": "theme", "payload": {"tokens": {"bg": "#abcdef"}}},
        None,
    )
    assert '"ok": true' in result
    assert (await pipeline.chain.assemble())["theme"] == {"bg": "#abcdef"}


async def test_revert_requires_approval_and_applies(memory_storage):
    """回退：先落一条 L0 补丁，回退走审批（挂卡注入 accept 后链级回退）。"""
    pipeline, executor, _ctx = _make_tools(memory_storage)
    specs = _specs()
    await executor(
        _StubCtx(),
        specs["apply_patch"],
        {"kind": "theme", "payload": {"tokens": {"bg": "#123456"}}},
        None,
    )
    assert await pipeline.chain.current_version() == 2
    # 回退挂卡（revert key），注入 accept
    ctx = _StubCtx(injections={"revert:2": DECISION_ACCEPT})
    result = await executor(ctx, specs["revert_patch"], {"patch_id": 2, "reason": "不喜欢"}, None)
    assert '"ok": true' in result
    state = await pipeline.chain.assemble()
    assert state.get("theme") is None  # 回退后回到基线
    log = await pipeline.audit_log()
    assert any(entry["kind"] == "revert" and entry["status"] == "reverted" for entry in log)


async def test_revert_rejects_wrong_patch_id(memory_storage):
    """回退非链尾补丁：结构化拒绝（仅允许链尾）。"""
    _pipeline, executor, _ctx = _make_tools(memory_storage)
    specs = _specs()
    await executor(
        _StubCtx(),
        specs["apply_patch"],
        {"kind": "theme", "payload": {"tokens": {"bg": "#123456"}}},
        None,
    )
    result = await executor(_StubCtx(), specs["revert_patch"], {"patch_id": 5}, None)
    assert '"ok": false' in result and "仅允许回退链尾补丁" in result


async def test_domain_manifest_proposes_harness(memory_storage):
    """领域生成器：高层描述 → 最小 harness 提案（校验通过 + 相关经验检索）。"""
    _pipeline, executor, context = _make_tools(memory_storage)
    context.knowledge_set.add(
        KnowledgeEntry(
            id="k1",
            level="project",
            kind="rule",
            data={"rule": {"id": "r1", "description": "现代诗创作与润色：诗歌用词需凝练"}},
            source=SOURCE_MODEL,
            credibility=0.9,
            title="现代诗创作与润色规范",
            tags=("诗歌", "润色"),
        )
    )
    args = {
        "domain_name": "poetry",
        "description": "现代诗创作与润色",
        "keywords": ["诗歌", "润色"],
        "rationale": "新增诗歌领域",
    }
    result = await executor(_StubCtx(), _specs()["propose_domain_manifest"], args, None)
    data = json_loads(result)
    assert data["ok"] is True
    assert data["kind"] == "harness"
    assert data["definition"]["name"] == "poetry"
    assert data["current_version"] == 1
    # 相关经验检索（复用优先于从头发明）
    assert any(item["id"] == "k1" for item in data["related_knowledge"])


async def test_domain_manifest_rejects_duplicate_name(memory_storage):
    """领域生成器：与既有 harness 重名显式拒绝（改名覆盖职责不归生成器）。"""
    _pipeline, executor, context = _make_tools(memory_storage)
    from ink_engine.core.harness import HarnessDefinition

    context.harness_registry.register(
        HarnessDefinition(name="poetry", description="既有诗歌领域", keywords=("诗歌",))
    )
    result = await executor(
        _StubCtx(),
        _specs()["propose_domain_manifest"],
        {
            "domain_name": "poetry",
            "description": "现代诗创作",
            "keywords": ["诗歌"],
        },
        None,
    )
    assert '"ok": false' in result and "领域名已存在" in result


async def test_domain_manifest_rejects_bad_tools(memory_storage):
    """领域生成器：工具清单逐项形态预校验（产出保证可被 apply_patch 复用）。"""
    _pipeline, executor, _ctx = _make_tools(memory_storage)
    result = await executor(
        _StubCtx(),
        _specs()["propose_domain_manifest"],
        {
            "domain_name": "poetry",
            "description": "现代诗创作",
            "keywords": ["诗歌"],
            "tools": [{"name": 123}],  # 非法工具定义
        },
        None,
    )
    assert '"ok": false' in result and "工具定义非法" in result


async def test_unknown_self_tool_rejected(memory_storage):
    """未知名显式拒绝（fail-closed：契约外工具不在内核执行范围）。"""
    _pipeline, executor, _ctx = _make_tools(memory_storage)
    from ink_engine.core.llm.tools import ToolSpec

    unknown = ToolSpec(
        name="harvest_seed",
        description="宿主扩展工具",
        parameters={"type": "object", "properties": {}},
        permissions=(PERMISSION_APPLY,),
    )
    with pytest.raises(GraphDefinitionError, match="未知自指工具"):
        await executor(_StubCtx(), unknown, {}, None)


def json_loads(text: str) -> dict:
    import json

    return json.loads(text)
