"""界面描述数据原语（产品即数据：布局树/绑定协议/主题 token）。

界面描述 = 数据（JSON 布局树），渲染器 = 机制实现（产品侧装配）。
AI 经自指层提案界面补丁（ui 补丁类型）落地布局，渲染器消费最新
描述即时重渲——产品形态随数据演化，框架只是 boot 壳。

安全边界（JSON 只能描述，不能执行）：
- 组件白名单：布局只能引用已注册组件（component.type 必须 ∈ 白名单），
  未注册组件 = 校验违规不渲染——杜绝「布局 JSON 执行任意代码」路径；
- 绑定白名单：数据绑定只能指向宿主放行的状态通道（bind.channel
  必须 ∈ 白名单），补丁链/审批/审计等内部通道默认不放行——防信息泄漏；
  绑定路径同样受限：保留前缀（_ 开头）的路径段视为内部数据，拒绝绑定；
- 主题 token 白名单：布局只能使用已声明的主题键——防任意样式注入。

校验哲学（与 SchemaValidator 同构）：声明式约束 + 违规清单可读可
审计；未知字段忽略（schema 演进宽容），必填缺失 = 违规。绑定协议
形态：{"bind": {"channel": "state", "path": "count"}}——组件数据挂到
状态通道的指定路径，渲染器订阅通道变更重渲。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .exceptions import GraphDefinitionError

# 布局节点类型（声明式枚举，防魔法字符串）
NODE_KIND_CONTAINER = "container"
NODE_KIND_COMPONENT = "component"
_VALID_NODE_KINDS = (NODE_KIND_CONTAINER, NODE_KIND_COMPONENT)

# 绑定协议键（布局树内嵌声明）
BIND_KEY = "bind"
BIND_CHANNEL_KEY = "channel"
BIND_PATH_KEY = "path"

# 默认放行的绑定通道（机制层基线：回合状态通道；宿主可装配扩展）
DEFAULT_BIND_CHANNELS = ("state",)

# 绑定路径保留前缀：以该前缀开头的路径段视为内部数据（补丁链/
# 审批/审计等机制内部态），禁止作为绑定路径——通道白名单之外的
# 第二道路径级防线，防信息泄漏
RESERVED_BIND_PREFIXES = ("_",)


@dataclass(frozen=True, slots=True)
class UIBind:
    """数据绑定声明（组件数据挂到状态通道的指定路径）。

    Attributes:
        channel: 状态通道名（须 ∈ 绑定白名单；如 "state"）。
        path: 通道内点分路径（如 "count" / "round.current"；空 = 整个通道）。
    """

    channel: str
    path: str = ""

    def to_dict(self) -> dict[str, str]:
        return {BIND_CHANNEL_KEY: self.channel, BIND_PATH_KEY: self.path}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> UIBind:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"绑定声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        channel = data.get(BIND_CHANNEL_KEY)
        if not channel or not isinstance(channel, str):
            raise GraphDefinitionError("绑定声明缺 channel（字符串）")
        path = data.get(BIND_PATH_KEY)
        if path is not None and not isinstance(path, str):
            raise GraphDefinitionError(f"绑定路径非法: {path!r}（须为字符串）")
        return cls(channel=channel, path=path or "")


@dataclass(frozen=True, slots=True)
class UINode:
    """布局树节点（container 组织层级，component 引用白名单组件）。

    Attributes:
        kind: 节点类型（container/component）。
        type: 容器名或组件名（component 必须 ∈ 渲染器注册的组件白名单）。
        props: 组件属性（静态数据，如文本/尺寸；动态数据走 bind）。
        bind: 数据绑定声明（None = 无动态数据）。
        children: 子节点（仅 container 使用；component 必须为空）。
    """

    kind: str
    type: str
    props: dict = field(default_factory=dict)
    bind: UIBind | None = None
    children: tuple[UINode, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"kind": self.kind, "type": self.type}
        if self.props:
            data["props"] = dict(self.props)
        if self.bind is not None:
            data[BIND_KEY] = self.bind.to_dict()
        if self.children:
            data["children"] = [child.to_dict() for child in self.children]
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> UINode:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"布局节点非法: 期望 dict，收到 {type(data).__name__}"
            )
        kind = data.get("kind")
        if kind not in _VALID_NODE_KINDS:
            raise GraphDefinitionError(f"布局节点类型非法: {kind!r}（仅 {_VALID_NODE_KINDS}）")
        type_name = data.get("type")
        if not type_name or not isinstance(type_name, str):
            raise GraphDefinitionError("布局节点缺 type（字符串）")
        props = data.get("props")
        if props is not None and not isinstance(props, dict):
            raise GraphDefinitionError(f"节点 {type_name} 的 props 须为 dict")
        raw_bind = data.get(BIND_KEY)
        bind = UIBind.from_dict(raw_bind) if raw_bind is not None else None
        raw_children = data.get("children")
        if raw_children is not None:
            if not isinstance(raw_children, list):
                raise GraphDefinitionError(f"节点 {type_name} 的 children 须为清单")
            children = tuple(UINode.from_dict(child) for child in raw_children)
        else:
            children = ()
        return cls(
            kind=kind,
            type=type_name,
            props=dict(props or {}),
            bind=bind,
            children=children,
        )


@dataclass(frozen=True, slots=True)
class UISpec:
    """界面描述（布局树 + 主题 token + 版本；纯数据，可序列化随补丁链版本化）。

    Attributes:
        name: 界面名（如 "boot.panel"；宿主按名分发渲染）。
        root: 布局树根节点（None = 未定形，渲染器显示占位）。
        theme: 主题 token 增量（键名须 ∈ 主题 token 白名单）。
        version: 界面描述版本（补丁链回退锚点）。
    """

    name: str
    root: UINode | None = None
    theme: dict = field(default_factory=dict)
    version: int = 1

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"name": self.name, "version": self.version}
        if self.root is not None:
            data["root"] = self.root.to_dict()
        if self.theme:
            data["theme"] = dict(self.theme)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> UISpec:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"界面描述非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        if not name or not isinstance(name, str):
            raise GraphDefinitionError("界面描述缺 name（字符串）")
        raw_root = data.get("root")
        root = UINode.from_dict(raw_root) if raw_root is not None else None
        theme = data.get("theme")
        if theme is not None and not isinstance(theme, dict):
            raise GraphDefinitionError(f"界面 {name} 的 theme 须为 dict")
        version = int(data.get("version") or 1)
        return cls(name=name, root=root, theme=dict(theme or {}), version=version)


class UISchemaValidator:
    """界面描述校验器（结构 + 三层白名单；纯函数无状态，可作模块级复用）。

    校验语义（违规清单可读可审计，闸门失败原因可直接展示）：
    - 结构：root 存在、kind 合法、component 不携带 children；
    - 组件白名单：component.type ∈ allowed_components（未注册 = 违规）；
    - 绑定白名单：bind.channel ∈ allowed_channels（内部通道不放行）；
    - 主题白名单：theme 键 ∈ allowed_theme_tokens（未声明 = 违规）。
    """

    def validate(
        self,
        data: dict[str, Any],
        *,
        allowed_components: tuple[str, ...] = (),
        allowed_channels: tuple[str, ...] = DEFAULT_BIND_CHANNELS,
        allowed_theme_tokens: tuple[str, ...] = (),
    ) -> list[str]:
        """校验界面描述 dict（补丁 payload 天然形态）；返回违规清单（空 = 通过）。"""
        if not isinstance(data, dict):
            return [f"界面描述须为 dict，收到 {type(data).__name__}"]
        violations: list[str] = []
        root = data.get("root")
        if not isinstance(root, dict):
            violations.append("界面描述缺 root（布局树根节点）")
        else:
            violations.extend(
                self._validate_node(
                    root,
                    path="root",
                    allowed_components=allowed_components,
                    allowed_channels=allowed_channels,
                )
            )
        for token in data.get("theme") or {}:
            if token not in allowed_theme_tokens:
                violations.append(
                    f"theme token 未声明: {token!r}（白名单 {allowed_theme_tokens}）"
                )
        return violations

    def validate_ok(
        self,
        data: dict[str, Any],
        *,
        allowed_components: tuple[str, ...] = (),
        allowed_channels: tuple[str, ...] = DEFAULT_BIND_CHANNELS,
        allowed_theme_tokens: tuple[str, ...] = (),
    ) -> bool:
        """布尔判定便捷入口（零违规 = True；闸门组装用）。"""
        return not self.validate(
            data,
            allowed_components=allowed_components,
            allowed_channels=allowed_channels,
            allowed_theme_tokens=allowed_theme_tokens,
        )

    def _validate_node(
        self,
        data: dict[str, Any],
        *,
        path: str,
        allowed_components: tuple[str, ...],
        allowed_channels: tuple[str, ...],
    ) -> list[str]:
        """单节点递归校验（违规带节点路径，可读可审计）。"""
        violations: list[str] = []
        kind = data.get("kind")
        type_name = data.get("type")
        if kind == NODE_KIND_COMPONENT:
            if type_name not in allowed_components:
                violations.append(
                    f"{path}.type 组件未注册: {type_name!r}（白名单 {allowed_components}）"
                )
            if data.get("children"):
                violations.append(f"{path} component 不允许携带 children")
        elif kind == NODE_KIND_CONTAINER:
            for index, child in enumerate(data.get("children") or []):
                violations.extend(
                    self._validate_node(
                        child,
                        path=f"{path}.children[{index}]",
                        allowed_components=allowed_components,
                        allowed_channels=allowed_channels,
                    )
                )
        else:
            violations.append(f"{path}.kind 非法: {kind!r}（仅 {_VALID_NODE_KINDS}）")
        raw_bind = data.get(BIND_KEY)
        if isinstance(raw_bind, dict):
            channel = raw_bind.get(BIND_CHANNEL_KEY)
            if channel not in allowed_channels:
                violations.append(
                    f"{path}.bind.channel 未放行: {channel!r}（白名单 {allowed_channels}）"
                )
            bind_path = raw_bind.get(BIND_PATH_KEY)
            if isinstance(bind_path, str):
                for segment in bind_path.split("."):
                    if segment.startswith(RESERVED_BIND_PREFIXES):
                        violations.append(
                            f"{path}.bind.path 命中保留前缀: {bind_path!r}（"
                            f"内部数据不可绑定，前缀 {RESERVED_BIND_PREFIXES}）"
                        )
                        break
        return violations


@runtime_checkable
class UIRenderer(Protocol):
    """界面渲染器接口（机制契约，实现归产品）：消费界面描述产出渲染结果。

    渲染器按界面名分发（boot 渲染器 = 默认实现），订阅绑定通道变更
    重渲绑定组件；实现可换（Vite/React 只是 boot 渲染器实现之一，
    框架可替换性在此落位）。
    """

    def render(self, spec: UISpec) -> Any: ...


__all__ = [
    "BIND_CHANNEL_KEY",
    "BIND_KEY",
    "BIND_PATH_KEY",
    "DEFAULT_BIND_CHANNELS",
    "NODE_KIND_COMPONENT",
    "NODE_KIND_CONTAINER",
    "RESERVED_BIND_PREFIXES",
    "UIBind",
    "UINode",
    "UIRenderer",
    "UISchemaValidator",
    "UISpec",
]
