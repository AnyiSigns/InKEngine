"""实体注册表（协作者目录：可复用、可演化的执行单元，EventTypeSpec 同构）。

实体 = 数据（EntitySpec：id/label/persona/model/meta），随补丁链版本化/回退
（PatchKind.ENTITY → propose_patch/apply_patch → 审批卡 → 注册表生效）。
运行 = 子图食谱经 spawn 物化为路径实例（宿主 collab_request 执行体职责）——
本模块只承载声明形态与注册表，机制层零执行语义、零领域词。

实体复用当前 agent 全部机制：
- 工具全量共享：无 tools 字段——常驻必带集（BASELINE_TOOL_NAMES）+ 检索
  动态注册（search_tools/request_tool），tool_pipeline 权限门禁不变；
- 模型按 model 引用（{provider, model_id}；None = 会话默认模型），窗口参数
  一律按该模型档案 context_window（不做档位推断）；
- persona 独立（每实体系统提示词不共用）；身份引导走每轮注入的参与者清单，
  Message.name 仅承担展示/留痕；
- 知识单份共享（KnowledgeSet 三级分层），实体不分割知识库。

配额：实体数量上限（防 AI 提案失控）；超限显式拒绝。持久化经 Storage
structured records 通道随集落库（集合级可演化资产，写入路径经补丁链）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .evolution_writer import DefaultEvolutionWriter, entity_writer
from .exceptions import GraphDefinitionError

if TYPE_CHECKING:
    from .storage import Storage

# 实体数量配额默认值（防 AI 提案失控；宿主可参数化）
DEFAULT_MAX_ENTITIES = 200

# 实体 id 长度上限（宽松标识符校验；与工具名同风格但不复用其下划线禁令）
ENTITY_ID_MAX_LENGTH = 48

# 按集隔离的集合名前缀（与 event_types:<set_id> / harness:<set_id> 同构）
ENTITIES_COLLECTION_PREFIX = "entities:"


def entity_collection(set_id: str) -> str:
    """实体集合名（按集隔离：``entities:<set_id>``）。"""
    return f"{ENTITIES_COLLECTION_PREFIX}{set_id}"


@dataclass(frozen=True, slots=True)
class EntitySpec:
    """实体声明（数据形态，随补丁链版本化/回退）。

    Attributes:
        id: 实体标识（注册表键；命名规则与工具名同源校验）。
        label: 展示名（Message.name / 审批卡 / 前端用）。
        persona: 独立系统提示词（每实体一份，不共用）。
        model: 模型引用（``{provider, model_id}``；None = 会话默认模型）。
        meta: 来源/版本/说明（审计留痕）。
    """

    id: str
    label: str = ""
    persona: str = ""
    model: dict[str, str] | None = None
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"id": self.id}
        if self.label:
            data["label"] = self.label
        if self.persona:
            data["persona"] = self.persona
        if self.model:
            data["model"] = dict(self.model)
        if self.meta:
            data["meta"] = dict(self.meta)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EntitySpec:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"实体声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        entity_id = data.get("id")
        if not entity_id or not isinstance(entity_id, str):
            raise GraphDefinitionError("实体声明缺 id（字符串）")
        violations = _validate_entity_id(entity_id)
        if violations:
            raise GraphDefinitionError(
                f"实体 id 命名非法 {entity_id!r}: {'；'.join(violations)}"
            )
        label = data.get("label")
        if label is not None and not isinstance(label, str):
            raise GraphDefinitionError(f"实体 {entity_id} 的 label 须为字符串")
        persona = data.get("persona")
        if persona is not None and not isinstance(persona, str):
            raise GraphDefinitionError(f"实体 {entity_id} 的 persona 须为字符串")
        model = data.get("model")
        if model is not None:
            if not isinstance(model, dict):
                raise GraphDefinitionError(f"实体 {entity_id} 的 model 须为 dict")
            cleaned = {str(k): str(v) for k, v in model.items() if v}
            model = cleaned or None
        meta = data.get("meta")
        if meta is not None and not isinstance(meta, dict):
            raise GraphDefinitionError(f"实体 {entity_id} 的 meta 须为 dict")
        return cls(
            id=entity_id,
            label=label or "",
            persona=persona or "",
            model=model,
            meta=dict(meta or {}),
        )


def _validate_entity_id(entity_id: str) -> list[str]:
    """实体 id 形态校验（宽松标识符：非空 / 长度有界 / 无空白与控制符）。

    允许字母/数字/下划线/连字符（协作者 id 常用下划线形态如
    ``security_reviewer``，不复用工具名的下划线禁令）；空白与控制字符
    一律拒绝（id 会被用作注册表键 / Message.name / 路由引用）。
    """
    violations: list[str] = []
    if len(entity_id) > ENTITY_ID_MAX_LENGTH:
        violations.append(f"实体 id 超长（>{ENTITY_ID_MAX_LENGTH} 字符）")
    if any(ch.isspace() or ord(ch) < 32 for ch in entity_id):
        violations.append("实体 id 不得含空白或控制字符")
    return violations


class EntityRegistry:
    """实体注册表（注册/查询/集内持久化，EventTypeRegistry 同构）。

    注册语义：
    - 重复注册显式拒绝（改实体 = 先废弃再注册，或走补丁链版本化）；
    - 实体数量配额（默认 DEFAULT_MAX_ENTITIES，可参数化）；
    - 声明形态在构造期校验（EntitySpec.from_dict 非法 = 拒绝注册）。
    """

    def __init__(
        self,
        *,
        storage: Storage | None = None,
        set_id: str = "-",
        max_entities: int = DEFAULT_MAX_ENTITIES,
    ) -> None:
        self._specs: dict[str, EntitySpec] = {}
        self._storage = storage
        self._set_id = set_id
        # 持久化集合按集隔离（entities:<set_id>）
        self._collection = entity_collection(set_id)
        self._max_entities = max_entities
        self._writer = DefaultEvolutionWriter(storage) if storage is not None else None

    @property
    def collection(self) -> str:
        """当前写入集合名（守卫豁免上下文按此名放行）。"""
        return self._collection

    def register(self, spec: EntitySpec) -> None:
        """登记实体（重复注册/配额超限显式拒绝）。"""
        if spec.id in self._specs:
            raise GraphDefinitionError(f"实体重复注册: {spec.id}")
        if len(self._specs) >= self._max_entities:
            raise GraphDefinitionError(
                f"实体数量已达配额上限（{self._max_entities}）: "
                "须合并/废弃既有实体后重提"
            )
        self._specs[spec.id] = spec

    def unregister(self, entity_id: str) -> None:
        """废弃实体（未注册 = 显式拒绝，不静默）。"""
        if entity_id not in self._specs:
            raise GraphDefinitionError(f"实体未注册: {entity_id}")
        del self._specs[entity_id]

    def replace(self, spec: EntitySpec) -> None:
        """整版替换实体（演化落位：变异/晋升后的新版本换入注册表）。

        演化语义与补丁链 REPLACE 对齐：旧版仍留链历史可回退，注册表只
        持有最新版。未注册 = 显式拒绝（演化不代创建——创建走审批卡）。
        """
        if spec.id not in self._specs:
            raise GraphDefinitionError(f"实体未注册（演化不代创建）: {spec.id}")
        self._specs[spec.id] = spec

    def get(self, entity_id: str) -> EntitySpec | None:
        """按 id 取实体（未注册 = None；宽松语义不抛错）。"""
        return self._specs.get(entity_id)

    def names(self) -> tuple[str, ...]:
        """已注册实体 id（按注册序稳定）。"""
        return tuple(self._specs)

    def specs(self) -> tuple[EntitySpec, ...]:
        """已注册实体声明（按注册序稳定）。"""
        return tuple(self._specs.values())

    async def load(self) -> int:
        """从存储加载集内实体（启动装配调用；无存储 = 空注册表）。

        脏记录跳过不阻断启动（回放不崩原则：坏实体跳过，不拦启动）。
        """
        if self._storage is None:
            return 0
        loaded = 0
        for record in await self._storage.list_records(self._collection):
            entity_id = record.get("id")
            if not entity_id or entity_id in self._specs:
                continue
            try:
                spec = EntitySpec.from_dict(record)
            except GraphDefinitionError:
                continue
            self._specs[entity_id] = spec
            loaded += 1
        return loaded

    async def save(self) -> None:
        """全量落库（注册/废弃后由宿主调用；无存储 = 跳过）。

        写入经 EvolutionWriter 管线（补丁链 + 审计留痕三重闸门）。
        """
        if self._storage is None or self._writer is None:
            return
        for spec in self._specs.values():
            await entity_writer(
                self._writer,
                self._collection,
                spec.id,
                spec.to_dict(),
                note="registry_save",
            )


__all__ = [
    "DEFAULT_MAX_ENTITIES",
    "ENTITIES_COLLECTION_PREFIX",
    "ENTITY_ID_MAX_LENGTH",
    "EntityRegistry",
    "EntitySpec",
    "entity_collection",
]
