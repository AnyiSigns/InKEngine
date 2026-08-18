"""世界状态变更应用原语（确定性更新：结构化变更 → 世界状态）。

应用顺序：角色 → 知识 → 事件 → 因果边 → 伏笔。任何一步失败都不影响
其余变更应用（部分成功语义）。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ink_engine.novel_harness.narrative_state import (
    ACTOR_AGENT,
    is_illegal_transition,
    is_valid_status,
)

from .extract import ExtractedStateChanges
from .models import ForeshadowingNode, KnowledgeEntry, WorldState
from .validate import (
    ISSUE_APPLY,
    ISSUE_CAUSAL,
    ISSUE_FORESHADOWING,
    SEVERITY_ERROR,
    SEVERITY_WARNING,
    WorldIssue,
)


@dataclass(slots=True)
class ApplyResult:
    """一次状态变更应用的结果留痕。

    Attributes:
        applied: 成功应用的变更数。
        skipped: 被跳过/拒绝的原因列表（含未应用内容，可读留痕）。
        issues: 应用过程中触发的校验问题（结构约束/合法性）——拒绝分支
            同时写入结构化 WorldIssue（与 skipped 可读留痕并存），
            调用方可直接渲染冲突而不必解析文本。
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

    每步带结构约束：

    - 角色/知识/伏笔更新引用未知实体 → 跳过并留痕（LLM 常自造 id，
      保守不创造实体，宁缺毋滥）；
    - 因果边引用不存在事件 → 拒绝（悬空边会破坏跨章追踪）；
    - 伏笔状态非法 → 拒绝（复用状态机枚举校验）。
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
            result.issues.append(
                WorldIssue(
                    kind=ISSUE_APPLY,
                    severity=SEVERITY_ERROR,
                    message=f"角色 {upd.character_id} 不存在，忽略状态更新",
                    entity_type="character",
                    entity_id=str(upd.character_id),
                )
            )
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
                result.issues.append(
                    WorldIssue(
                        kind=ISSUE_APPLY,
                        severity=SEVERITY_ERROR,
                        message=f"角色 {gain.character_id} 不存在，忽略知识登记",
                        entity_type="character",
                        entity_id=str(gain.character_id),
                    )
                )
        else:
            result.skipped.append(f"角色 {gain.character_id} 已知事实 {gain.fact_id}，跳过")
            result.issues.append(
                WorldIssue(
                    kind=ISSUE_APPLY,
                    severity=SEVERITY_WARNING,
                    message=f"角色 {gain.character_id} 已知事实 {gain.fact_id}，跳过",
                    entity_type="character",
                    entity_id=str(gain.character_id),
                )
            )
    for event in changes.events:
        world.add_event(event, actor=actor)
        result.applied += 1
    for link in changes.causal_links:
        created = world.link_causality(link.cause_event_id, link.effect_event_id, note=link.note, actor=actor)
        if created:
            result.applied += 1
        else:
            result.skipped.append(f"因果边 {link.cause_event_id}->{link.effect_event_id} 拒绝（事件缺失或重复）")
            result.issues.append(
                WorldIssue(
                    kind=ISSUE_CAUSAL,
                    severity=SEVERITY_ERROR,
                    message=f"因果边 {link.cause_event_id}->{link.effect_event_id} 拒绝（事件缺失或重复）",
                    entity_type="event",
                    entity_id=f"{link.cause_event_id}->{link.effect_event_id}",
                )
            )
    for upd in changes.foreshadowing_updates:
        node = world.get_foreshadowing(upd.foreshadowing_id)
        if node is None:
            result.skipped.append(f"伏笔 {upd.foreshadowing_id} 不存在，忽略状态推进")
            result.issues.append(
                WorldIssue(
                    kind=ISSUE_APPLY,
                    severity=SEVERITY_ERROR,
                    message=f"伏笔 {upd.foreshadowing_id} 不存在，忽略状态推进",
                    entity_type="foreshadowing",
                    entity_id=str(upd.foreshadowing_id),
                )
            )
            continue
        if not is_valid_status(upd.status):
            result.skipped.append(f"伏笔 {upd.foreshadowing_id} 状态 {upd.status!r} 非法，忽略")
            result.issues.append(
                WorldIssue(
                    kind=ISSUE_FORESHADOWING,
                    severity=SEVERITY_ERROR,
                    message=f"伏笔 {upd.foreshadowing_id} 状态 {upd.status!r} 非法，忽略",
                    entity_type="foreshadowing",
                    entity_id=str(upd.foreshadowing_id),
                )
            )
            continue
        if is_illegal_transition(node.status, upd.status):
            result.skipped.append(
                f"伏笔 {upd.foreshadowing_id} 状态非法迁移被拒绝: "
                f"{node.status!r} -> {upd.status!r}（resolved 为终态不得回退）"
            )
            result.issues.append(
                WorldIssue(
                    kind=ISSUE_FORESHADOWING,
                    severity=SEVERITY_ERROR,
                    message=(
                        f"伏笔 {upd.foreshadowing_id} 状态非法迁移被拒绝: "
                        f"{node.status!r} -> {upd.status!r}"
                    ),
                    entity_type="foreshadowing",
                    entity_id=str(upd.foreshadowing_id),
                )
            )
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


__all__ = ["ApplyResult", "apply_state_changes"]
