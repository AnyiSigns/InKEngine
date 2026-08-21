"""族 10：自指演化（test_10_self_evolution.py）｜introspection/self_tools/
self_proposal/self_application/ui_schema。

- inspect_* 五工具真实快照：恒定信封、函数直挂降级视图、敏感键剥离
- propose_patch 9 类补丁 kind 全量校验（非法提案建期拒绝）
- apply 分级审批 L0/L1/L2（L2 沙箱验证）→ 审计 → revert 链尾；
  base 并发冲突重提；GuardedStorage 旁路写全前缀拒绝
- ui_schema（v3 补）：UISchemaValidator 三层白名单（结构/组件/
  绑定通道与主题 token）拒绝未声明项 + 绑定路径保留前缀（`_`）防内部
  泄漏 + UIRenderer 契约

`real` 标记 = 真实 LLM 调用（族门禁②）；其余为确定性机制用例（零费用）。
"""
from __future__ import annotations

import json
import re

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.exceptions import GraphDefinitionError  # noqa: E402
from ink_engine.core.graph import Graph  # noqa: E402
from ink_engine.core.harness import HarnessDefinition, HarnessRegistry  # noqa: E402
from ink_engine.core.introspection import (  # noqa: E402
    INTROSPECTION_PERMISSION,
    IntrospectionService,
    IntrospectionSources,
    build_introspection_pipeline,
    introspection_tool_specs,
)
from ink_engine.core.knowledge_set import KnowledgeEntry, KnowledgeSet  # noqa: E402
from ink_engine.core.llm.messages import user  # noqa: E402
from ink_engine.core.self_application import (  # noqa: E402
    AUDIT_STATUS_APPLIED,
    AUDIT_STATUS_REVERTED,
    ApprovalLevel,
    GuardedStorage,
    SelfApplicationPipeline,
)
from ink_engine.core.self_proposal import PatchKind, ProposalValidator, SelfProposal  # noqa: E402
from ink_engine.core.self_tools import (  # noqa: E402
    SelfToolContext,
    make_self_executor,
    self_tool_specs,
)
from ink_engine.core.storage import create_storage  # noqa: E402
from ink_engine.core.ui_schema import (  # noqa: E402
    BIND_KEY,
    NODE_KIND_COMPONENT,
    NODE_KIND_CONTAINER,
    UIRenderer,
    UISchemaValidator,
    UISpec,
)

INTROSPECTION_TOOL_NAMES = (
    "inspect_graph",
    "inspect_rules",
    "inspect_knowledge",
    "inspect_ui",
    "inspect_tools",
)


def _knowledge_set(storage) -> KnowledgeSet:
    ks = KnowledgeSet("u1", storage=storage)
    ks.add(
        KnowledgeEntry(
            id="rule-1",
            level="user",
            kind="rule",
            title="主角动机一致",
            data={"rule": {"id": "rule-1", "predicate": "motive_consistent",
                          "config": {"motive_path": "motive"},
                          "description": "主角行为须与既定动机一致"}},
            source="model",
        )
    )
    ks.add(
        KnowledgeEntry(
            id="tpl-1",
            level="user",
            kind="template",
            title="章节模板",
            data={"steps": []},
            source="dialog",
        )
    )
    return ks


def _data_graph() -> Graph:
    g = Graph(name="intro", entry="start")
    g.add_node_type("start", "start", {"prompt": "你好"})
    g.add_edge("start", "mid")
    g.add_node_type("mid", "mid", {})
    g.add_exit("mid")
    return g


def _function_graph() -> Graph:
    async def start(ctx):
        return {}

    g = Graph(name="fn", entry="start")
    g.add_node("start", start)
    g.add_exit("start")
    return g


def _service(storage, graph=None, registry=None) -> IntrospectionService:
    return IntrospectionService(
        IntrospectionSources(
            graph=graph,
            knowledge_set=_knowledge_set(storage),
            harness_registry=registry,
            tools=introspection_tool_specs(),
            ui_spec={"layout": "panel"},
        )
    )


class _Ctx:
    """挂卡审批假上下文：预设注入值，未预设 = 显式报错（fail-closed）。"""

    def __init__(self) -> None:
        self.injects: dict = {}
        self.cards: list = []

    def preset(self, key: str, value) -> None:
        self.injects[key] = value

    async def interrupt(self, key: str, payload: dict):
        self.cards.append({"key": key, "payload": payload})
        if key not in self.injects:
            raise AssertionError(f"未预设注入值: {key}")
        return self.injects.pop(key)

    async def get_interrupt_payload(self, key: str):
        return None


