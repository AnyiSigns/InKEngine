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
from .schema_validator import (
    FIELD_NUMBER,
    FIELD_STRING,
    SchemaField,
    SchemaSpec,
    SchemaValidator,
)

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

# 集合级持久化通道（structured records 集合名）。
# 历史遗留名（无 set_id）：多集共享同一存储时会互相串数据——新写入按集
# 隔离（见 :func:`event_types_collection`），此名仅作旧数据读兼容保留。
_COLLECTION_EVENT_TYPES = "event_types"

# 按集隔离的集合名前缀（与 knowledge:<user_id> / harness:<set_id> 同构）
EVENT_TYPES_COLLECTION_PREFIX = "event_types:"


def event_types_collection(set_id: str) -> str:
    """事件类型集合名（按集隔离：``event_types:<set_id>``）。

    与 ``knowledge:<user_id>`` 同构——多集共享存储时演化类型互不串数据。
    旧数据落在无 set_id 的 ``event_types`` 集合：:meth:`EventTypeRegistry.load`
    保留读回退（读到即在下次 :meth:`save` 时写入按集集合，惰性迁移），
    写入一律进按集集合。
    """
    return f"{EVENT_TYPES_COLLECTION_PREFIX}{set_id}"


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


# ── 审计事件类型（append-only 审计统一出口；类型是数据，随补丁链
# 版本化。本模块只注册类型声明，事件由使用方在对应时机产出）──

# 组装留痕（候选边/选中路径/评分证据的登记）
EVENT_AUDIT_ASSEMBLY = "assembly_audit"
# 组装候选留痕（只读组装产出的候选计划登记——观察出口：出候选供观察/审计）
EVENT_ASSEMBLY_CANDIDATE = "assembly_candidate"
# 汇流裁决留痕（胜者/败者/裁决理由）
EVENT_AUDIT_JUNCTION = "junction_verdict_audit"
# 指纹顶替留痕（旧条目失效与新条目落位）
EVENT_AUDIT_FINGERPRINT_REPLACE = "fingerprint_replace_audit"
# 策略边复审留痕（对抗证据触发复审/降级）
EVENT_AUDIT_POLICY_REVIEW = "policy_edge_review_audit"
# 推荐先验自动晋升留痕（高强度证据路径自动晋升为推荐先验，免人工拍板）
EVENT_AUDIT_PROMOTION = "recommended_prior_promotion"

# 审计事件负载的公共字段（schema 声明复用：时间戳/域/指纹等）
_AUDIT_TS = SchemaField(name="ts", required=False, kind=FIELD_NUMBER)
_AUDIT_DOMAIN = SchemaField(name="domain", required=True, kind=FIELD_STRING)
_AUDIT_FINGERPRINT = SchemaField(name="fingerprint", required=False, kind=FIELD_STRING)


def audit_event_specs() -> tuple[EventTypeSpec, ...]:
    """审计事件类型声明（注册表注册用；类型是数据可演化）。

    组装/汇流裁决/指纹顶替/策略边复审 + 推荐先验晋升五类留痕入
    ``event_types`` 注册表——append-only 审计统一出口，不散落宿主
    自造事件（晋升通道来自设计文档第十一节第六节的自动生长机制，为新增的第五类）。
    """
    return (
        EventTypeSpec(
            name=EVENT_AUDIT_ASSEMBLY,
            schema=SchemaSpec(
                name="audit.assembly",
                fields=(_AUDIT_TS, _AUDIT_DOMAIN, _AUDIT_FINGERPRINT),
            ),
            meta={"purpose": "audit"},
        ),
        EventTypeSpec(
            name=EVENT_AUDIT_JUNCTION,
            schema=SchemaSpec(
                name="audit.junction",
                fields=(_AUDIT_TS, _AUDIT_DOMAIN),
            ),
            meta={"purpose": "audit"},
        ),
        EventTypeSpec(
            name=EVENT_AUDIT_FINGERPRINT_REPLACE,
            schema=SchemaSpec(
                name="audit.fingerprint_replace",
                fields=(_AUDIT_TS, _AUDIT_DOMAIN, _AUDIT_FINGERPRINT),
            ),
            meta={"purpose": "audit"},
        ),
        EventTypeSpec(
            name=EVENT_AUDIT_POLICY_REVIEW,
            schema=SchemaSpec(
                name="audit.policy_review",
                fields=(_AUDIT_TS, _AUDIT_DOMAIN),
            ),
            meta={"purpose": "audit"},
        ),
        EventTypeSpec(
            name=EVENT_AUDIT_PROMOTION,
            schema=SchemaSpec(
                name="audit.promotion",
                fields=(_AUDIT_TS, _AUDIT_DOMAIN),
            ),
            meta={"purpose": "audit"},
        ),
    )


