"""声明式权限门禁（PermissionGate：默认拒绝 fail-closed 的权限判定原语）。

工具权限 = 声明式字符串集合（``ToolSpec.permissions``），形态
``domain:action:pattern``（action 可省略，如 ``network:*.github.com``）：

- ``filesystem:read|write|delete:<路径 glob>``——路径以工作根为基准的绝对路径；
- ``process:exec:<命令白名单>``——``|`` 分隔的命令名/glob；
- ``network:connect:<域名后缀>``——``*.github.com`` 匹配主域及其子域（默认禁网）。

判定三路（:meth:`PermissionGate.check` 返回 :class:`GateResult`）：
- allow：权限声明命中，且门控分级不要求审批；
- review：权限命中但门控分级需审批——委托 ``approve_before_execute``
  （PermissionGate 自身不挂起，只标记需审批）；
- deny：权限未命中（fail-closed）或门控分级拒绝。

未声明权限的工具默认拒绝（fail-closed）；宿主可把 ``default_policy`` 放宽为
review/allow（明示安全让步）。门控分级判定（L1-L3）由宿主注入
（``components.review_card.gating_tier_of`` 经共享组件接线），本模块不 import 组件包。

沙箱是机制、非安全边界承诺——默认拒绝兜底 + 纵深防御，宿主可叠加 OS 级隔离。
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from fnmatch import fnmatch

ALLOW = "allow"
REVIEW = "review"
DENY = "deny"

# 各权限域支持的判定动作（供校验与文档；匹配时 action 支持 fnmatch 通配）
_DOMAIN_ACTIONS: dict[str, tuple[str, ...]] = {
    "filesystem": ("read", "write", "delete"),
    "process": ("exec",),
    "network": ("connect",),
}

_KNOWN_DOMAINS = frozenset(_DOMAIN_ACTIONS)


@dataclass(frozen=True, slots=True)
class PermissionRule:
    """解析后的权限规则（``domain:action:pattern`` 三段式，action 可省略为 *）。"""

    domain: str
    action: str
    pattern: str


def parse_permission(spec: str) -> PermissionRule:
    """声明式权限串 → 规则（缺省 action 为 *）。

    形态：``domain:action:pattern`` 或 ``domain:pattern``；未知域不拒绝
    （宿主自定义域经同一 fnmatch 匹配），未知域误写由匹配自然失效。
    """
    parts = spec.split(":", 2)
    if len(parts) == 2:
        domain, pattern = parts
        action = "*"
    elif len(parts) == 3:
        domain, action, pattern = parts
    else:
        raise ValueError(f"权限声明须为 domain[:action]:pattern 形态: {spec!r}")
    if not domain or not pattern:
        raise ValueError(f"权限声明的 domain/pattern 不能为空: {spec!r}")
    return PermissionRule(domain=domain, action=action, pattern=pattern)


def rule_matches(rule: PermissionRule, operation: str, target: str) -> bool:
    """规则 × 单次判定的匹配（分域语义；network 为域名后缀匹配，其余 fnmatch）。"""
    if not fnmatch(operation, rule.action):
        return False
    if rule.domain == "network":
        return network_matches(rule.pattern, target)
    if rule.domain == "filesystem":
        # Windows 反斜杠在 fnmatch 中是转义符：路径统一转正斜杠后 glob；
        # 含 ``..`` 段的路径一律拒绝——fnmatch 的 ``*``/``**`` 跨路径分隔符
        # 匹配，``/book/**`` 可放行 ``/book/../../etc/passwd``，权限层必须先
        # 守住路径边界（``..`` 归一到沙箱/调用方再判等于放行穿越）
        t = target.replace("\\", "/")
        if ".." in t.split("/"):
            return False
        return _fnmatch_any(rule.pattern.replace("\\", "/"), t)
    if rule.domain in _KNOWN_DOMAINS:
        return _fnmatch_any(rule.pattern, target)
    # 宿主自定义域：同样走 fnmatch（机制不给自定义域额外语义）
    return _fnmatch_any(rule.pattern, target)


def _fnmatch_any(pattern: str, target: str) -> bool:
    if "|" in pattern:
        return any(fnmatch(target, p) for p in pattern.split("|"))
    return fnmatch(target, pattern)


def network_matches(pattern: str, host: str) -> bool:
    """网络域匹配：``*.github.com`` 匹配 github.com 及其任意子域；其余 fnmatch。"""
    if pattern.startswith("*."):
        bare = pattern[2:]
        return host == bare or host.endswith("." + bare)
    return fnmatch(host, pattern)


@dataclass(frozen=True, slots=True)
class GateResult:
    """单次判定的结果（宿主按 decision 执行/审批/拒绝）。"""

    decision: str
    tool: str
    operation: str
    target: str
    reason: str = ""


@dataclass(frozen=True, slots=True)
class PermissionGate:
    """声明式权限门禁（fail-closed）。

    Attributes:
        default_policy: 工具未声明权限（或未命中）时的兜底——deny（默认，
            未声明权限工具默认拒绝）/ review（转审批）/ allow（明示让步）。
        review_tier: 门控分级注入（宿主接线 gating_tier_of 的 L2/L3 判定）；
            返回 True 的工具在权限命中后仍转 review，False 直过。
    """

    default_policy: str = DENY
    review_tier: Callable[[str], bool] | None = None

    def check(
        self,
        tool: str,
        operation: str,
        target: str,
        *,
        permissions: tuple[str, ...] = (),
    ) -> GateResult:
        """判定一次工具调用：权限声明命中 × 门控分级 → allow / review / deny。

        Args:
            tool: 工具名（审计与门控分级判定用）。
            operation: 判定动作（filesystem 的 read/write/delete、process 的
                exec、network 的 connect）。
            target: 判定目标（文件路径 / 命令名 / 域名）。
            permissions: 工具的声明式权限（ToolSpec.permissions）。
        """
        hit = any(rule_matches(parse_permission(p), operation, target) for p in permissions)
        if not hit:
            if self.default_policy == ALLOW:
                return GateResult(ALLOW, tool, operation, target, "未声明权限（宿主放宽为放行）")
            if self.default_policy == REVIEW:
                return GateResult(REVIEW, tool, operation, target, "未声明权限（宿主放宽为审批）")
            return GateResult(
                DENY, tool, operation, target,
                "未声明权限或权限未命中，默认拒绝" if not permissions else f"权限未命中: {target!r}",
            )
        if self.review_tier is not None and self.review_tier(tool):
            return GateResult(REVIEW, tool, operation, target, "门控分级需审批")
        return GateResult(ALLOW, tool, operation, target, "")


@dataclass(frozen=True, slots=True)
class NetworkPolicy:
    """网络访问判定原语（默认禁网；白名单域名由宿主配置）。"""

    allow_domains: frozenset[str] = frozenset()

    def allows(self, host: str) -> bool:
        """域名是否放行（白名单后缀匹配，未命中 = 禁网）。"""
        return any(network_matches(p, host) for p in self.allow_domains)


__all__ = [
    "ALLOW",
    "DENY",
    "REVIEW",
    "GateResult",
    "NetworkPolicy",
    "PermissionGate",
    "PermissionRule",
    "network_matches",
    "parse_permission",
    "rule_matches",
]