def _make_pipeline(storage, *, approval_levels=None, l2_vetting=None) -> SelfApplicationPipeline:
    return SelfApplicationPipeline(
        storage,
        validator=ProposalValidator(
            allowed_components=("column", "message_list", "text", "input"),
            allowed_channels=("state",),
            allowed_theme_tokens=("bg", "fg", "accent"),
        ),
        approval_levels=approval_levels
        or {PatchKind.THEME: ApprovalLevel.L0, PatchKind.TOOL: ApprovalLevel.L1},
        l2_vetting=l2_vetting,
    )


# ----------------------------------------------------------------------
# inspect_* 五工具真实快照
# ----------------------------------------------------------------------

async def test_inspect_five_snapshots_constant_envelope(memory_storage) -> None:
    registry = HarnessRegistry()
    registry.register(HarnessDefinition(name="novel", description="小说", keywords=("小说",)))
    service = _service(memory_storage, graph=_data_graph(), registry=registry)
    snapshots = {name: service.snapshot(name, {}) for name in INTROSPECTION_TOOL_NAMES}
    for _name, snap in snapshots.items():
        assert isinstance(snap, dict)
        json.dumps(snap, ensure_ascii=False)  # 五路快照均可序列化
    graph_snap = snapshots["inspect_graph"]
    assert set(graph_snap) == {"graph", "digest"}  # 恒定信封
    assert graph_snap["graph"]["name"] == "intro"
    assert graph_snap["digest"]
    assert snapshots["inspect_rules"]["count"] == 1
    assert snapshots["inspect_knowledge"]["count"] == 2
    assert snapshots["inspect_ui"]["ui_spec"] == {"layout": "panel"}
    tools_snap = snapshots["inspect_tools"]
    assert tools_snap["count"] == 5
    assert tools_snap["harnesses"] == ["novel"]


async def test_inspect_graph_degraded_view(memory_storage) -> None:
    service = _service(memory_storage, graph=_function_graph())
    snap = service.snapshot_graph()
    graph = snap["graph"]
    assert graph["degraded"] is True
    assert graph["degraded_reason"]
    assert graph["nodes"]["start"] == {"type": "function"}
    assert snap["digest"]


async def test_inspect_pipeline_strips_sensitive_keys(memory_storage) -> None:
    graph = _data_graph()
    graph.add_node_type("llm", "llm", {"api_key": "sk-LIVE-SECRET-XYZ", "model_id": "m1"})
    service = _service(memory_storage, graph=graph)
    pipeline = build_introspection_pipeline(service)
    spec = introspection_tool_specs()[0]
    result = await pipeline.execute(None, spec, {})
    assert result.ok is True
    output = result.output
    config = json.loads(output)["graph"]["nodes"]["llm"]["config"]
    assert config["api_key"] == ""
    assert "sk-LIVE-SECRET-XYZ" not in output  # 凭据永不进入模型上下文


async def test_inspect_tool_specs_permission_shape() -> None:
    specs = introspection_tool_specs()
    assert tuple(s.name for s in specs) == INTROSPECTION_TOOL_NAMES
    for spec in specs:
        assert spec.permissions == (INTROSPECTION_PERMISSION,)


# ----------------------------------------------------------------------
# propose_patch 9 类补丁 kind 全量校验
# ----------------------------------------------------------------------

