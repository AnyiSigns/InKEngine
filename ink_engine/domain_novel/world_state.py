"""世界状态层（D8）：创作关键状态的显式数据层。

把创作关键状态从 LLM 隐式上下文移出为引擎可追踪/校验/查询的显式数据——
**世界状态图** = 角色状态机 + 知识矩阵 + 因果链 + 伏笔矩阵：

- **角色状态机**：只显式建模关键状态（位置/健康/关系/目标），琐碎状态
  （穿着等）留给 LLM 隐式携带，防建模爆炸（粒度方案 A）；
- **知识矩阵**：追踪"角色在何时知道什么"，支撑信息差查询
  （"此刻女二是否知道真相"——防上帝视角泄漏）；
- **因果链**：事件节点 + 后果边，跨章追踪（第 3 章事件的后果在第 23 章
  是否体现）；
- **伏笔矩阵**：D6 叙事状态机的泛化——伏笔互引/回收链合法性
  （不能先回收 B 再埋 A）。

本模块提供四类原语：

1. **模型**：:class:`WorldState` 世界状态图 + 各实体数据类（可序列化落库）；
2. **状态更新**：确定性更新（结构化变更直接应用）+ LLM 提取
   （:class:`StateChangeExtractor`，best-effort，失败不阻断主流程）；
3. **写时校验**：:class:`WorldIssue` 统一问题模型 + 确定性规则
   （信息差/因果链/伏笔合法性/指纹禁忌）+ LLM 指纹判定钩子
   （:class:`FingerprintVerifier`，宿主可注册实现）；
4. **操作层**：涟漪扫描（:func:`scan_ripple` 输出需修订清单）+
   What-if 分支（:func:`branch_world_state` + :func:`compare_world_states`）。

**补丁链统一**：每次写操作 = 一条 :class:`WorldStateChange`（append-only），
当前状态 = 最后应用结果，分支 = 深拷贝分叉——回溯/回滚/分支语义与引擎
补丁链一致。

零宿主依赖：本模块不 import 任何 TextForge 业务模块，也不依赖 ORM——
落库、检索、外部服务调用由宿主实现并经接口注入。
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol, runtime_checkable

from ink_engine.domain_novel.narrative_state import (
    ACTOR_AGENT,
    ACTOR_PRECHECK,
    ACTOR_SYSTEM,
    ACTOR_USER,
    STATUS_SET,
    is_valid_status,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# 变更日志类型（world.changes 的 kind 取值）
CHANGE_CHARACTER = "character"
CHANGE_KNOWLEDGE = "knowledge"
CHANGE_EVENT = "event"
CHANGE_CAUSAL = "causal_link"
CHANGE_FORESHADOWING = "foreshadowing"
CHANGE_BRANCH = "branch"

# 校验问题严重度（error=硬冲突需裁决 / warning=提示级）
SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"

# 校验问题类型（WorldIssue.kind）
ISSUE_KNOWLEDGE_GAP = "knowledge_gap"
ISSUE_CAUSAL = "causal_chain"
ISSUE_FORESHADOWING = "foreshadowing_chain"
ISSUE_FINGERPRINT = "fingerprint"

# LLM 提取护栏（防长文/大上下文撑爆请求与解析）
_MAX_TEXT_CHARS = 4000
_MAX_CONTEXT_CHARS = 1500
_MAX_JSON_ITEMS = 30

def _key(value: str | int) -> str:
    """实体 id 归一化为字典键（int/str 统一，防 1 与 "1" 双键漂移）。"""
    return str(value)


# ---------------------------------------------------------------------------
# 状态模型（不可变记录，可序列化落库）
# ---------------------------------------------------------------------------


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
    """伏笔矩阵节点（D6 叙事状态机的泛化：互引/回收链合法性）。

    Attributes:
        foreshadowing_id: 伏笔 id。
        description: 伏笔描述。
        status: 叙事状态（set/advancing/resolved/stalled，复用 D6 枚举）。
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


