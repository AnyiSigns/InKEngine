"""世界状态模型层：实体数据类 + 世界状态图容器。

零宿主依赖：不 import 任何 TextForge 业务模块，也不依赖 ORM——
落库、检索、外部服务调用由宿主实现并经接口注入。
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field, replace
from typing import Any

from ink_engine.novel_harness.narrative_state import (
    ACTOR_AGENT,
    ACTOR_SYSTEM,
    STATUS_SET,
    is_illegal_transition,
)

logger = logging.getLogger(__name__)

# 变更日志类型（world.changes 的 kind 取值）
CHANGE_CHARACTER = "character"
CHANGE_KNOWLEDGE = "knowledge"
CHANGE_EVENT = "event"
CHANGE_CAUSAL = "causal_link"
CHANGE_FORESHADOWING = "foreshadowing"
CHANGE_BRANCH = "branch"


def _key(value: str | int) -> str:
    """实体 id 归一化为字典键（int/str 统一，防 1 与 "1" 双键漂移）。"""
    return str(value)


@dataclass(frozen=True, slots=True)
class CharacterFingerprint:
    """角色行为档案量化（言行偏离度校验基准）。

    Attributes:
        personality: 性格维度 → 强度（0-1），如 {"沉稳": 0.9, "冲动": 0.2}。
        catchphrases: 口头禅清单（角色身份标识，供一致性校验）。
        taboos: 禁忌言行（角色绝不会做的表述，命中即偏离提示）。
    """

    personality: dict[str, float] = field(default_factory=dict)
    catchphrases: tuple[str, ...] = ()
    taboos: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class RelationshipState:
    """角色关系向量（有向：本角色 → 目标角色）。

    Attributes:
        target_id: 目标角色 id。
        kind: 关系类型（师姐妹/敌对/师徒等）。
        strength: 关系强度（0-1，越高越亲密/越敌对视 kind 而定）。
        changed_at_chapter: 关系变化发生的章节（留痕）。
    """

    target_id: str
    kind: str
    strength: float = 0.5
    changed_at_chapter: int = 0


@dataclass(frozen=True, slots=True)
class CharacterState:
    """角色状态机快照（粒度方案 A：只建模创作关键状态）。

    Attributes:
        character_id: 角色 id（int/str 统一归一为 str 存键）。
        name: 角色名。
        location: 当前位置。
        health: 健康状态。
        goals: 当前目标列表。
        relationships: 关系向量（target_id → 关系）。
        fingerprint: 行为档案（可选，供指纹校验）。
        updated_at_chapter: 最近一次状态更新的章节（留痕）。
    """

    character_id: str
    name: str
    location: str | None = None
    health: str | None = None
    goals: tuple[str, ...] = ()
    relationships: dict[str, RelationshipState] = field(default_factory=dict)
    fingerprint: CharacterFingerprint | None = None
    updated_at_chapter: int = 0


@dataclass(frozen=True, slots=True)
class KnowledgeEntry:
    """知识矩阵条目：角色在何时知道什么。

    Attributes:
        character_id: 知晓该事实的角色 id。
        fact_id: 事实标识（真相/秘密/身份的稳定键）。
        known_at_chapter: 自该章起知晓（信息差查询的时间基准）。
        source: 来源（observed 亲见 / told 被告知 / inferred 推断）。
        note: 备注（可选）。
    """

    character_id: str
    fact_id: str
    known_at_chapter: int
    source: str = "observed"
    note: str = ""


@dataclass(frozen=True, slots=True)
class CausalEvent:
    """因果链事件节点。

    Attributes:
        event_id: 事件 id（跨章追踪锚点）。
        chapter_id: 发生章节（None=未落章/大纲期）。
        summary: 事件摘要（后果校验/涟漪展示用）。
    """

    event_id: str
    chapter_id: int | None = None
    summary: str = ""


@dataclass(frozen=True, slots=True)
class CausalLink:
    """因果链后果边：cause 事件 → effect 事件。

    跨章追踪语义：cause 第 N 章的后果在 effect 所在章节体现；
    effect 章节不得早于 cause 章节（后果先于原因即逻辑倒置）。
    """

    cause_event_id: str
    effect_event_id: str
    note: str = ""


@dataclass(frozen=True, slots=True)
class ForeshadowingNode:
    """伏笔矩阵节点（叙事状态机的泛化：互引/回收链合法性）。

    Attributes:
        foreshadowing_id: 伏笔 id。
        description: 伏笔描述。
        status: 叙事状态（set/advancing/resolved/stalled，复用枚举）。
        planted_at_chapter: 埋设章节（回收链前提）。
        resolved_at_chapter: 回收章节（None=未回收）。
        references: 互引的其他伏笔 id（回收链依赖：回收本伏笔要求
            依赖的伏笔已埋设——不能先回收 B 再埋 A）。
    """

    foreshadowing_id: str
    description: str = ""
    status: str = STATUS_SET
    planted_at_chapter: int | None = None
    resolved_at_chapter: int | None = None
    references: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class WorldStateChange:
    """一条世界状态变更（append-only 日志，回溯/审计用）。

    Attributes:
        kind: 变更类型（character/knowledge/event/causal_link/foreshadowing/branch）。
        at_chapter: 触发章节（None=无章节上下文）。
        actor: 触发方（agent/user/system/precheck）。
        detail: 变更说明。
        payload: 结构化变更明细（落库序列化）。
    """

    kind: str
    at_chapter: int | None = None
    actor: str = ACTOR_SYSTEM
    detail: str = ""
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class WorldState:
    """世界状态图：角色状态机 + 知识矩阵 + 因果链 + 伏笔矩阵。

    心智模型与补丁链一致：**变更 = append-only 日志，当前状态 = 最后应用
    结果**——:attr:`changes` 记录每次写操作，分支 = 深拷贝分叉。

    落库边界：本类为纯内存模型，:meth:`to_dict` 输出 JSON 兼容 dict 供宿主
    持久化；SQLAlchemy 落库与 derived_sync 派生同步由宿主承接。
    """

    characters: dict[str, CharacterState] = field(default_factory=dict)
    knowledge: dict[str, list[KnowledgeEntry]] = field(default_factory=dict)
    events: dict[str, CausalEvent] = field(default_factory=dict)
    causal_links: list[CausalLink] = field(default_factory=list)
    foreshadowings: dict[str, ForeshadowingNode] = field(default_factory=dict)
    changes: list[WorldStateChange] = field(default_factory=list)

    # -- 变更日志 -----------------------------------------------------------

    def record_change(
        self,
        kind: str,
        *,
        at_chapter: int | None = None,
        actor: str = ACTOR_SYSTEM,
        detail: str = "",
        payload: dict[str, Any] | None = None,
    ) -> None:
        """追加一条变更日志（append-only，回溯/审计）。"""
        self.changes.append(
            WorldStateChange(
                kind=kind,
                at_chapter=at_chapter,
                actor=actor,
                detail=detail,
                payload=dict(payload or {}),
            )
        )

    # -- 角色状态机 ----------------------------------------------------------

    def get_character(self, character_id: str | int) -> CharacterState | None:
        return self.characters.get(_key(character_id))

    def set_character(
        self,
        state: CharacterState,
        *,
        at_chapter: int | None = None,
        actor: str = ACTOR_AGENT,
    ) -> CharacterState:
        """写入/覆盖角色状态（整份快照，含行为档案）。"""
        key = _key(state.character_id)
        self.characters[key] = state
        self.record_change(
            CHANGE_CHARACTER,
            at_chapter=at_chapter,
            actor=actor,
            detail=f"角色「{state.name}」状态更新",
            payload={"character_id": key},
        )
        return state

    def update_character(
        self,
        character_id: str | int,
        *,
        location: str | None = None,
        health: str | None = None,
        goals: tuple[str, ...] | None = None,
        relationships: tuple[RelationshipState, ...] | None = None,
        fingerprint: CharacterFingerprint | None = None,
        at_chapter: int | None = None,
        actor: str = ACTOR_AGENT,
    ) -> CharacterState | None:
        """部分更新角色状态（未提供的字段保持不变；角色不存在返回 None）。

        用于写工具落库时的确定性更新：位置/健康/目标/关系按结构化变更
        直接应用，随后可经校验层检查（best-effort 提取 + 校验的落地形态）。
        """
        current = self.get_character(character_id)
        if current is None:
            return None
        rels = dict(current.relationships)
        if relationships:
            for rel in relationships:
                rels[_key(rel.target_id)] = rel
        updated = CharacterState(
            character_id=current.character_id,
            name=current.name,
            location=current.location if location is None else location,
            health=current.health if health is None else health,
            goals=current.goals if goals is None else goals,
            relationships=rels,
            fingerprint=current.fingerprint if fingerprint is None else fingerprint,
            updated_at_chapter=at_chapter if at_chapter is not None else current.updated_at_chapter,
        )
        return self.set_character(updated, at_chapter=at_chapter, actor=actor)

    # -- 知识矩阵 ------------------------------------------------------------

    def character_knows(
        self,
        character_id: str | int,
        fact_id: str,
        at_chapter: int | None = None,
    ) -> bool:
        """角色在指定章节（含）是否已知某事实（无章节 = 任意时间）。"""
        for entry in self.knowledge.get(_key(character_id), []):
            if entry.fact_id == fact_id and (
                at_chapter is None or entry.known_at_chapter <= at_chapter
            ):
                return True
        return False

    def add_knowledge(
        self,
        entry: KnowledgeEntry,
        *,
        actor: str = ACTOR_AGENT,
    ) -> bool:
        """追加知识矩阵条目。

        幂等语义：同角色同事实**只登记一条**（知识只会早不会晚）——
        已登记章的知晓时间不得倒退；更早登记（known_at 更小）时回填
        条目而非追加重复行（重复行会让信息差视图失真）。
        """
        key = _key(entry.character_id)
        existing = self.knowledge.get(key, [])
        for i, e in enumerate(existing):
            if e.fact_id == entry.fact_id:
                if entry.known_at_chapter < e.known_at_chapter:
                    # 更早知晓：回填（知识只会早不会晚，单条记录向前修正）
                    existing[i] = replace(
                        e, known_at_chapter=entry.known_at_chapter
                    )
                    self.record_change(
                        CHANGE_KNOWLEDGE,
                        at_chapter=entry.known_at_chapter,
                        actor=actor,
                        detail=f"角色[{key}] 知晓事实 {entry.fact_id}（知晓章回填至第{entry.known_at_chapter}章）",
                        payload={"character_id": key, "fact_id": entry.fact_id},
                    )
                return False
        self.knowledge.setdefault(key, []).append(entry)
        self.record_change(
            CHANGE_KNOWLEDGE,
            at_chapter=entry.known_at_chapter,
            actor=actor,
            detail=f"角色[{key}] 知晓事实 {entry.fact_id}",
            payload={"character_id": key, "fact_id": entry.fact_id},
        )
        return True

    # -- 因果链 --------------------------------------------------------------

    def get_event(self, event_id: str | int) -> CausalEvent | None:
        return self.events.get(_key(event_id))

    def add_event(self, event: CausalEvent, *, actor: str = ACTOR_AGENT) -> CausalEvent:
        """写入事件节点（按 event_id 幂等覆盖）。"""
        key = _key(event.event_id)
        self.events[key] = event
        self.record_change(
            CHANGE_EVENT,
            at_chapter=event.chapter_id,
            actor=actor,
            detail=f"事件[{key}] {event.summary or ''}",
            payload={"event_id": key},
        )
        return event

    def link_causality(
        self,
        cause_event_id: str | int,
        effect_event_id: str | int,
        *,
        note: str = "",
        actor: str = ACTOR_AGENT,
    ) -> CausalLink | None:
        """追加因果后果边（cause → effect）。

        两端事件都必须已存在（悬空引用会破坏跨章追踪，宁可拒绝不静默
        落脏数据）；同对因果重复链接时幂等跳过。
        """
        cause_key = _key(cause_event_id)
        effect_key = _key(effect_event_id)
        if cause_key not in self.events or effect_key not in self.events:
            logger.warning(
                f"[world_state] 因果边被忽略，事件不存在: {cause_key} -> {effect_key}"
            )
            return None
        pair = (cause_key, effect_key)
        if any(
            (link.cause_event_id, link.effect_event_id) == pair
            for link in self.causal_links
        ):
            return None
        link = CausalLink(cause_event_id=cause_key, effect_event_id=effect_key, note=note)
        self.causal_links.append(link)
        self.record_change(
            CHANGE_CAUSAL,
            actor=actor,
            detail=f"因果链 {cause_key} -> {effect_key}",
            payload={"cause": cause_key, "effect": effect_key},
        )
        return link

    # -- 伏笔矩阵 ------------------------------------------------------------

    def get_foreshadowing(self, foreshadowing_id: str | int) -> ForeshadowingNode | None:
        return self.foreshadowings.get(_key(foreshadowing_id))

    def upsert_foreshadowing(
        self,
        node: ForeshadowingNode,
        *,
        actor: str = ACTOR_AGENT,
    ) -> ForeshadowingNode | None:
        """写入/合并伏笔节点（按 id 覆盖；终态不可逆规则在写时拒绝）。

        终态规则接线（narrative_state.is_illegal_transition）：resolved 为
        终态，回收后不得回退为埋设/推进/停滞——写时拒绝并留痕，防规则
        只在校验层事后被动报告、违例仍落库。
        """
        key = _key(node.foreshadowing_id)
        current = self.foreshadowings.get(key)
        if current is not None and is_illegal_transition(current.status, node.status):
            logger.warning(
                f"[world_state] 伏笔状态非法迁移被拒绝: {key} "
                f"{current.status!r} -> {node.status!r}（resolved 为终态不得回退）"
            )
            return None
        self.foreshadowings[key] = node
        self.record_change(
            CHANGE_FORESHADOWING,
            at_chapter=node.resolved_at_chapter or node.planted_at_chapter,
            actor=actor,
            detail=f"伏笔[{key}] 状态 {node.status}",
            payload={"foreshadowing_id": key, "status": node.status},
        )
        return node

    # -- 序列化 ---------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 兼容 dict（宿主落库/分支拷贝的载体）。"""
        return {
            "characters": {
                k: {
                    "character_id": c.character_id,
                    "name": c.name,
                    "location": c.location,
                    "health": c.health,
                    "goals": list(c.goals),
                    "relationships": {
                        rk: {
                            "target_id": r.target_id,
                            "kind": r.kind,
                            "strength": r.strength,
                            "changed_at_chapter": r.changed_at_chapter,
                        }
                        for rk, r in c.relationships.items()
                    },
                    "fingerprint": (
                        {
                            "personality": dict(c.fingerprint.personality),
                            "catchphrases": list(c.fingerprint.catchphrases),
                            "taboos": list(c.fingerprint.taboos),
                        }
                        if c.fingerprint
                        else None
                    ),
                    "updated_at_chapter": c.updated_at_chapter,
                }
                for k, c in self.characters.items()
            },
            "knowledge": {
                ck: [asdict(e) for e in entries]
                for ck, entries in self.knowledge.items()
            },
            "events": {
                ek: {"event_id": e.event_id, "chapter_id": e.chapter_id, "summary": e.summary}
                for ek, e in self.events.items()
            },
            "causal_links": [
                {
                    "cause_event_id": link.cause_event_id,
                    "effect_event_id": link.effect_event_id,
                    "note": link.note,
                }
                for link in self.causal_links
            ],
            "foreshadowings": {
                fk: {
                    "foreshadowing_id": f.foreshadowing_id,
                    "description": f.description,
                    "status": f.status,
                    "planted_at_chapter": f.planted_at_chapter,
                    "resolved_at_chapter": f.resolved_at_chapter,
                    "references": list(f.references),
                }
                for fk, f in self.foreshadowings.items()
            },
            "changes": [asdict(c) for c in self.changes],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> WorldState:
        """从序列化 dict 还原（字段缺失走默认值，兼容 schema 增量演进）。"""
        characters: dict[str, CharacterState] = {}
        for key, raw in (data.get("characters") or {}).items():
            raw = raw or {}
            rels = {
                rk: RelationshipState(
                    target_id=str(r.get("target_id", rk)),
                    kind=str(r.get("kind", "")),
                    strength=float(r.get("strength", 0.5)),
                    changed_at_chapter=int(r.get("changed_at_chapter", 0)),
                )
                for rk, r in (raw.get("relationships") or {}).items()
            }
            fp_raw = raw.get("fingerprint")
            fingerprint = None
            if isinstance(fp_raw, dict):
                fingerprint = CharacterFingerprint(
                    personality={k: float(v) for k, v in (fp_raw.get("personality") or {}).items()},
                    catchphrases=tuple(fp_raw.get("catchphrases") or ()),
                    taboos=tuple(fp_raw.get("taboos") or ()),
                )
            characters[str(key)] = CharacterState(
                character_id=str(raw.get("character_id", key)),
                name=str(raw.get("name", "")),
                location=raw.get("location"),
                health=raw.get("health"),
                goals=tuple(raw.get("goals") or ()),
                relationships=rels,
                fingerprint=fingerprint,
                updated_at_chapter=int(raw.get("updated_at_chapter", 0)),
            )
        knowledge: dict[str, list[KnowledgeEntry]] = {}
        for ck, entries in (data.get("knowledge") or {}).items():
            knowledge[str(ck)] = [
                KnowledgeEntry(
                    character_id=str(e.get("character_id", ck)),
                    fact_id=str(e.get("fact_id", "")),
                    known_at_chapter=int(e.get("known_at_chapter", 0)),
                    source=str(e.get("source", "observed")),
                    note=str(e.get("note", "")),
                )
                for e in entries
                if isinstance(e, dict)
            ]
        events = {
            str(ek): CausalEvent(
                event_id=str(e.get("event_id", ek)),
                chapter_id=e.get("chapter_id"),
                summary=str(e.get("summary", "")),
            )
            for ek, e in (data.get("events") or {}).items()
            if isinstance(e, dict)
        }
        causal_links = [
            CausalLink(
                cause_event_id=str(link.get("cause_event_id", "")),
                effect_event_id=str(link.get("effect_event_id", "")),
                note=str(link.get("note", "")),
            )
            for link in data.get("causal_links") or []
            if isinstance(link, dict)
        ]
        foreshadowings = {
            str(fk): ForeshadowingNode(
                foreshadowing_id=str(f.get("foreshadowing_id", fk)),
                description=str(f.get("description", "")),
                status=str(f.get("status", STATUS_SET)),
                planted_at_chapter=f.get("planted_at_chapter"),
                resolved_at_chapter=f.get("resolved_at_chapter"),
                references=tuple(f.get("references") or ()),
            )
            for fk, f in (data.get("foreshadowings") or {}).items()
            if isinstance(f, dict)
        }
        changes = [
            WorldStateChange(
                kind=str(c.get("kind", "")),
                at_chapter=c.get("at_chapter"),
                actor=str(c.get("actor", ACTOR_SYSTEM)),
                detail=str(c.get("detail", "")),
                payload=dict(c.get("payload") or {}),
            )
            for c in data.get("changes") or []
            if isinstance(c, dict)
        ]
        return cls(
            characters=characters,
            knowledge=knowledge,
            events=events,
            causal_links=causal_links,
            foreshadowings=foreshadowings,
            changes=changes,
        )

    def branch(self) -> WorldState:
        """深拷贝分叉（What-if 平行宇宙：与主线并存，互不影响）。"""
        return WorldState.from_dict(self.to_dict())


__all__ = [
    "CHANGE_BRANCH",
    "CHANGE_CAUSAL",
    "CHANGE_CHARACTER",
    "CHANGE_EVENT",
    "CHANGE_FORESHADOWING",
    "CHANGE_KNOWLEDGE",
    "CausalEvent",
    "CausalLink",
    "CharacterFingerprint",
    "CharacterState",
    "ForeshadowingNode",
    "KnowledgeEntry",
    "RelationshipState",
    "WorldState",
    "WorldStateChange",
]
