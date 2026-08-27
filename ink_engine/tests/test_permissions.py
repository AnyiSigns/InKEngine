"""声明式权限门禁测试（PermissionGate / NetworkPolicy / ToolSpec.permissions）。

覆盖：权限解析、分域匹配（filesystem/process/network/自定义域）、
三路判定（allow/review/deny）、fail-closed 默认拒绝、宿主默认策略让步、
门控分级注入、网络白名单。
"""
from __future__ import annotations

import pytest

from ink_engine.core.llm.tools import ToolSpec, to_openai_tools
from ink_engine.core.permissions import (
    ALLOW,
    DENY,
    REVIEW,
    NetworkPolicy,
    PermissionGate,
    network_matches,
    parse_permission,
    rule_matches,
)

# ── 权限解析 ──


def test_parse_permission_three_parts():
    rule = parse_permission("filesystem:write:/book/**")
    assert rule.domain == "filesystem"
    assert rule.action == "write"
    assert rule.pattern == "/book/**"


def test_parse_permission_action_omitted():
    rule = parse_permission("network:*.github.com")
    assert rule.domain == "network"
    assert rule.action == "*"
    assert rule.pattern == "*.github.com"


def test_parse_permission_invalid():
    for bad in ("filesystem", "", ":"):
        with pytest.raises(ValueError):
            parse_permission(bad)


# ── 分域匹配 ──


def test_filesystem_glob_match():
    rule = parse_permission("filesystem:write:/book/**")
    assert rule_matches(rule, "write", "/book/ch1.md")
    assert rule_matches(rule, "write", "/book/卷2/ch1.md")
    assert not rule_matches(rule, "write", "/other/ch1.md")
    assert not rule_matches(rule, "read", "/book/ch1.md")  # 动作不符


def test_filesystem_action_wildcard():
    rule = parse_permission("filesystem:*:/book/**")
    assert rule_matches(rule, "read", "/book/a.md")
    assert rule_matches(rule, "delete", "/book/a.md")


def test_process_command_whitelist():
    rule = parse_permission("process:exec:git|python")
    assert rule_matches(rule, "exec", "git")
    assert rule_matches(rule, "exec", "python")
    assert not rule_matches(rule, "exec", "rm")


def test_network_suffix_match():
    rule = parse_permission("network:connect:*.github.com")
    assert rule_matches(rule, "connect", "github.com")
    assert rule_matches(rule, "connect", "api.github.com")
    assert not rule_matches(rule, "connect", "evil.github.com.cn")


def test_network_matches_helper():
    assert network_matches("*.github.com", "github.com")
    assert network_matches("*.github.com", "api.github.com")
    assert not network_matches("*.github.com", "raw.githubusercontent.com")
    assert not network_matches("*.github.com", "github.org")


def test_custom_domain_fnmatch():
    rule = parse_permission("db:query:users|books")
    assert rule_matches(rule, "query", "users")
    assert rule_matches(rule, "query", "books")
    assert not rule_matches(rule, "query", "secrets")


# ── 三路判定 ──


def test_gate_allow_on_declared_permission():
    gate = PermissionGate()
    result = gate.check(
        "write_file", "write", "/book/ch1.md",
        permissions=("filesystem:write:/book/**",),
    )
    assert result.decision == ALLOW
    assert result.tool == "write_file"


def test_gate_fail_closed_without_permissions():
    gate = PermissionGate()
    result = gate.check("write_file", "write", "/book/ch1.md")
    assert result.decision == DENY
    assert "默认拒绝" in result.reason


def test_gate_deny_on_unmatched():
    gate = PermissionGate()
    result = gate.check(
        "write_file", "write", "/etc/passwd",
        permissions=("filesystem:write:/book/**",),
    )
    assert result.decision == DENY
    assert "未命中" in result.reason


def test_gate_deny_filesystem_hint_workspace_root_prefix():
    """filesystem 域拒绝附「工作区根绝对前缀」提示。

    模型传相对路径仅见「权限未命中: 'src/...'」会盲目试错（每次 ≈90s
    往返）；判定处直接附带路径形态引导，减少无引导的形态试探。
    """
    gate = PermissionGate()
    result = gate.check(
        "write_file", "write", "src/ch1.md",
        permissions=("filesystem:write:/workspace/**",),
    )
    assert result.decision == DENY
    assert "未命中" in result.reason
    assert "工作区根绝对前缀" in result.reason

    # 非 filesystem 操作域（process exec）不附加路径形态提示
    proc = gate.check(
        "run_cmd", "exec", "rm", permissions=("process:exec:git|python",),
    )
    assert proc.decision == DENY
    assert "工作区根" not in proc.reason

    # 未声明任何 filesystem 权限的工具拒绝：不附路径形态提示（缺权限非路径形态问题）
    bare = gate.check("write_file", "write", "/etc/passwd")
    assert bare.decision == DENY
    assert "工作区根" not in bare.reason


def test_gate_default_policy_review():
    gate = PermissionGate(default_policy=REVIEW)
    result = gate.check("write_file", "write", "/book/ch1.md")
    assert result.decision == REVIEW
    assert "放宽" in result.reason


def test_gate_default_policy_allow():
    gate = PermissionGate(default_policy=ALLOW)
    result = gate.check("write_file", "write", "/book/ch1.md")
    assert result.decision == ALLOW


def test_gate_review_tier_injected():
    # 宿主接线门控分级：写正文类工具 L2 需审批
    gate = PermissionGate(review_tier=lambda tool: tool == "write_chapter_content")
    result = gate.check(
        "write_chapter_content", "write", "/book/ch1.md",
        permissions=("filesystem:write:/book/**",),
    )
    assert result.decision == REVIEW
    assert "门控分级" in result.reason
    result2 = gate.check(
        "write_file", "write", "/book/ch1.md",
        permissions=("filesystem:write:/book/**",),
    )
    assert result2.decision == ALLOW  # 非 L2/L3 工具直过


# ── 网络白名单 ──


def test_network_policy_default_deny_all():
    policy = NetworkPolicy()
    assert not policy.allows("github.com")


def test_network_policy_whitelist():
    policy = NetworkPolicy(allow_domains=frozenset({"*.github.com", "example.org"}))
    assert policy.allows("github.com")
    assert policy.allows("api.github.com")
    assert policy.allows("example.org")
    assert not policy.allows("example.com")
    assert not policy.allows("evil.com")


# ── ToolSpec 权限字段（向后兼容）──


def test_tool_spec_permissions_default_empty():
    spec = ToolSpec(name="read_file")
    assert spec.permissions == ()
    spec2 = ToolSpec("write_file", "写入", None, ("filesystem:write:/book/**",))
    assert spec2.permissions == ("filesystem:write:/book/**",)


def test_to_openai_tools_ignores_permissions():
    spec = ToolSpec(
        name="write_file",
        description="写入",
        parameters={"type": "object", "properties": {}},
        permissions=("filesystem:write:/book/**",),
    )
    tools = to_openai_tools([spec])
    assert "permissions" not in tools[0]["function"]
