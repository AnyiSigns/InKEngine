"""What-if 平行宇宙（世界状态分支 + 对比）。

分支保留主线快照引用（对比基线）；分支世界独立演进——在其上应用
替代变更（apply_state_changes）后，与主线经 compare_world_states
对比差异，由卡回路收敛挑选（发散收敛 + 时间线 + 补丁链 + 卡回路一体）。
"""
from __future__ import annotations

from dataclasses import dataclass

from ink_engine.novel_harness.narrative_state import ACTOR_USER

from .models import CHANGE_BRANCH, WorldState


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
    """派生 What-if 分支：深拷贝当前世界状态为平行宇宙。"""
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
    "WorldStateBranch",
    "WorldStateDiff",
    "branch_world_state",
    "compare_world_states",
]
