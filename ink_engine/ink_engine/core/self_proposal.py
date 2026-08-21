"""自指层提案协议：补丁类型声明与按类型校验。

提案 = AI 修改产品形态的唯一入口形态（观察之后、应用之前）：先把
变更意图整理为声明式补丁（类型 + payload + 基准版本 + 理由），经
按类型校验确认形态合法，再交应用管线走审批分级与落链。本模块只
负责「把提案整理成可校验的数据」——应用、审批、回退在
``self_application``。

补丁类型（演化对象清单的声明式枚举）：界面/主题/工具/规则/知识/
harness/事件类型/环境/构建产物——每类复用引擎既有校验器（ui_schema
三层白名单、declarative_tools 定义期校验、rules 规则解析、
knowledge_set 条目构造、harness 注册期校验、event_types 声明构造、
environments 环境声明），零业务依赖、不发明第二套校验语义。

校验哲学：违规清单可读可审计（闸门失败原因直接展示）；未知字段
忽略（schema 演进宽容）；必填缺失 = 违规。

白名单审计：``PatchKind``（补丁类型集合）= **机制固有**——类型集合绑定
按类型校验分派（``_validate_{kind}``）；审批分级表 ``approval_levels``
（PatchKind → 分级）= **装配数据化**（宿主经配方数据注入）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from .declarative_tools import DeclarativeToolSpec
from .event_types import EventTypeSpec
from .exceptions import GraphDefinitionError
from .harness import HarnessDefinition
from .knowledge_set import KnowledgeEntry
from .registry import GraphRegistries
from .rules import Rule
from .schema_validator import SchemaSpec, SchemaValidator
from .ui_schema import DEFAULT_BIND_CHANNELS, UISchemaValidator

if TYPE_CHECKING:
    pass


class PatchKind(StrEnum):
    """补丁类型（演化对象清单：界面/主题/工具/规则/知识/harness/事件/环境/产物）。"""

    UI = "ui"
    THEME = "theme"
    TOOL = "tool"
    RULE = "rule"
    KNOWLEDGE = "knowledge"
    HARNESS = "harness"
    EVENT_TYPE = "event_type"
    ENVIRONMENT = "environment"
    ARTIFACT = "artifact"


# 产物哈希声明形态（sha256 hex，64 字符）
_ARTIFACT_HASH_LENGTH = 64

# 知识条目补丁的可选结构校验声明（缺省不校验 data 内部形态；
# 宿主可注入领域 schema 收紧）
_KNOWLEDGE_SCHEMA_FIELDS = (
    ("id", True, "string"),
    ("level", True, "string"),
    ("kind", True, "string"),
    ("title", False, "string"),
)


@dataclass(frozen=True, slots=True)
class SelfProposal:
    """一条演化提案（应用管线入口数据）。

    Attributes:
        kind: 补丁类型。
        payload: 补丁内容（按类型校验：ui/theme 走界面 schema，
            tool/rule/knowledge/harness/event_type/environment 走
            各自声明构造，artifact 走产物声明）。
        base_version: 提案时的集补丁链版本（应用时基准校验——基准
            不匹配 = 并发冲突，拒绝并要求基于最新态重提）。
        rationale: 提案理由（审批卡展示与审计留痕）。
        meta: 扩展元数据（来源/回合/请求方等，宿主语义）。
    """

    kind: PatchKind
    payload: dict[str, Any]
    base_version: int = 1
    rationale: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.kind, PatchKind):
            raise GraphDefinitionError(
                f"补丁类型非法: {self.kind!r}（仅 {[k.value for k in PatchKind]}）"
            )
        if not isinstance(self.payload, dict):
            raise GraphDefinitionError(
                f"补丁 {self.kind.value} 的 payload 须为 dict，"
                f"收到 {type(self.payload).__name__}"
            )
        if self.base_version < 1:
            raise GraphDefinitionError(
                f"补丁基准版本非法: {self.base_version}（须 ≥ 1）"
            )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "kind": self.kind.value,
            "payload": self.payload,
            "base_version": self.base_version,
        }
        if self.rationale:
            data["rationale"] = self.rationale
        if self.meta:
            data["meta"] = dict(self.meta)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> SelfProposal:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"提案声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        raw_kind = data.get("kind")
        try:
            kind = PatchKind(raw_kind)
        except ValueError as exc:
            raise GraphDefinitionError(f"补丁类型非法: {raw_kind!r}") from exc
        payload = data.get("payload")
        if not isinstance(payload, dict):
            raise GraphDefinitionError(
                f"补丁 {kind.value} 的 payload 须为 dict"
            )
        return cls(
            kind=kind,
            payload=payload,
            base_version=int(data.get("base_version") or 1),
            rationale=data.get("rationale") or "",
            meta=dict(data.get("meta") or {}),
        )


class ProposalValidator:
    """按补丁类型校验 payload（纯函数无状态，可作模块级复用）。

    校验器依赖注入（缺省 = 基线约束）：ui/theme 三层白名单、
    harness 的图注册表（graph 校验需要节点/边类型）、知识条目结构
    schema（缺省不校验 data 内部形态）。违规清单可读可审计。
    """

    def __init__(
        self,
        *,
        allowed_components: tuple[str, ...] = (),
        allowed_channels: tuple[str, ...] = DEFAULT_BIND_CHANNELS,
        allowed_theme_tokens: tuple[str, ...] = (),
        graph_registries: GraphRegistries | None = None,
        knowledge_schema: SchemaSpec | None = None,
    ) -> None:
        self._allowed_components = allowed_components
        self._allowed_channels = allowed_channels
        self._allowed_theme_tokens = allowed_theme_tokens
        self._registries = graph_registries or GraphRegistries()
        self._knowledge_schema = knowledge_schema
        self._ui_validator = UISchemaValidator()

    def validate(self, proposal: SelfProposal) -> list[str]:
        """校验一条提案：违规清单（空 = 通过）。

        校验语义（每类复用引擎既有校验器）：
        - ui：界面描述结构 + 组件/绑定通道/主题 token 三层白名单；
        - theme：主题 token 增量全部 ∈ 白名单；
        - tool：声明式工具定义构造即校验（权限/端点白名单缺声明拒绝）；
        - rule：规则声明解析校验；
        - knowledge：知识条目构造校验 + 可选结构 schema；
        - harness：图定义（validate=True）+ 工具定义 + 默认编排模板；
        - event_type：事件类型声明构造校验；
        - environment：环境声明构造校验；
        - artifact：产物声明结构校验（哈希形态）。
        """
        method = getattr(self, f"_validate_{proposal.kind.value}", None)
        if method is None:
            return [f"未知补丁类型: {proposal.kind.value!r}"]
        return method(proposal.payload)

    def validate_ok(self, proposal: SelfProposal) -> bool:
        """布尔判定便捷入口（零违规 = True；闸门组装用）。"""
        return not self.validate(proposal)

    def _violations(self, label: str, exc: GraphDefinitionError) -> list[str]:
        return [f"{label}: {exc}"]

    def _validate_ui(self, payload: dict[str, Any]) -> list[str]:
        spec = payload.get("spec")
        if not isinstance(spec, dict):
            return ["ui 补丁缺 spec（界面描述 dict）"]
        return self._ui_validator.validate(
            spec,
            allowed_components=self._allowed_components,
            allowed_channels=self._allowed_channels,
            allowed_theme_tokens=self._allowed_theme_tokens,
        )

    def _validate_theme(self, payload: dict[str, Any]) -> list[str]:
        tokens = payload.get("tokens")
        if not isinstance(tokens, dict):
            return ["theme 补丁缺 tokens（主题 token 增量 dict）"]
        violations = [
            f"theme token 未声明: {key!r}（白名单 {self._allowed_theme_tokens}）"
            for key in tokens
            if key not in self._allowed_theme_tokens
        ]
        return violations

    def _validate_tool(self, payload: dict[str, Any]) -> list[str]:
        try:
            DeclarativeToolSpec.from_dict(payload)
        except GraphDefinitionError as exc:
            return self._violations("tool 补丁非法", exc)
        return []

    def _validate_rule(self, payload: dict[str, Any]) -> list[str]:
        rule = payload.get("rule")
        if not isinstance(rule, dict):
            return ["rule 补丁缺 rule（规则声明 dict）"]
        try:
            Rule.from_dict(rule)
        except GraphDefinitionError as exc:
            return self._violations("rule 补丁非法", exc)
        return []

    def _validate_knowledge(self, payload: dict[str, Any]) -> list[str]:
        entry = payload.get("entry")
        if not isinstance(entry, dict):
            return ["knowledge 补丁缺 entry（知识条目 dict）"]
        try:
            KnowledgeEntry.from_dict(entry)
        except GraphDefinitionError as exc:
            return self._violations("knowledge 补丁非法", exc)
        # 最小结构校验（默认层）：仅过 from_dict 结构仍允许不可信 data 写入
        # 知识集——补齐最小形态闸门，收紧风险面。kind=rule 时 data 须含
        # dict 形态 rule 声明；其余 kind 仅要求 data 为 dict（保持宽松，
        # 宿主可经 _knowledge_schema 注入更强校验）。
        entry_kind = entry.get("kind")
        entry_data = entry.get("data")
        if entry_kind == "rule" and not isinstance(entry_data.get("rule"), dict):
            return ["knowledge 补丁 kind=rule 时 data 须含 dict 形态 rule 声明"]
        if not isinstance(entry_data, dict):
            return ["knowledge 补丁的 data 须为 dict"]
        if self._knowledge_schema is not None:
            return SchemaValidator().validate(self._knowledge_schema, entry)
        return []

    def _validate_harness(self, payload: dict[str, Any]) -> list[str]:
        definition = payload.get("definition")
        if not isinstance(definition, dict):
            return ["harness 补丁缺 definition（harness 声明 dict）"]
        try:
            parsed = HarnessDefinition.from_dict(definition)
            if parsed.graph is not None:
                from .graph import Graph

                Graph.from_dict(
                    parsed.graph,
                    registry=self._registries.nodes,
                    edge_registry=self._registries.edges,
                    validate=True,
                )
            for tool_data in parsed.tools:
                DeclarativeToolSpec.from_dict(tool_data)
            if parsed.default_plan is not None:
                from .plan import Plan

                Plan.parse(
                    parsed.default_plan,
                    graph=Graph.from_dict(
                        parsed.graph,
                        registry=self._registries.nodes,
                        edge_registry=self._registries.edges,
                        validate=True,
                    ),
                    edge_registry=self._registries.edges,
                    policy="loose",
                )
        except GraphDefinitionError as exc:
            return self._violations("harness 补丁非法", exc)
        return []

    def _validate_event_type(self, payload: dict[str, Any]) -> list[str]:
        try:
            parsed = EventTypeSpec.from_dict(payload)
        except GraphDefinitionError as exc:
            return self._violations("event_type 补丁非法", exc)
        # 新事件类型必须带渲染组件（渲染器引用）：无 renderer = 只能
        # 折叠展示，注册时显式拒绝（事件 → 组件映射的契约）；系统信号
        # 不入回合步骤序列（装配器合成 system_events 注入），豁免
        if not parsed.renderer and not parsed.system:
            return ["event_type 补丁须带 renderer（前端渲染组件引用）——"
                    "无渲染组件的事件只能折叠展示"]
        return []

    def _validate_environment(self, payload: dict[str, Any]) -> list[str]:
        from .environments import EnvironmentSpec

        try:
            EnvironmentSpec.from_dict(payload)
        except GraphDefinitionError as exc:
            return self._violations("environment 补丁非法", exc)
        return []

    def _validate_artifact(self, payload: dict[str, Any]) -> list[str]:
        artifact_id = payload.get("artifact_id")
        kind = payload.get("kind")
        hashes = payload.get("hashes")
        violations: list[str] = []
        if not artifact_id or not isinstance(artifact_id, str):
            violations.append("artifact 补丁缺 artifact_id（字符串）")
        if not kind or not isinstance(kind, str):
            violations.append("artifact 补丁缺 kind（字符串）")
        if not isinstance(hashes, dict):
            violations.append("artifact 补丁缺 hashes（文件 → sha256 dict）")
        else:
            for name, digest in hashes.items():
                if not isinstance(name, str) or not isinstance(digest, str):
                    violations.append(
                        f"artifact 哈希声明非法: {name!r} → {digest!r}"
                    )
                    continue
                if len(digest) != _ARTIFACT_HASH_LENGTH:
                    violations.append(
                        f"artifact 文件 {name} 的哈希须为 sha256 hex"
                        f"（{_ARTIFACT_HASH_LENGTH} 字符）: {digest!r}"
                    )
        return violations


__all__ = [
    "PatchKind",
    "ProposalValidator",
    "SelfProposal",
]
