"""自指提案协议单测：补丁类型声明 + 按类型校验。

覆盖：提案序列化往返、非法形态拒绝、九类补丁的校验语义（界面
三层白名单/主题 token/工具定义/规则解析/知识条目/图与 harness/
事件类型/环境声明/产物哈希），未知类型与缺 payload 拒绝。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.self_proposal import (
    PatchKind,
    ProposalValidator,
    SelfProposal,
)


def _proposal(kind: PatchKind, payload: dict, base_version: int = 1) -> SelfProposal:
    return SelfProposal(
        kind=kind,
        payload=payload,
        base_version=base_version,
        rationale="测试提案",
        meta={"round_id": "r1"},
    )


def test_proposal_roundtrip() -> None:
    proposal = _proposal(
        PatchKind.THEME, {"tokens": {"bg": "#000"}}, base_version=3
    )
    restored = SelfProposal.from_dict(proposal.to_dict())
    assert restored == proposal
    assert restored.kind is PatchKind.THEME
    assert restored.base_version == 3
    assert restored.rationale == "测试提案"


def test_proposal_rejects_invalid() -> None:
    with pytest.raises(GraphDefinitionError, match="payload 须为 dict"):
        SelfProposal(kind=PatchKind.UI, payload=[], base_version=1)
    with pytest.raises(GraphDefinitionError, match="基准版本非法"):
        SelfProposal(kind=PatchKind.UI, payload={}, base_version=0)
    with pytest.raises(GraphDefinitionError, match="补丁类型非法"):
        SelfProposal.from_dict({"kind": "nope", "payload": {}})


def _validator(**kwargs) -> ProposalValidator:
    return ProposalValidator(
        allowed_components=("column", "message_list"),
        allowed_channels=("state",),
        allowed_theme_tokens=("bg", "fg"),
        **kwargs,
    )


def test_validate_ui() -> None:
    validator = _validator()
    ok = _proposal(
        PatchKind.UI,
        {
            "spec": {
                "name": "boot.panel",
                "root": {
                    "kind": "container",
                    "type": "column",
                    "children": [
                        {
                            "kind": "component",
                            "type": "message_list",
                            "bind": {"channel": "state", "path": "messages"},
                        }
                    ],
                },
            }
        },
    )
    assert validator.validate(ok) == []

    bad_component = _proposal(
        PatchKind.UI,
        {
            "spec": {
                "name": "x",
                "root": {"kind": "component", "type": "evil_component"},
            }
        },
    )
    assert any("组件未注册" in v for v in validator.validate(bad_component))

    bad_bind = _proposal(
        PatchKind.UI,
        {
            "spec": {
                "name": "x",
                "root": {
                    "kind": "component",
                    "type": "message_list",
                    "bind": {"channel": "_internal", "path": "secret"},
                },
            }
        },
    )
    assert any("未放行" in v for v in validator.validate(bad_bind))


def test_validate_theme() -> None:
    validator = _validator()
    ok = _proposal(PatchKind.THEME, {"tokens": {"bg": "#111", "fg": "#eee"}})
    assert validator.validate(ok) == []
    bad = _proposal(PatchKind.THEME, {"tokens": {"evil_token": "#000"}})
    assert any("未声明" in v for v in validator.validate(bad))
    missing = validator.validate(_proposal(PatchKind.THEME, {}))
    assert missing and "缺 tokens" in missing[0]


def test_validate_tool() -> None:
    validator = _validator()
    ok = _proposal(
        PatchKind.TOOL,
        {
            "name": "listfiles",
            "description": "列出文件",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
    )
    assert validator.validate(ok) == []
    no_perms = _proposal(
        PatchKind.TOOL,
        {"name": "t", "description": "x", "permissions": []},
    )
    assert any("权限" in v for v in validator.validate(no_perms))
    bad_endpoint = _proposal(
        PatchKind.TOOL,
        {
            "name": "t",
            "description": "x",
            "permissions": ["filesystem:read:/w"],
            "endpoint": "file_ops",
            "endpoint_config": {},
        },
    )
    assert any("root" in v for v in validator.validate(bad_endpoint))


def test_validate_tool_name_naming_rule_enforced() -> None:
    """命名规范断言（新增/自写工具统一执行）：TOOL 补丁名违规 → 提案期拒绝。

    断言驻留提案/自写边界（ProposalValidator._validate_tool）而非共享
    构造面：出厂基线工具（历史下划线名）经装配路径注册不受影响，命名
    整改由产品层决策后统一执行。
    """
    validator = _validator()
    snake = _proposal(
        PatchKind.TOOL,
        {
            "name": "list_files",
            "description": "列出文件",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
    )
    violations = validator.validate(snake)
    assert any("违反命名规范" in v and "禁用字符" in v for v in violations)
    overlong = _proposal(
        PatchKind.TOOL,
        {
            "name": "x" * 25,
            "description": "x",
            "permissions": ["filesystem:read:/workspace"],
            "endpoint": "file_ops",
            "endpoint_config": {"root": "/workspace"},
        },
    )
    assert any("长度超限" in v for v in validator.validate(overlong))


def test_validate_tool_name_rule_waived_for_mcp_remote() -> None:
    """MCP 远程工具豁免命名断言：名字来自第三方服务器清单，不由产品
    行为词典管控；豁免由声明数据（endpoint=mcp）推导，序列化往返不丢。
    """
    validator = _validator()
    mcp_tool = _proposal(
        PatchKind.TOOL,
        {
            "name": "web_search",
            "description": "远程搜索工具",
            "permissions": ["mcp:call:search_provider"],
            "endpoint": "mcp",
            "endpoint_config": {"server_id": "search_provider"},
        },
    )
    assert validator.validate(mcp_tool) == []


def test_validate_rule() -> None:
    validator = _validator()
    ok = _proposal(
        PatchKind.RULE,
        {
            "rule": {
                "id": "r1",
                "predicate": "equals",
                "path": "status",
                "config": {"value": "active"},
                "severity": "warning",
                "description": "状态须为激活",
            }
        },
    )
    assert validator.validate(ok) == []
    assert validator.validate(_proposal(PatchKind.RULE, {})) == [
        "rule 补丁缺 rule（规则声明 dict）"
    ]


def test_validate_knowledge() -> None:
    validator = _validator()
    ok = _proposal(
        PatchKind.KNOWLEDGE,
        {
            "entry": {
                "id": "k1",
                "level": "user",
                "kind": "rule",
                "data": {"rule": {"id": "k1", "predicate": "present", "path": "x"}},
                "title": "领域规则",
                "tags": ["写作"],
            }
        },
    )
    assert validator.validate(ok) == []
    bad_level = _proposal(
        PatchKind.KNOWLEDGE,
        {"entry": {"id": "k2", "level": "galaxy", "kind": "rule", "data": {}}},
    )
    assert any("层级非法" in v for v in validator.validate(bad_level))


def test_validate_harness() -> None:
    validator = _validator()
    ok = _proposal(
        PatchKind.HARNESS,
        {
            "definition": {
                "name": "novel",
                "description": "小说领域",
                "keywords": ["小说"],
                "graph": None,
                "tools": [],
            }
        },
    )
    assert validator.validate(ok) == []
    bad_graph = _proposal(
        PatchKind.HARNESS,
        {
            "definition": {
                "name": "novel",
                "description": "x",
                "graph": {"name": "g", "entry": "ghost", "nodes": {}, "edges": {}},
            }
        },
    )
    violations = validator.validate(bad_graph)
    assert violations, "非法图定义应被 harness 校验拦截"
    assert validator.validate(_proposal(PatchKind.HARNESS, {})) == [
        "harness 补丁缺 definition（harness 声明 dict）"
    ]


def test_validate_event_type() -> None:
    validator = _validator()
    ok = _proposal(
        PatchKind.EVENT_TYPE,
        {"name": "quest_start", "renderer": "QuestRow", "system": False},
    )
    assert validator.validate(ok) == []
    violations = validator.validate(
        _proposal(PatchKind.EVENT_TYPE, {"renderer": "X"})
    )
    assert violations and "缺 name" in violations[0]
    # 新事件类型必须带渲染组件（renderer 契约）：无 renderer = 拒绝注册
    no_renderer = _proposal(
        PatchKind.EVENT_TYPE, {"name": "no_renderer_evt", "system": False}
    )
    assert any("renderer" in v for v in validator.validate(no_renderer))
    # 系统信号不入回合步骤序列（装配器合成注入），豁免 renderer 要求
    system_evt = _proposal(
        PatchKind.EVENT_TYPE, {"name": "sys_signal", "system": True}
    )
    assert validator.validate(system_evt) == []


def test_validate_environment() -> None:
    validator = _validator()
    ok = _proposal(
        PatchKind.ENVIRONMENT,
        {"name": "node_env", "runtime": "local", "tools": ["node"], "install_cmds": ["npm install -g pkg"]},
    )
    assert validator.validate(ok) == []
    violations = validator.validate(
        _proposal(PatchKind.ENVIRONMENT, {"name": "e", "runtime": "docker"})
    )
    assert violations and "runtime 非法" in violations[0]


def test_validate_artifact() -> None:
    validator = _validator()
    ok = _proposal(
        PatchKind.ARTIFACT,
        {
            "artifact_id": "js_bundle-abc123",
            "kind": "js_bundle",
            "hashes": {"index.js": "a" * 64},
        },
    )
    assert validator.validate(ok) == []
    short_hash = _proposal(
        PatchKind.ARTIFACT,
        {"artifact_id": "a", "kind": "js_bundle", "hashes": {"index.js": "abc"}},
    )
    assert any("sha256 hex" in v for v in validator.validate(short_hash))


def test_unknown_kind_rejected_at_construction() -> None:
    with pytest.raises(GraphDefinitionError, match="补丁类型非法"):
        SelfProposal(kind="mystery", payload={}, base_version=1)