def register_audit_event_types(registry: EventTypeRegistry) -> None:
    """把四类审计事件类型注册进注册表（重复注册显式拒绝语义由注册表保证）。"""
    for spec in audit_event_specs():
        registry.register(spec)


def assembly_candidate_event_spec() -> EventTypeSpec:
    """组装候选留痕事件类型声明（观察出口：候选计划登记；类型是数据）。

    只读组装的产物 = 候选计划（只观察不执行）；事件负载 = 审计记录
    （时间戳/域/指纹 + 候选清单，历史图定义快照随记录落库——类型只
    登记约束骨架，extras 字段由 SchemaValidator 宽容放行）。
    """
    return EventTypeSpec(
        name=EVENT_ASSEMBLY_CANDIDATE,
        schema=SchemaSpec(
            name="audit.assembly_candidate",
            fields=(_AUDIT_TS, _AUDIT_DOMAIN, _AUDIT_FINGERPRINT),
        ),
        meta={"purpose": "audit"},
    )


def register_path_assembly_event_types(registry: EventTypeRegistry) -> None:
    """把组装候选留痕事件类型注册进注册表（重复注册由注册表显式拒绝）。"""
    registry.register(assembly_candidate_event_spec())


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
        # 持久化集合按集隔离（event_types:<set_id>）；历史集合只读兼容
        self._collection = event_types_collection(set_id)
        self._max_types = max_types

    @property
    def collection(self) -> str:
        """当前写入集合名（守卫豁免上下文按此名放行）。"""
        return self._collection

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

        读取顺序 = 按集集合（``event_types:<set_id>``）→ 历史集合
        （``event_types``，只读兼容：旧库数据不丢；重名以按集记录为准）。
        脏记录跳过不阻断启动（回放不崩原则：坏类型折叠显示，不拦启动）。
        """
        if self._storage is None:
            return 0
        loaded = 0
        for collection in (self._collection, _COLLECTION_EVENT_TYPES):
            for record in await self._storage.list_records(collection):
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
        """全量落库（注册/废弃后由宿主调用；无存储 = 跳过）。

        只写按集集合：历史集合的旧记录经 :meth:`load` 读入后随本次写入
        落进按集集合（惰性迁移），旧记录原地保留不删除。
        """
        if self._storage is None:
            return
        for spec in self._specs.values():
            await self._storage.put_record(
                self._collection, spec.name, spec.to_dict()
            )


__all__ = [
    "DEFAULT_ATTACHMENT_EVENT_NAME",
    "DEFAULT_ATTACHMENT_RENDERER",
    "DEFAULT_MAX_EVENT_TYPES",
    "EVENT_ASSEMBLY_CANDIDATE",
    "EVENT_AUDIT_ASSEMBLY",
    "EVENT_AUDIT_FINGERPRINT_REPLACE",
    "EVENT_AUDIT_JUNCTION",
    "EVENT_AUDIT_POLICY_REVIEW",
    "EVENT_STATUS_REGISTERED",
    "EVENT_STATUS_UNKNOWN",
    "EVENT_TYPES_COLLECTION_PREFIX",
    "EventTypeRegistry",
    "EventTypeSpec",
    "EventVerdict",
    "assembly_candidate_event_spec",
    "attachment_event_spec",
    "audit_event_specs",
    "event_types_collection",
    "register_audit_event_types",
    "register_path_assembly_event_types",
]