def _nine_valid_proposals() -> list[SelfProposal]:
    return [
        SelfProposal(PatchKind.UI, {"spec": {"name": "boot.panel", "root": {
            "kind": NODE_KIND_CONTAINER, "type": "column",
            "children": [{"kind": NODE_KIND_COMPONENT, "type": "message_list",
                          BIND_KEY: {"channel": "state", "path": "messages"}}]}}}),
        SelfProposal(PatchKind.THEME, {"tokens": {"bg": "#111", "fg": "#eee"}}),
        SelfProposal(PatchKind.TOOL, {"name": "list_files", "description": "x",
                                      "permissions": ["filesystem:read:/workspace"],
                                      "endpoint": "file_ops",
                                      "endpoint_config": {"root": "/workspace"}}),
        SelfProposal(PatchKind.RULE, {"rule": {"id": "r1", "predicate": "equals",
                                               "path": "status", "config": {"value": "active"},
                                               "severity": "warning",
                                               "description": "状态须激活"}}),
        SelfProposal(PatchKind.KNOWLEDGE, {"entry": {"id": "k1", "level": "user",
                                                     "kind": "rule",
                                                     "data": {"rule": {"id": "k1",
                                                                       "predicate": "present",
                                                                       "path": "x"}},
                                                     "title": "领域规则", "tags": ["写作"]}}),
        SelfProposal(PatchKind.HARNESS, {"definition": {"name": "novel",
                                                        "description": "x",
                                                        "keywords": ["小说"],
                                                        "graph": None, "tools": []}}),
        SelfProposal(PatchKind.EVENT_TYPE, {"name": "quest_start",
                                            "renderer": "QuestRow", "system": False}),
        SelfProposal(PatchKind.ENVIRONMENT, {"name": "node_env", "runtime": "local",
                                            "tools": ["node"],
                                            "install_cmds": ["npm install -g pkg"]}),
        SelfProposal(PatchKind.ARTIFACT, {"artifact_id": "js_bundle-abc123",
                                          "kind": "js_bundle",
                                          "hashes": {"index.js": "a" * 64}}),
    ]


def test_propose_nine_kinds_all_validated() -> None:
    validator = ProposalValidator(
        allowed_components=("column", "message_list", "text", "input"),
        allowed_channels=("state",),
        allowed_theme_tokens=("bg", "fg", "accent"),
    )
    proposals = _nine_valid_proposals()
    assert len(proposals) == 9
    for proposal in proposals:
        assert validator.validate(proposal) == [], f"{proposal.kind} 应校验通过"


def test_propose_illegal_kind_builtin_rejected() -> None:
    with pytest.raises(GraphDefinitionError, match="补丁类型非法"):
        SelfProposal(kind="bogus", payload={}, base_version=1)
    with pytest.raises(GraphDefinitionError, match="payload 须为 dict"):
        SelfProposal(kind=PatchKind.UI, payload=[], base_version=1)


async def test_propose_executor_rejects_bad_payload(memory_storage) -> None:
    pipeline = _make_pipeline(memory_storage)
    context = SelfToolContext(self_pipeline=pipeline)
    executor = make_self_executor(pipeline, lambda: context)
    specs = {s.name: s for s in self_tool_specs()}

    class _Stub:
        round_id = "r-1"

        async def interrupt(self, key, payload):
            raise AssertionError("不应挂卡（提案期只校验）")

        async def get_interrupt_payload(self, key):
            return None

    result = await executor(
        _Stub(), specs["propose_patch"],
        {"kind": "bogus", "payload": {}}, None,
    )
    assert '"ok": false' in result and "补丁类型非法" in result


# ----------------------------------------------------------------------
# apply 分级审批 L0/L1/L2 → 审计 → revert 链尾
# ----------------------------------------------------------------------

async def test_apply_l0_l1_l2_graded_and_audit(memory_storage) -> None:
    pipeline = _make_pipeline(
        memory_storage,
        approval_levels={
            PatchKind.THEME: ApprovalLevel.L0,
            PatchKind.TOOL: ApprovalLevel.L1,
            PatchKind.ARTIFACT: ApprovalLevel.L2,
        },
        l2_vetting=lambda proposal: [],
    )
    # L0 直过：不挂卡
    ctx0 = _Ctx()
    out0 = await pipeline.apply(ctx0, _nine_valid_proposals()[1])
    assert out0.applied is True and out0.decision == "auto" and out0.patch_id == 2
    assert not ctx0.cards
    # L1 弹卡：注入 accept 后落链（base 须跟随当前版本 2）
    ctx1 = _Ctx()
    ctx1.preset("patch:tool", {"decision": "accept"})
    tool_proposal = SelfProposal(
        PatchKind.TOOL,
        {"name": "list_files", "description": "x",
         "permissions": ["filesystem:read:/workspace"], "endpoint": "file_ops",
         "endpoint_config": {"root": "/workspace"}},
        base_version=2,
    )
    out1 = await pipeline.apply(ctx1, tool_proposal)
    assert out1.applied is True and out1.patch_id == 3
    assert ctx1.cards[0]["payload"]["review_type"] == "gate"
    # L2 沙箱验证通过 + 人工：vetting 通过后再弹卡（base 须跟随当前版本 3）
    ctx2 = _Ctx()
    ctx2.preset("patch:artifact", {"decision": "accept"})
    artifact_proposal = SelfProposal(
        PatchKind.ARTIFACT,
        {"artifact_id": "js_bundle-abc123", "kind": "js_bundle",
         "hashes": {"index.js": "a" * 64}},
        base_version=3,
    )
    out2 = await pipeline.apply(ctx2, artifact_proposal)
    assert out2.applied is True and out2.patch_id == 4
    # 审计链：三条 applied
    log = await pipeline.audit_log()
    assert [e["status"] for e in log] == [AUDIT_STATUS_APPLIED] * 3
    assert {e["kind"] for e in log} == {"theme", "tool", "artifact"}