# ---------------------------------------------------------------------------
# 世界状态图（容器 + 变更原语 + 序列化）
# ---------------------------------------------------------------------------


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

        幂等语义：同角色同事实已登记（且知晓章不晚于本次）时跳过——
        知识只会早不会晚，重复登记可能把"第 5 章已知"倒退成"第 8 章已知"。
        """
        key = _key(entry.character_id)
        existing = self.knowledge.get(key, [])
        for e in existing:
            if e.fact_id == entry.fact_id and e.known_at_chapter <= entry.known_at_chapter:
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
    ) -> ForeshadowingNode:
        """写入/合并伏笔节点（按 id 覆盖；合法性由校验层判定）。"""
        key = _key(node.foreshadowing_id)
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


# ---------------------------------------------------------------------------
# 状态更新提取（确定性更新 + LLM best-effort）
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CharacterUpdate:
    """角色状态结构化变更（确定性更新的载荷）。

    Attributes:
        character_id: 目标角色 id。
        location: 新位置（None=不更新）。
        health: 新健康状态（None=不更新）。
        goals: 新目标列表（None=不更新）。
        relationships: 新关系（追加/覆盖，None=不更新）。
        fingerprint: 行为档案（None=不更新）。
    """

    character_id: str
    location: str | None = None
    health: str | None = None
    goals: tuple[str, ...] | None = None
    relationships: tuple[RelationshipState, ...] | None = None
    fingerprint: CharacterFingerprint | None = None


@dataclass(frozen=True, slots=True)
class KnowledgeGain:
    """知识矩阵新增条目（角色首次知晓某事实）。"""

    character_id: str
    fact_id: str
    source: str = "observed"
    note: str = ""


@dataclass(frozen=True, slots=True)
class ForeshadowingUpdate:
    """伏笔状态推进（写工具/LLM 提取的状态变更）。"""

    foreshadowing_id: str
    status: str
    description: str = ""


@dataclass(slots=True)
class ExtractedStateChanges:
    """一次状态提取的完整结果（确定性规则或 LLM 产出，待应用）。

    events/causal_links 由提取方产出（事件按摘要去重，因果边引用事件 id）；
    应用经 :func:`apply_state_changes` 落进 :class:`WorldState`。
    """

    character_updates: list[CharacterUpdate] = field(default_factory=list)
    knowledge_gains: list[KnowledgeGain] = field(default_factory=list)
    events: list[CausalEvent] = field(default_factory=list)
    causal_links: list[CausalLink] = field(default_factory=list)
    foreshadowing_updates: list[ForeshadowingUpdate] = field(default_factory=list)


@runtime_checkable
class StateChangeExtractor(Protocol):
    """状态提取器接口：从正文/结构化输入提取世界状态变更。

    实现约定：
    - 提取是 best-effort 增强，失败必须返回空变更（或由调用方兜底），
      不得抛错阻断主流程；
    - 返回的变更随后经 :func:`apply_state_changes` 应用（含校验拦截）。
    """

    async def extract(
        self,
        text: str,
        *,
        world: WorldState,
        chapter_id: int | None = None,
        context: dict[str, Any] | None = None,
    ) -> ExtractedStateChanges: ...


# ---------------------------------------------------------------------------
# LLM 状态提取器（默认实现，提示词可覆盖）
# ---------------------------------------------------------------------------

# 提取提示词：输出 JSON，字段可缺省；未知角色/伏笔返回空（保守不创造实体）
_DEFAULT_EXTRACT_PROMPT = """你是小说世界状态提取器。从正文中提取世界状态变更，只输出一个 JSON 对象：
{{
  "character_updates": [{{"character_id": "角色id（必须是已知角色）", "location": "位置或null", "health": "健康或null", "goals": ["目标"]}}],
  "knowledge_gains": [{{"character_id": "角色id", "fact_id": "事实标识", "source": "observed/told/inferred"}}],
  "events": [{{"event_id": "事件id", "summary": "事件摘要"}}],
  "causal_links": [{{"cause_event_id": "原因事件id", "effect_event_id": "后果事件id", "note": "说明"}}],
  "foreshadowing_updates": [{{"foreshadowing_id": "伏笔id", "status": "set/advancing/resolved/stalled"}}]
}}

规则：
- 只列正文中明确体现的变更，不确定就不列（保守提取，宁缺毋滥）；
- 角色/事件/伏笔 id 必须来自给定世界状态，不得自造未知 id；
- knowledge_gains 只列角色此刻新得知的事实（此前未知的）；
- events 事件 id 可新造（无 id 则给稳定摘要）；
- 因果边两端必须都是已知事件。

【当前世界状态】
{context}

