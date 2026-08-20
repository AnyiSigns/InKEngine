"""界面描述数据原语单测：序列化往返 + 结构校验 + 三层白名单门禁。

覆盖：UIBind/UINode/UISpec 序列化往返、非法结构显式拒绝（类型/缺
type/绑定声明非法）、校验器语义（root 缺失、组件白名单、绑定通道
白名单、主题 token 白名单、component 携带 children、递归违规路径
报告）、渲染器协议可检查。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.ui_schema import (
    BIND_CHANNEL_KEY,
    BIND_KEY,
    BIND_PATH_KEY,
    DEFAULT_BIND_CHANNELS,
    NODE_KIND_COMPONENT,
    NODE_KIND_CONTAINER,
    UIBind,
    UINode,
    UIRenderer,
    UISchemaValidator,
    UISpec,
)

# 校验器共享夹具：三层白名单齐备的合法界面描述
VALID_LAYOUT: dict = {
    "name": "boot.panel",
    "version": 3,
    "root": {
        "kind": NODE_KIND_CONTAINER,
        "type": "column",
        "children": [
            {
                "kind": NODE_KIND_COMPONENT,
                "type": "text",
                "props": {"content": "你好"},
                BIND_KEY: {BIND_CHANNEL_KEY: "state", "path": "round.title"},
            },
            {"kind": NODE_KIND_COMPONENT, "type": "input", "props": {}},
        ],
    },
    "theme": {"bg": "#111", "accent": "#3b82f6"},
}

ALLOWED_COMPONENTS = ("text", "input", "column")
ALLOWED_CHANNELS = DEFAULT_BIND_CHANNELS
ALLOWED_TOKENS = ("bg", "fg", "accent")


def _validator() -> UISchemaValidator:
    return UISchemaValidator()


def test_bind_roundtrip() -> None:
    bind = UIBind(channel="state", path="round.count")
    restored = UIBind.from_dict(bind.to_dict())
    assert restored == bind


def test_bind_from_dict_rejects_invalid() -> None:
    with pytest.raises(GraphDefinitionError, match="缺 channel"):
        UIBind.from_dict({BIND_PATH_KEY: "x"})
    with pytest.raises(GraphDefinitionError, match="绑定路径非法"):
        UIBind.from_dict({BIND_CHANNEL_KEY: "state", BIND_PATH_KEY: 7})


def test_node_roundtrip_nested() -> None:
    node = UINode(
        kind=NODE_KIND_CONTAINER,
        type="column",
        children=(
            UINode(kind=NODE_KIND_COMPONENT, type="text", props={"content": "a"}),
            UINode(
                kind=NODE_KIND_CONTAINER,
                type="row",
                children=(UINode(kind=NODE_KIND_COMPONENT, type="input"),),
            ),
        ),
    )
    assert UINode.from_dict(node.to_dict()) == node


def test_node_from_dict_rejects_invalid_kind() -> None:
    with pytest.raises(GraphDefinitionError, match="布局节点类型非法"):
        UINode.from_dict({"kind": "magic", "type": "x"})


def test_node_from_dict_rejects_missing_type() -> None:
    with pytest.raises(GraphDefinitionError, match="缺 type"):
        UINode.from_dict({"kind": NODE_KIND_COMPONENT})


def test_spec_roundtrip() -> None:
    spec = UISpec.from_dict(VALID_LAYOUT)
    assert spec.name == "boot.panel"
    assert spec.version == 3
    assert spec.root is not None
    assert spec.root.kind == NODE_KIND_CONTAINER
    assert spec.theme == {"bg": "#111", "accent": "#3b82f6"}
    assert spec.root.children[0].bind is not None
    assert spec.root.children[0].bind.channel == "state"
    assert UISpec.from_dict(spec.to_dict()) == spec


def test_spec_roundtrip_undetermined() -> None:
    # 未定形界面（root = None）：渲染器显示占位，序列化往返保持
    spec = UISpec(name="boot.panel")
    restored = UISpec.from_dict(spec.to_dict())
    assert restored.root is None
    assert restored.to_dict() == {"name": "boot.panel", "version": 1}


def test_spec_from_dict_rejects_invalid() -> None:
    with pytest.raises(GraphDefinitionError, match="缺 name"):
        UISpec.from_dict({"root": None})
    with pytest.raises(GraphDefinitionError, match="theme 须为 dict"):
        UISpec.from_dict({"name": "x", "theme": "dark"})


def test_validate_ok() -> None:
    violations = _validator().validate(
        VALID_LAYOUT,
        allowed_components=ALLOWED_COMPONENTS,
        allowed_channels=ALLOWED_CHANNELS,
        allowed_theme_tokens=ALLOWED_TOKENS,
    )
    assert violations == []


def test_validate_ok_boolean_entry() -> None:
    assert _validator().validate_ok(
        VALID_LAYOUT,
        allowed_components=ALLOWED_COMPONENTS,
        allowed_channels=ALLOWED_CHANNELS,
        allowed_theme_tokens=ALLOWED_TOKENS,
    )


def test_validate_missing_root() -> None:
    violations = _validator().validate({"name": "x"}, allowed_components=ALLOWED_COMPONENTS)
    assert "缺 root" in violations[0]


def test_validate_unregistered_component() -> None:
    # 组件白名单：JSON 只能引用已注册组件，未注册 = 违规不渲染
    layout = {
        "root": {
            "kind": NODE_KIND_COMPONENT,
            "type": "shell_exec",
            "props": {"command": "rm -rf /"},
        }
    }
    violations = _validator().validate(
        layout, allowed_components=("text",), allowed_channels=ALLOWED_CHANNELS
    )
    assert any("组件未注册" in item and "shell_exec" in item for item in violations)


def test_validate_bind_channel_denied() -> None:
    # 绑定白名单：补丁链/审批等内部通道不放行（防信息泄漏）
    layout = {
        "root": {
            "kind": NODE_KIND_COMPONENT,
            "type": "text",
            BIND_KEY: {BIND_CHANNEL_KEY: "approval", "path": "secret"},
        }
    }
    violations = _validator().validate(
        layout, allowed_components=("text",), allowed_channels=ALLOWED_CHANNELS
    )
    assert any("bind.channel 未放行" in item and "approval" in item for item in violations)


def test_validate_bind_path_reserved_prefix_denied() -> None:
    # 绑定路径保留前缀：内部数据路径（_ 开头段）拒绝绑定（第二道防线）
    layout = {
        "root": {
            "kind": NODE_KIND_COMPONENT,
            "type": "text",
            BIND_KEY: {BIND_CHANNEL_KEY: "state", "path": "_internal.patch_chain"},
        }
    }
    violations = _validator().validate(
        layout, allowed_components=("text",), allowed_channels=ALLOWED_CHANNELS
    )
    assert any("bind.path 命中保留前缀" in item and "_internal" in item for item in violations)
    # 常规路径不受影响
    ok_layout = {
        "root": {
            "kind": NODE_KIND_COMPONENT,
            "type": "text",
            BIND_KEY: {BIND_CHANNEL_KEY: "state", "path": "round.current"},
        }
    }
    assert _validator().validate_ok(
        ok_layout, allowed_components=("text",), allowed_channels=ALLOWED_CHANNELS
    )


def test_validate_theme_token_denied() -> None:
    layout = {"root": None, "theme": {"evil_style": "url(//x)"}}
    violations = _validator().validate(layout, allowed_theme_tokens=ALLOWED_TOKENS)
    assert any("theme token 未声明" in item and "evil_style" in item for item in violations)


def test_validate_component_with_children() -> None:
    layout = {
        "root": {
            "kind": NODE_KIND_COMPONENT,
            "type": "text",
            "children": [{"kind": NODE_KIND_COMPONENT, "type": "input"}],
        }
    }
    violations = _validator().validate(
        layout, allowed_components=("text", "input"), allowed_channels=ALLOWED_CHANNELS
    )
    assert any("不允许携带 children" in item for item in violations)


def test_validate_nested_violation_reports_path() -> None:
    # 递归违规带节点路径：可读可审计（root.children[1].type）
    layout = {
        "root": {
            "kind": NODE_KIND_CONTAINER,
            "type": "column",
            "children": [
                {"kind": NODE_KIND_COMPONENT, "type": "text"},
                {"kind": NODE_KIND_COMPONENT, "type": "unknown_component"},
            ],
        }
    }
    violations = _validator().validate(
        layout, allowed_components=("text",), allowed_channels=ALLOWED_CHANNELS
    )
    assert any("root.children[1].type" in item for item in violations)


def test_validate_fail_closed_default_whitelists() -> None:
    # 缺省白名单 fail-closed：未传组件白名单 = 任何组件都不放行
    layout = {
        "root": {"kind": NODE_KIND_COMPONENT, "type": "text"},
    }
    violations = _validator().validate(layout)
    assert any("组件未注册" in item for item in violations)


def test_validate_unknown_fields_ignored() -> None:
    # schema 演进宽容：未知字段忽略不违规（加字段不破坏旧布局）
    layout = dict(VALID_LAYOUT)
    layout["extra_field"] = {"anything": True}
    violations = _validator().validate(
        layout,
        allowed_components=ALLOWED_COMPONENTS,
        allowed_channels=ALLOWED_CHANNELS,
        allowed_theme_tokens=ALLOWED_TOKENS,
    )
    assert violations == []


def test_renderer_protocol_check() -> None:
    # 渲染器接口可检查（产品侧实现须可被识别为 UIRenderer）
    class BootRenderer:
        def render(self, spec: UISpec) -> str:
            return f"render:{spec.name}"

    assert isinstance(BootRenderer(), UIRenderer)