async def test_apply_l2_vetting_veto_rejects(memory_storage) -> None:
    pipeline = _make_pipeline(
        memory_storage,
        approval_levels={PatchKind.ARTIFACT: ApprovalLevel.L2},
        l2_vetting=lambda proposal: ["产物包含可疑符号"],
    )
    ctx = _Ctx()
    outcome = await pipeline.apply(ctx, _nine_valid_proposals()[8])
    assert outcome.applied is False
    assert "L2 沙箱验证未通过" in (outcome.reason or "")
    assert not ctx.cards  # 闸门口拒绝，未弹卡


async def test_apply_base_conflict_rejects(memory_storage) -> None:
    pipeline = _make_pipeline(memory_storage)
    ctx = _Ctx()
    await pipeline.apply(ctx, _nine_valid_proposals()[1])  # 版本推进到 2
    stale = SelfProposal(PatchKind.THEME, {"tokens": {"bg": "#222"}}, base_version=1)
    outcome = await pipeline.apply(_Ctx(), stale)
    assert outcome.status == "conflict"
    assert "并发冲突" in (outcome.reason or "")
    assert await pipeline.chain.current_version() == 2  # 未落链


async def test_revert_chain_tail_audit(memory_storage) -> None:
    pipeline = _make_pipeline(memory_storage)
    ctx = _Ctx()
    await pipeline.apply(ctx, _nine_valid_proposals()[1])
    assert await pipeline.chain.current_version() == 2
    ctx2 = _Ctx()
    ctx2.preset("revert:2", {"decision": "accept"})
    outcome = await pipeline.revert(ctx2, 2, reason="换回旧主题")
    assert outcome.status == AUDIT_STATUS_REVERTED
    assert await pipeline.chain.current_version() == 1
    log = await pipeline.audit_log()
    assert log[-1]["status"] == AUDIT_STATUS_REVERTED
    assert log[-1]["kind"] == "revert"


async def test_guarded_storage_blocks_all_prefixes(memory_storage) -> None:
    guarded = GuardedStorage(create_storage("memory://"))
    guarded_collections = ["ui", "tool_defs", "event_types", "environments",
                           "artifacts", "harness", "set_patch_chain", "set_audit"]
    for coll in guarded_collections:
        with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
            await guarded.put_record(coll, "k", {"x": 1})
    with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
        await guarded.put_record("knowledge:default", "chain", {"base": {}})
    # 非演化资产集合放行
    await guarded.put_record("ui_context", "latest", {"active_view": "panel"})
    assert await guarded.get_record("ui_context", "latest") == {"active_view": "panel"}


# ----------------------------------------------------------------------
# ui_schema（v3 补）：三层白名单 + 绑定保留前缀 + 渲染器契约
# ----------------------------------------------------------------------

def _ui_validator() -> UISchemaValidator:
    return UISchemaValidator()


_VALID_LAYOUT: dict = {
    "name": "boot.panel",
    "root": {
        "kind": NODE_KIND_CONTAINER,
        "type": "column",
        "children": [
            {"kind": NODE_KIND_COMPONENT, "type": "message_list",
             BIND_KEY: {"channel": "state", "path": "messages"}},
        ],
    },
    "theme": {"bg": "#111", "fg": "#eee"},
}