【章节正文】
{text}"""


def _extract_json(text: str) -> dict | None:
    """从模型输出中提取 JSON 对象（正则取首个 {...} 块，解析失败返回 None）。"""
    if not text or not text.strip():
        return None
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def parse_extracted_changes(text: str) -> ExtractedStateChanges:
    """把提取器模型输出解析为 ExtractedStateChanges（纯函数，可单测）。

    解析失败返回空变更（fail-open：提取是增强项，不阻断写流程）。
    """
    data = _extract_json(text)
    if data is None:
        return ExtractedStateChanges()
    result = ExtractedStateChanges()
    for item in (data.get("character_updates") or [])[:_MAX_JSON_ITEMS]:
        if not isinstance(item, dict):
            continue
        cid = str(item.get("character_id") or "").strip()
        if not cid:
            continue
        goals_raw = item.get("goals")
        goals = tuple(str(g) for g in goals_raw) if isinstance(goals_raw, list) else None
        result.character_updates.append(
            CharacterUpdate(
                character_id=cid,
                location=item.get("location"),
                health=item.get("health"),
                goals=goals,
            )
        )
    for item in (data.get("knowledge_gains") or [])[:_MAX_JSON_ITEMS]:
        if not isinstance(item, dict):
            continue
        cid = str(item.get("character_id") or "").strip()
        fid = str(item.get("fact_id") or "").strip()
        if cid and fid:
            result.knowledge_gains.append(
                KnowledgeGain(
                    character_id=cid,
                    fact_id=fid,
                    source=str(item.get("source") or "observed"),
                    note=str(item.get("note") or ""),
                )
            )
    for item in (data.get("events") or [])[:_MAX_JSON_ITEMS]:
        if not isinstance(item, dict):
            continue
        eid = str(item.get("event_id") or "").strip()
        if not eid:
            continue
        result.events.append(
            CausalEvent(
                event_id=eid,
                chapter_id=item.get("chapter_id"),
                summary=str(item.get("summary") or ""),
            )
        )
    for item in (data.get("causal_links") or [])[:_MAX_JSON_ITEMS]:
        if not isinstance(item, dict):
            continue
        cause = str(item.get("cause_event_id") or "").strip()
        effect = str(item.get("effect_event_id") or "").strip()
        if cause and effect:
            result.causal_links.append(
                CausalLink(cause_event_id=cause, effect_event_id=effect, note=str(item.get("note") or ""))
            )
    for item in (data.get("foreshadowing_updates") or [])[:_MAX_JSON_ITEMS]:
        if not isinstance(item, dict):
            continue
        fid = str(item.get("foreshadowing_id") or "").strip()
        status = str(item.get("status") or "").strip()
        if fid and status:
            result.foreshadowing_updates.append(
                ForeshadowingUpdate(foreshadowing_id=fid, status=status, description=str(item.get("description") or ""))
            )
    return result


class LLMStateChangeExtractor:
    """LLM 驱动的状态提取器（默认实现，best-effort）。

    从正文提取角色状态变更/知识新增/事件/因果边/伏笔推进；调用失败或
    解析失败返回空变更（不抛错，不阻断写流程）。LLM 依赖经构造参数注入，
    提示词可整体覆盖（复用者面向自身场景定制）。

    Args:
        llm: 任意支持 ``ainvoke(messages) -> LLMResult`` 的对象
            （AsyncLLM / ModelChain / 测试替身）。
        prompt: 提取提示词模板（覆盖默认模板；需含 ``{context}``/``{text}`` 占位）。
        max_text_chars: 正文送入提示词的截断上限（护栏）。
        max_context_chars: 世界状态上下文截断上限（护栏）。
    """

    def __init__(
        self,
        llm: Any,
        *,
        prompt: str | None = None,
        max_text_chars: int = _MAX_TEXT_CHARS,
        max_context_chars: int = _MAX_CONTEXT_CHARS,
    ) -> None:
        self._llm = llm
        self._prompt = prompt or _DEFAULT_EXTRACT_PROMPT
        self._max_text_chars = max_text_chars
        self._max_context_chars = max_context_chars

    def _build_context(self, world: WorldState) -> str:
        """世界状态上下文摘要（角色/事件/伏笔，护栏内截断）。"""
        parts: list[str] = []
        chars = [f"{c.name}(id={c.character_id}, 位置={c.location or '?'})" for c in world.characters.values()]
        if chars:
            parts.append("角色: " + "、".join(chars))
        events = [f"{e.summary or e.event_id}(id={e.event_id})" for e in world.events.values()]
        if events:
            parts.append("事件: " + "、".join(events))
        fores = [
            f"{f.description or f.foreshadowing_id}(id={f.foreshadowing_id}, {f.status})"
            for f in world.foreshadowings.values()
        ]
        if fores:
            parts.append("伏笔: " + "、".join(fores))
        context = "；".join(parts)
        return context[: self._max_context_chars] or "（空）"

    async def extract(
        self,
        text: str,
        *,
        world: WorldState,
        chapter_id: int | None = None,
        context: dict[str, Any] | None = None,
    ) -> ExtractedStateChanges:
        """提取状态变更；任何异常返回空变更（fail-open）。"""
        prompt = self._prompt.format(
            context=self._build_context(world), text=text[: self._max_text_chars]
        )
        from ink_engine.core.llm.messages import system, user

        try:
            result = await self._llm.ainvoke([system(prompt), user("请提取世界状态变更。")])
        except Exception as exc:
            logger.warning(f"[world_state] LLM 状态提取失败（忽略）: {exc}")
            return ExtractedStateChanges()
        output = getattr(result, "content", None)
        output = str(output or "")
        if not output.strip():
            return ExtractedStateChanges()
        return parse_extracted_changes(output)


# ---------------------------------------------------------------------------
# 变更应用原语（确定性更新：结构化变更 → 世界状态）
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ApplyResult:
    """一次状态变更应用的结果留痕。

    Attributes:
        applied: 成功应用的变更数。
        skipped: 被跳过/拒绝的原因列表（含未应用内容，可读留痕）。
        issues: 应用过程中触发的校验问题（结构约束/合法性）。
    """

    applied: int = 0
    skipped: list[str] = field(default_factory=list)
    issues: list[WorldIssue] = field(default_factory=list)


def apply_state_changes(
    world: WorldState,
    changes: ExtractedStateChanges,
    *,
    at_chapter: int | None = None,
    actor: str = ACTOR_AGENT,
) -> ApplyResult:
    """把提取的状态变更应用到世界状态（确定性更新原语）。

    应用顺序：角色 → 知识 → 事件 → 因果边 → 伏笔。每步带结构约束：

    - 角色/知识/伏笔更新引用未知实体 → 跳过并留痕（LLM 常自造 id，
      保守不创造实体，宁缺毋滥）；
    - 因果边引用不存在事件 → 拒绝（悬空边会破坏跨章追踪）；
    - 伏笔状态非法 → 拒绝（复用 D6 状态机枚举校验）。

    任何一步失败都不影响其余变更应用（部分成功语义）。
    """
    result = ApplyResult()
    for upd in changes.character_updates:
        if world.update_character(
            upd.character_id,
            location=upd.location,
            health=upd.health,
            goals=upd.goals,
            relationships=upd.relationships,
            fingerprint=upd.fingerprint,
            at_chapter=at_chapter,
            actor=actor,
        ):
            result.applied += 1
        else:
            result.skipped.append(f"角色 {upd.character_id} 不存在，忽略状态更新")
    for gain in changes.knowledge_gains:
        if not world.character_knows(gain.character_id, gain.fact_id, at_chapter):
            if world.get_character(gain.character_id) is not None:
                world.add_knowledge(
                    KnowledgeEntry(
                        character_id=gain.character_id,
                        fact_id=gain.fact_id,
                        known_at_chapter=at_chapter or 0,
                        source=gain.source,
                        note=gain.note,
                    ),
                    actor=actor,
                )
                result.applied += 1
            else:
                result.skipped.append(f"角色 {gain.character_id} 不存在，忽略知识登记")
        else:
            result.skipped.append(f"角色 {gain.character_id} 已知事实 {gain.fact_id}，跳过")
    for event in changes.events:
        world.add_event(event, actor=actor)
        result.applied += 1
    for link in changes.causal_links:
        created = world.link_causality(link.cause_event_id, link.effect_event_id, note=link.note, actor=actor)
        if created:
            result.applied += 1
        else:
            result.skipped.append(f"因果边 {link.cause_event_id}->{link.effect_event_id} 拒绝（事件缺失或重复）")
    for upd in changes.foreshadowing_updates:
        node = world.get_foreshadowing(upd.foreshadowing_id)
        if node is None:
            result.skipped.append(f"伏笔 {upd.foreshadowing_id} 不存在，忽略状态推进")
            continue
        if not is_valid_status(upd.status):
            result.skipped.append(f"伏笔 {upd.foreshadowing_id} 状态 {upd.status!r} 非法，忽略")
            continue
        world.upsert_foreshadowing(
            ForeshadowingNode(
                foreshadowing_id=node.foreshadowing_id,
                description=upd.description or node.description,
                status=upd.status,
                planted_at_chapter=node.planted_at_chapter,
                resolved_at_chapter=node.resolved_at_chapter,
                references=node.references,
            ),
            actor=actor,
        )
        result.applied += 1
    return result


# ---------------------------------------------------------------------------
# 写时校验原语（确定性规则 + LLM 判定钩子）
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class WorldIssue:
    """写时校验问题（审核卡 conflicts 字段的可序列化单元）。

    Attributes:
        kind: 问题类型（knowledge_gap/causal_chain/foreshadowing_chain/fingerprint）。
        severity: error=硬冲突（建议弹卡裁决）/ warning=提示级。
        message: 人类可读的冲突说明。
        entity_type: 关联实体类型（character/foreshadowing/event 等）。
        entity_id: 关联实体 id。
    """

    kind: str
    severity: str
    message: str
    entity_type: str | None = None
    entity_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "message": self.message,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
        }


def has_hard_conflict(issues: list[WorldIssue]) -> bool:
    """是否存在需用户裁决的硬冲突（error 级）。"""
    return any(i.severity == SEVERITY_ERROR for i in issues)


def check_knowledge_gap(
    world: WorldState,
    character_id: str | int,
    fact_ids: list[str],
    *,
    at_chapter: int | None = None,
) -> list[WorldIssue]:
    """信息差校验：该角色此刻是否不该知道这些事实（防上帝视角泄漏）。

    正文/设定若让角色显露出某事实的知情，而知识矩阵尚无该角色在此时点
    的知晓记录 → error 硬冲突（悬疑/多 POV 场景的核心泄漏点）。
    """
    issues: list[WorldIssue] = []
    key = _key(character_id)
    for fact_id in fact_ids:
        if not world.character_knows(key, fact_id, at_chapter):
            when = f"第 {at_chapter} 章" if at_chapter is not None else "当前"
            issues.append(
                WorldIssue(
                    kind=ISSUE_KNOWLEDGE_GAP,
                    severity=SEVERITY_ERROR,
                    message=f"角色[{key}] 在{when}尚不知晓「{fact_id}」，正文提前泄漏",
                    entity_type="character",
                    entity_id=key,
                )
            )
    return issues


def validate_causal_chain(world: WorldState) -> list[WorldIssue]:
    """因果链校验：悬空引用 + 后果早于原因。

    确定性规则（零 LLM）：
    1. 因果边两端事件必须存在（悬空边 = 跨章追踪断链）；
    2. effect 章节不得早于 cause 章节（后果先于原因 = 逻辑倒置）。
    """
    issues: list[WorldIssue] = []
    seen_pairs: set[tuple[str, str]] = set()
    for link in world.causal_links:
        pair = (link.cause_event_id, link.effect_event_id)
        if pair in seen_pairs:
            issues.append(
                WorldIssue(
                    kind=ISSUE_CAUSAL,
                    severity=SEVERITY_WARNING,
                    message=f"因果边 {pair[0]}->{pair[1]} 重复登记",
                    entity_type="event",
                    entity_id=pair[1],
                )
            )
            continue
        seen_pairs.add(pair)
        cause = world.get_event(link.cause_event_id)
        effect = world.get_event(link.effect_event_id)
        if cause is None or effect is None:
            missing = link.cause_event_id if cause is None else link.effect_event_id
            issues.append(
                WorldIssue(
                    kind=ISSUE_CAUSAL,
                    severity=SEVERITY_ERROR,
                    message=f"因果边引用了不存在的事件: {missing}",
                    entity_type="event",
                    entity_id=missing,
                )
            )
            continue
        if (
            cause.chapter_id is not None
            and effect.chapter_id is not None
            and effect.chapter_id < cause.chapter_id
        ):
            issues.append(
                WorldIssue(
                    kind=ISSUE_CAUSAL,
                    severity=SEVERITY_ERROR,
                    message=(
                        f"后果早于原因：事件 {link.cause_event_id}（第 {cause.chapter_id} 章）"
                        f"的后果不可能在第 {effect.chapter_id} 章体现"
                    ),
                    entity_type="event",
                    entity_id=link.effect_event_id,
                )
            )
    return issues


def validate_foreshadowing_chain(world: WorldState) -> list[WorldIssue]:
    """伏笔矩阵校验：状态合法性 + 回收链合法性（D6 泛化）。

    确定性规则：
    1. 状态必须是叙事状态机枚举（非法枚举 = 数据污染）；
    2. 已回收（resolved）必须已埋设（planted_at_chapter 非空）且回收不早于埋设
       ——未埋设即回收违反伏笔链；
    3. 互引（references）：回收本伏笔要求依赖的伏笔已埋设且不晚于本伏笔回收
       ——不能先回收 B 再埋 A。
    """
    issues: list[WorldIssue] = []
    for node in world.foreshadowings.values():
        key = node.foreshadowing_id
        if not is_valid_status(node.status):
            issues.append(
                WorldIssue(
                    kind=ISSUE_FORESHADOWING,
                    severity=SEVERITY_ERROR,
                    message=f"伏笔[{key}] 状态 {node.status!r} 不是合法叙事状态",
                    entity_type="foreshadowing",
                    entity_id=key,
                )
            )
            continue
        if node.status == "resolved":
            if node.planted_at_chapter is None:
                issues.append(
                    WorldIssue(
                        kind=ISSUE_FORESHADOWING,
                        severity=SEVERITY_ERROR,
                        message=f"伏笔[{key}] 已回收但无埋设记录（未埋设即回收）",
                        entity_type="foreshadowing",
                        entity_id=key,
                    )
                )
            elif (
                node.resolved_at_chapter is not None
                and node.resolved_at_chapter < node.planted_at_chapter
            ):
                issues.append(
                    WorldIssue(
                        kind=ISSUE_FORESHADOWING,
                        severity=SEVERITY_ERROR,
                        message=(
                            f"伏笔[{key}] 回收章（第 {node.resolved_at_chapter} 章）"
                            f"早于埋设章（第 {node.planted_at_chapter} 章）"
                        ),
                        entity_type="foreshadowing",
                        entity_id=key,
                    )
                )
        for ref in node.references:
            ref_node = world.get_foreshadowing(ref)
            if ref_node is None:
                issues.append(
                    WorldIssue(
                        kind=ISSUE_FORESHADOWING,
                        severity=SEVERITY_ERROR,
                        message=f"伏笔[{key}] 互引了不存在的伏笔[{ref}]",
                        entity_type="foreshadowing",
                        entity_id=ref,
                    )
                )
                continue
            if node.status == "resolved" and node.resolved_at_chapter is not None:
                if ref_node.planted_at_chapter is None:
                    issues.append(
                        WorldIssue(
                            kind=ISSUE_FORESHADOWING,
                            severity=SEVERITY_ERROR,
                            message=f"伏笔[{key}] 已回收，但依赖的伏笔[{ref}] 尚未埋设",
                            entity_type="foreshadowing",
                            entity_id=ref,
                        )
                    )
                elif ref_node.planted_at_chapter > node.resolved_at_chapter:
                    issues.append(
                        WorldIssue(
                            kind=ISSUE_FORESHADOWING,
                            severity=SEVERITY_ERROR,
                            message=(
                                f"伏笔[{key}] 回收前依赖的伏笔[{ref}] 才在"
                                f"第 {ref_node.planted_at_chapter} 章埋设（先回收 B 再埋 A）"
                            ),
                            entity_type="foreshadowing",
                            entity_id=ref,
                        )
                    )
    return issues


def check_fingerprint_taboos(
    fingerprint: CharacterFingerprint,
    text: str,
    *,
    character_name: str = "",
) -> list[WorldIssue]:
    """角色指纹禁忌校验（确定性规则）：正文命中行为档案禁忌词。

    性格维度/口头禅的偏离判定依赖语义理解，由 LLM 钩子
    （:class:`FingerprintVerifier`）承接；本函数只做确定性禁忌词命中。
    """
    issues: list[WorldIssue] = []
    label = f"角色「{character_name}」" if character_name else "该角色"
    for taboo in fingerprint.taboos:
        if taboo and taboo in text:
            issues.append(
                WorldIssue(
                    kind=ISSUE_FINGERPRINT,
                    severity=SEVERITY_WARNING,
                    message=f"{label}正文出现禁忌表述「{taboo}」（言行偏离行为档案）",
                    entity_type="character",
                )
            )
    return issues


@runtime_checkable
class FingerprintVerifier(Protocol):
    """角色指纹 LLM 判定钩子（言行偏离度，宿主/评审器可注册实现）。

    实现约定：对给定角色的行为档案与正文产出偏离问题；失败返回空列表
    （best-effort，不阻断写流程）。
    """

    async def verify(
        self,
        fingerprint: CharacterFingerprint,
        text: str,
        *,
        character_name: str = "",
        context: dict[str, Any] | None = None,
    ) -> list[WorldIssue]: ...


async def run_world_precheck(
    world: WorldState,
    *,
    text: str = "",
    character_id: str | int | None = None,
    fact_ids: list[str] | None = None,
    at_chapter: int | None = None,
    verifier: FingerprintVerifier | None = None,
) -> list[WorldIssue]:
    """写时预检完整流程（确定性规则 + 可选 LLM 指纹判定）。

    组合执行：因果链校验 + 伏笔回收链校验（全书级）+ 信息差校验（指定角色
    事实）+ 指纹禁忌/LLM 判定（正文 + 行为档案）。所有校验 fail-open：
    预检异常跳过该环节，不阻断写操作。

    Args:
        world: 当前世界状态。
        text: 待检正文（指纹校验输入）。
        character_id: 信息差/指纹校验的目标角色。
        fact_ids: 正文让角色显露出知情的事实列表（信息差输入）。
        at_chapter: 当前章节（信息差时间基准）。
        verifier: 可选的 LLM 指纹判定钩子。

    Returns:
        校验问题列表（dict 形态见 :meth:`WorldIssue.to_dict`，可直接消费）。
    """
    issues: list[WorldIssue] = []
    issues.extend(validate_causal_chain(world))
    issues.extend(validate_foreshadowing_chain(world))
    if character_id is not None and fact_ids:
        issues.extend(check_knowledge_gap(world, character_id, fact_ids, at_chapter=at_chapter))
    if character_id is not None and text:
        char = world.get_character(character_id)
        if char is not None and char.fingerprint is not None:
            issues.extend(
                check_fingerprint_taboos(char.fingerprint, text, character_name=char.name)
            )
            if verifier is not None:
                try:
                    issues.extend(
                        await verifier.verify(
                            char.fingerprint,
                            text,
                            character_name=char.name,
                        )
                    )
                except Exception as exc:
                    logger.warning(f"[world_state] 指纹 LLM 判定失败（跳过）: {exc}")
    return issues


# ---------------------------------------------------------------------------
# 涟漪效应扫描（Ripple Scanner：改设定 → 全书需修订清单）
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SettingChange:
    """一次设定变更（涟漪扫描输入）。

    Attributes:
        entity_id: 变更实体 id。
        entity_type: 实体类型（character/location 等）。
        field: 变更的字段名（age/location/name 等；None=实体整体变更）。
        old_value: 旧值（展示用）。
        new_value: 新值（展示用）。
    """

    entity_id: str
    entity_type: str
    field: str | None = None
    old_value: str = ""
    new_value: str = ""


@dataclass(frozen=True, slots=True)
class EntityReference:
    """正文中一处实体引用（引用索引条目，宿主扫描章节文本构建）。

    Attributes:
        entity_id: 引用实体 id。
        entity_type: 实体类型。
        chapter_id: 所在章节。
        paragraph_index: 段内序号（0 起，可空）。
        excerpt: 命中片段（展示/跳转用）。
        field: 该处引用涉及的字段（None=泛引用，无法判定是否受影响）。
    """

    entity_id: str
    entity_type: str
    chapter_id: int
    paragraph_index: int | None = None
    excerpt: str = ""
    field: str | None = None


@dataclass(frozen=True, slots=True)
class RippleHit:
    """涟漪扫描命中项（需修订清单条目）。

    Attributes:
        reference: 命中的引用位置。
        reason: 命中原因。
        severity: error=需修订 / warning=需人工核对。
    """

    reference: EntityReference
    reason: str
    severity: str


def scan_ripple(
    change: SettingChange,
    references: list[EntityReference],
) -> list[RippleHit]:
    """涟漪效应扫描：设定变更 → 受影响引用清单（纯函数，可单测）。

    命中规则：
    - 实体整体变更（field=None）→ 该实体全部引用 error（全面受影响）；
    - 引用标注了同一字段（ref.field == change.field）→ error（该处表述
      依赖变更字段，需修订）；
    - 引用为泛引用（ref.field=None）→ warning（无法判定，需人工核对）；
    - 引用标注了其它字段 → 跳过（不受本次变更影响）。

    引用索引（references）由宿主按正文实体识别构建——本原语只做判定与
    清单组装，不承担检索职责。
    """
    hits: list[RippleHit] = []
    key = _key(change.entity_id)
    for ref in references:
        if ref.entity_type != change.entity_type or _key(ref.entity_id) != key:
            continue
        if change.field is None:
            hits.append(
                RippleHit(
                    reference=ref,
                    reason=f"{change.entity_type}[{key}] 整体变更，此处引用需修订",
                    severity=SEVERITY_ERROR,
                )
            )
        elif ref.field == change.field:
            hits.append(
                RippleHit(
                    reference=ref,
                    reason=f"字段 {change.field} 已变更（{change.old_value}→{change.new_value}），此处需修订",
                    severity=SEVERITY_ERROR,
                )
            )
        elif ref.field is None:
            hits.append(
                RippleHit(
                    reference=ref,
                    reason=f"字段 {change.field} 已变更，此处为泛引用需人工核对",
                    severity=SEVERITY_WARNING,
                )
            )
    return hits


def group_ripple_hits_by_chapter(hits: list[RippleHit]) -> dict[int, list[RippleHit]]:
    """按章节分组需修订清单（长书维护的修订视图：逐章处理）。"""
    grouped: dict[int, list[RippleHit]] = {}
    for hit in sorted(hits, key=lambda h: (h.reference.chapter_id, h.reference.paragraph_index or 0)):
        grouped.setdefault(hit.reference.chapter_id, []).append(hit)
    return grouped


# ---------------------------------------------------------------------------
# What-if 平行宇宙（世界状态分支 + 对比）
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class WorldStateBranch:
    """What-if 平行宇宙分支。

    Attributes:
        label: 分支标签（"如果主角没死会怎样"）。
        world: 分支世界状态（与主线独立演进，互不影响）。
        parent: 主线世界状态引用（分支创建时的快照）。
        at_chapter: 分支点章节（None=当前）。
    """

    label: str
    world: WorldState
    parent: WorldState
    at_chapter: int | None = None


def branch_world_state(
    world: WorldState,
    *,
    label: str,
    at_chapter: int | None = None,
) -> WorldStateBranch:
    """派生 What-if 分支：深拷贝当前世界状态为平行宇宙。

    分支保留主线快照引用（对比基线）；分支世界独立演进——在其上应用
    替代变更（apply_state_changes）后，与主线经 :func:`compare_world_states`
    对比差异，由卡回路收敛挑选（发散收敛 + 时间线 + 补丁链 + 卡回路一体）。
    """
    branch = WorldState.from_dict(world.to_dict())
    branch.record_change(
        CHANGE_BRANCH,
        at_chapter=at_chapter,
        actor=ACTOR_USER,
        detail=label,
    )
    return WorldStateBranch(label=label, world=branch, parent=world, at_chapter=at_chapter)


@dataclass(frozen=True, slots=True)
class WorldStateDiff:
    """分支与主线的单处差异（并存对比的最小单元）。

    Attributes:
        section: 差异所在区（characters/knowledge/events/causal_links/foreshadowings）。
        item_id: 差异实体 id。
        kind: added=分支新增 / removed=分支移除 / changed=分支改写。
        detail: 差异说明。
    """

    section: str
    item_id: str
    kind: str
    detail: str = ""


def compare_world_states(base: WorldState, variant: WorldState) -> list[WorldStateDiff]:
    """对比主线与分支世界状态，输出差异清单（"与主线并存对比"视图）。"""
    diffs: list[WorldStateDiff] = []

    for section, base_items, var_items in (
        ("characters", base.characters, variant.characters),
        ("events", base.events, variant.events),
        ("foreshadowings", base.foreshadowings, variant.foreshadowings),
    ):
        for key in sorted(set(base_items) | set(var_items)):
            if key not in base_items:
                diffs.append(WorldStateDiff(section, key, "added", "分支新增"))
            elif key not in var_items:
                diffs.append(WorldStateDiff(section, key, "removed", "分支移除"))
            elif base_items[key] != var_items[key]:
                diffs.append(WorldStateDiff(section, key, "changed", "分支改写"))

    base_knowledge = {
        (e.character_id, e.fact_id): e for entries in base.knowledge.values() for e in entries
    }
    var_knowledge = {
        (e.character_id, e.fact_id): e for entries in variant.knowledge.values() for e in entries
    }
    for key in sorted(set(base_knowledge) | set(var_knowledge)):
        item_id = f"{key[0]}:{key[1]}"
        if key not in base_knowledge:
            diffs.append(WorldStateDiff("knowledge", item_id, "added", "分支新增知识"))
        elif key not in var_knowledge:
            diffs.append(WorldStateDiff("knowledge", item_id, "removed", "分支移除知识"))
        elif base_knowledge[key] != var_knowledge[key]:
            diffs.append(WorldStateDiff("knowledge", item_id, "changed", "分支改写知识"))

    base_links = {
        (link.cause_event_id, link.effect_event_id) for link in base.causal_links
    }
    var_links = {
        (link.cause_event_id, link.effect_event_id) for link in variant.causal_links
    }
    for pair in sorted(base_links | var_links, key=lambda p: (p[0], p[1])):
        item_id = f"{pair[0]}->{pair[1]}"
        if pair not in base_links:
            diffs.append(WorldStateDiff("causal_links", item_id, "added", "分支新增因果边"))
        elif pair not in var_links:
            diffs.append(WorldStateDiff("causal_links", item_id, "removed", "分支移除因果边"))

    return diffs


__all__ = [
    "ACTOR_AGENT",
    "ACTOR_PRECHECK",
    "ACTOR_SYSTEM",
    "ACTOR_USER",
    "CHANGE_BRANCH",
    "CHANGE_CAUSAL",
    "CHANGE_CHARACTER",
    "CHANGE_EVENT",
    "CHANGE_FORESHADOWING",
    "CHANGE_KNOWLEDGE",
    "SEVERITY_ERROR",
    "SEVERITY_WARNING",
    "CausalEvent",
    "CausalLink",
    "CharacterFingerprint",
    "CharacterState",
    "CharacterUpdate",
    "EntityReference",
    "ExtractedStateChanges",
    "FingerprintVerifier",
    "ForeshadowingNode",
    "ForeshadowingUpdate",
    "KnowledgeEntry",
    "KnowledgeGain",
    "LLMStateChangeExtractor",
    "RelationshipState",
    "RippleHit",
    "SettingChange",
    "StateChangeExtractor",
    "WorldIssue",
    "WorldState",
    "WorldStateBranch",
    "WorldStateChange",
    "WorldStateDiff",
    "apply_state_changes",
    "branch_world_state",
    "check_fingerprint_taboos",
    "check_knowledge_gap",
    "compare_world_states",
    "group_ripple_hits_by_chapter",
    "has_hard_conflict",
    "parse_extracted_changes",
    "run_world_precheck",
    "scan_ripple",
    "validate_causal_chain",
    "validate_foreshadowing_chain",
]
