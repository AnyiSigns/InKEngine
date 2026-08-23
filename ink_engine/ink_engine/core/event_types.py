"""事件类型注册表（事件后门的正式载体：类型是数据，AI 可演化）。

事件信封是机制（EngineEvent 外层字段稳定），事件类型是数据——AI
提案新事件类型 = 生成 EventTypeSpec（声明式数据，随补丁链）+ 前端
渲染组件（代码挂载，②层），审批后注册，发射即渲染。注册表补上后，
事件模型从「任意字符串零闸门」变为「AI 可演化的类型系统」。

发射侧策略：未注册类型宽松允许 + 折叠兜底——不阻断执行、回放不崩，
与现有任意字符串发射兼容；注册表是增强不是收紧（新类型注册 = 更
清晰渲染，未注册 = 折叠显示原始 JSON）。回放按事件产生时的 schema
版本校验，新版本注册不影响历史事件回放（直播 = 回放不变）。

system 标记：系统信号（不入回合步骤序列）注册后由装配器合成
RunOptions.system_events 注入，与 events.py 的 SYSTEM_EVENTS 机制
对齐（模块级常量默认空，注册表是动态化的正式载体）。

配额：类型数量上限（防 AI 提案失控）；超限显式拒绝，须合并/废弃
既有类型后重提。持久化经 Storage structured records 通道随集落库
（集合级可演化资产，写入路径由宿主接线补丁链）。

白名单审计：事件渲染器名 = **装配数据化**——EventTypeSpec.renderer 是
数据字段（前端组件引用），引擎无渲染器名清单、无白名单校验；事件
类型经注册表数据化演化（补丁链版本化/回退）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .exceptions import GraphDefinitionError
from .schema_validator import SchemaSpec, SchemaValidator

if TYPE_CHECKING:
    from .storage import Storage

# 发射判定状态（声明式枚举，防魔法字符串）
EVENT_STATUS_REGISTERED = "registered"
EVENT_STATUS_UNKNOWN = "unknown"

# 事件类型数量配额默认值（防 AI 提案失控；宿主可参数化）
DEFAULT_MAX_EVENT_TYPES = 200

# 附件事件类别默认名（宿主装配引用；渲染器为数据字段，宿主端映射）
DEFAULT_ATTACHMENT_EVENT_NAME = "attachment"
DEFAULT_ATTACHMENT_RENDERER = "AttachmentRow"

# 集合级持久化通道（structured records 集合名）
_COLLECTION_EVENT_TYPES = "event_types"


@dataclass(frozen=True, slots=True)
class EventTypeSpec:
    """事件类型声明（数据形态，随补丁链版本化/回退）。

    Attributes:
        name: 事件类型名（发射时与 EngineEvent.type 匹配）。
        schema: payload 校验声明（SchemaSpec；None = 不校验 payload 形态）。
        renderer: 前端组件引用（事件 → 组件映射；空 = 只能折叠展示）。
        system: 系统信号（注册后由装配器合成 RunOptions.system_events 注入）。
        meta: 来源/版本/说明（审计留痕）。
    """

    name: str
    schema: SchemaSpec | None = None
    renderer: str = ""
    system: bool = False
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"name": self.name, "system": self.system}
        if self.schema is not None:
            data["schema"] = self.schema.to_dict()
        if self.renderer:
            data["renderer"] = self.renderer
        if self.meta:
            data["meta"] = dict(self.meta)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EventTypeSpec:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"事件类型声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        if not name or not isinstance(name, str):
            raise GraphDefinitionError("事件类型声明缺 name（字符串）")
        raw_schema = data.get("schema")
        schema = SchemaSpec.from_dict(raw_schema) if raw_schema is not None else None
        renderer = data.get("renderer")
        if renderer is not None and not isinstance(renderer, str):
            raise GraphDefinitionError(f"事件类型 {name} 的 renderer 须为字符串")
        meta = data.get("meta")
        if meta is not None and not isinstance(meta, dict):
            raise GraphDefinitionError(f"事件类型 {name} 的 meta 须为 dict")
        return cls(
            name=name,
            schema=schema,
            renderer=renderer or "",
            system=bool(data.get("system", False)),
            meta=dict(meta or {}),
        )


@dataclass(frozen=True, slots=True)
class EventVerdict:
    """发射判定结果（注册表分类 + schema 违规 + 折叠标记）。

    Attributes:
        status: 类型状态（registered 已注册 / unknown 未注册）。
        violations: payload 校验违规清单（空 = 通过；宽松允许不阻断）。
        fold: 是否折叠展示（未知类型或 renderer 缺失 = 折叠原始 JSON）。
    """

    status: str
    violations: tuple[str, ...] = ()
    fold: bool = False


def attachment_event_spec(
    *,
    name: str = DEFAULT_ATTACHMENT_EVENT_NAME,
    renderer: str = DEFAULT_ATTACHMENT_RENDERER,
) -> EventTypeSpec:
    """附件事件类别声明（宿主装配配方可直接引用；纯新增类别）。

    附件事件负载为宿主/前端协商形态（元数据 dict，随消息附件一起
    出现），不作 schema 约束——事件类型是数据（AI 可演化），基线
    只登记类别与渲染器引用；宿主可按产品需要以同名注册自定义 schema。
    """
    return EventTypeSpec(
        name=name,
        schema=None,
        renderer=renderer,
        system=False,
        meta={"purpose": "attachment"},
    )


class EventTypeRegistry:
    """事件类型注册表（注册/校验/分类/合成 system_events + 随集持久化）。

    注册语义：
    - 重复注册显式拒绝（改类型 = 先废弃再注册，或走补丁链版本化）；
    - 类型数量配额（默认 DEFAULT_MAX_EVENT_TYPES，可参数化）；
    - schema 声明在注册期解析校验（SchemaSpec 非法 = 拒绝注册）。
    发射语义（classify）：宽松允许——未注册类型不阻断、已注册类型
    schema 违规仅标记（宿主可决定告警/拦截/留痕）；折叠标记供前端
    兜底渲染。
    """

    def __init__(
        self,
        *,
        storage: Storage | None = None,
        set_id: str = "-",
        max_types: int = DEFAULT_MAX_EVENT_TYPES,
    ) -> None:
        self._specs: dict[str, EventTypeSpec] = {}
        self._storage = storage
        self._set_id = set_id
        self._max_types = max_types

    def register(self, spec: EventTypeSpec) -> None:
        """登记类型（重复注册/配额超限显式拒绝，schema 非法在构造期已拦截）。"""
        if spec.name in self._specs:
            raise GraphDefinitionError(f"事件类型重复注册: {spec.name}")
        if len(self._specs) >= self._max_types:
            raise GraphDefinitionError(
                f"事件类型数量已达配额上限（{self._max_types}）: "
                "须合并/废弃既有类型后重提"
            )
        self._specs[spec.name] = spec

    def unregister(self, name: str) -> None:
        """废弃类型（未注册 = 显式拒绝，不静默）。"""
        if name not in self._specs:
            raise GraphDefinitionError(f"事件类型未注册: {name}")
        del self._specs[name]

    def get(self, name: str) -> EventTypeSpec | None:
        """按名取类型（未注册 = None；宽松语义不抛错）。"""
        return self._specs.get(name)

    def names(self) -> tuple[str, ...]:
        """已注册类型名（按注册序稳定）。"""
        return tuple(self._specs)

    def specs(self) -> tuple[EventTypeSpec, ...]:
        """已注册类型声明（按注册序稳定）。"""
        return tuple(self._specs.values())

    def classify(self, etype: str, payload: dict[str, Any]) -> EventVerdict:
        """发射判定：未注册宽松允许 + 折叠兜底；已注册校验 schema（宽松标记）。

        判定结果只读，不阻断发射——注册表是增强不是收紧；宿主按
        verdict 决定告警/留痕/折叠渲染。
        """
        spec = self._specs.get(etype)
        if spec is None:
            return EventVerdict(status=EVENT_STATUS_UNKNOWN, fold=True)
        violations: list[str] = []
        if spec.schema is not None:
            violations = SchemaValidator().validate(spec.schema, payload)
        return EventVerdict(
            status=EVENT_STATUS_REGISTERED,
            violations=tuple(violations),
            fold=not bool(spec.renderer),
        )

    def system_events(self) -> frozenset[str]:
        """合成系统信号集合（装配器注入 RunOptions.system_events 用）。"""
        return frozenset(name for name, spec in self._specs.items() if spec.system)

    async def load(self) -> int:
        """从存储加载集内事件类型（启动装配调用；无存储 = 空注册表）。

        脏记录跳过不阻断启动（回放不崩原则：坏类型折叠显示，不拦启动）。
        """
        if self._storage is None:
            return 0
        loaded = 0
        for record in await self._storage.list_records(_COLLECTION_EVENT_TYPES):
            name = record.get("name")
            if not name or name in self._specs:
                continue
            try:
                spec = EventTypeSpec.from_dict(record)
            except GraphDefinitionError:
                continue
            self._specs[name] = spec
            loaded += 1
        return loaded

    async def save(self) -> None:
        """全量落库（注册/废弃后由宿主调用；无存储 = 跳过）。"""
        if self._storage is None:
            return
        for spec in self._specs.values():
            await self._storage.put_record(
                _COLLECTION_EVENT_TYPES, spec.name, spec.to_dict()
            )


__all__ = [
    "DEFAULT_ATTACHMENT_EVENT_NAME",
    "DEFAULT_ATTACHMENT_RENDERER",
    "DEFAULT_MAX_EVENT_TYPES",
    "EVENT_STATUS_REGISTERED",
    "EVENT_STATUS_UNKNOWN",
    "EventTypeRegistry",
    "EventTypeSpec",
    "EventVerdict",
    "attachment_event_spec",
]