def test_ui_schema_three_layer_whitelist() -> None:
    validator = _ui_validator()
    assert validator.validate(
        _VALID_LAYOUT,
        allowed_components=("column", "message_list"),
        allowed_channels=("state",),
        allowed_theme_tokens=("bg", "fg"),
    ) == []
    # 组件白名单：未注册组件拒绝
    bad_component = {"root": {"kind": NODE_KIND_COMPONENT, "type": "evil_component"}}
    assert any("组件未注册" in v for v in validator.validate(
        bad_component, allowed_components=("text",), allowed_channels=("state",)))
    # 绑定通道白名单：内部通道不放行
    bad_channel = {"root": {"kind": NODE_KIND_COMPONENT, "type": "text",
                            BIND_KEY: {"channel": "approval", "path": "secret"}}}
    assert any("bind.channel 未放行" in v for v in validator.validate(
        bad_channel, allowed_components=("text",), allowed_channels=("state",)))
    # 主题 token 白名单：未声明 token 拒绝
    bad_token = {"root": None, "theme": {"evil_style": "url(//x)"}}
    assert any("theme token 未声明" in v for v in validator.validate(
        bad_token, allowed_theme_tokens=("bg", "fg")))


def test_ui_bind_reserved_prefix_prevents_leak() -> None:
    validator = _ui_validator()
    leak = {"root": {"kind": NODE_KIND_COMPONENT, "type": "text",
                     BIND_KEY: {"channel": "state", "path": "_internal.patch_chain"}}}
    assert any("bind.path 命中保留前缀" in v for v in validator.validate(
        leak, allowed_components=("text",), allowed_channels=("state",)))
    # 常规路径不受影响
    ok = {"root": {"kind": NODE_KIND_COMPONENT, "type": "text",
                   BIND_KEY: {"channel": "state", "path": "round.current"}}}
    assert validator.validate_ok(
        ok, allowed_components=("text",), allowed_channels=("state",))


def test_ui_renderer_contract_and_roundtrip() -> None:
    class BootRenderer:
        def render(self, spec: UISpec) -> str:
            return f"render:{spec.name}"

    assert isinstance(BootRenderer(), UIRenderer)
    spec = UISpec.from_dict(_VALID_LAYOUT)
    assert spec.root is not None and spec.root.kind == NODE_KIND_CONTAINER
    assert UISpec.from_dict(spec.to_dict()) == spec


# ----------------------------------------------------------------------
# 真实 LLM：生成 self-proposal → ProposalValidator 校验 → 分级 apply → 审计
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_llm_generates_self_proposal(live_llm) -> None:
    storage = create_storage("memory://")
    pipeline = _make_pipeline(
        storage,
        approval_levels={
            PatchKind.THEME: ApprovalLevel.L0,
            PatchKind.TOOL: ApprovalLevel.L1,
        },
    )
    validator = pipeline.validator

    theme_prompt = (
        "只输出一个 JSON 对象，不要任何解释或代码围栏："
        '{"kind":"theme","payload":{"tokens":{"bg":"#1a2b3c"}}}。'
        "bg 必须是 7 字符十六进制颜色。"
    )
    theme_raw = await live_llm.ainvoke([user(theme_prompt)])
    theme_proposal = _parse_proposal(theme_raw.content, PatchKind.THEME)
    assert validator.validate(theme_proposal) == [], "LLM 生成的 theme 提案应通过校验"
    theme_out = await pipeline.apply(_Ctx(), theme_proposal)
    assert theme_out.applied is True and theme_out.patch_id == 2

    tool_prompt = (
        "只输出一个 JSON 对象，不要任何解释或代码围栏："
        '{"kind":"tool","payload":{"name":"lookup_example",'
        '"description":"查询示例数据","permissions":["filesystem:read:/data"],'
        '"endpoint":"file_ops","endpoint_config":{"root":"/data"}}}。'
    )
    tool_raw = await live_llm.ainvoke([user(tool_prompt)])
    # base 对齐当前链版本（theme 已落链 = v2；base_version 属引擎记账，不随模型生成）
    tool_proposal = _parse_proposal(tool_raw.content, PatchKind.TOOL, base_version=2)
    assert validator.validate(tool_proposal) == [], "LLM 生成的 tool 提案应通过校验"
    ctx = _Ctx()
    ctx.preset("patch:tool", {"decision": "accept"})
    tool_out = await pipeline.apply(ctx, tool_proposal)
    assert tool_out.applied is True

    log = await pipeline.audit_log()
    applied_kinds = {e["kind"] for e in log if e["status"] == AUDIT_STATUS_APPLIED}
    assert applied_kinds == {"theme", "tool"}


def _parse_proposal(text: str, kind: PatchKind, base_version: int = 1) -> SelfProposal:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    data = json.loads(match.group(0))
    payload = data.get("payload", {})
    return SelfProposal(kind=kind, payload=payload, base_version=base_version)
