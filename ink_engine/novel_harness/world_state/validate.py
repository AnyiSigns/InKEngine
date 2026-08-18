"""世界状态写时校验层：确定性规则 + LLM 判定钩子。

统一问题模型 :class:`WorldIssue`（审核卡 conflicts 字段的可序列化单元）；
全部校验 fail-open：异常跳过该环节，不阻断写操作。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from ink_engine.novel_harness.narrative_state import is_valid_status

from .models import CharacterFingerprint, WorldState, _key

logger = logging.getLogger(__name__)

# 校验问题严重度（error=硬冲突需裁决 / warning=提示级）
SEVERITY_ERROR = "error"
SEVERITY_WARNING = "warning"

# 校验问题类型（WorldIssue.kind）
ISSUE_KNOWLEDGE_GAP = "knowledge_gap"
ISSUE_CAUSAL = "causal_chain"
ISSUE_FORESHADOWING = "foreshadowing_chain"
ISSUE_FINGERPRINT = "fingerprint"


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
    """伏笔矩阵校验：状态合法性 + 回收链合法性（泛化）。

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


__all__ = [
    "ISSUE_CAUSAL",
    "ISSUE_FINGERPRINT",
    "ISSUE_FORESHADOWING",
    "ISSUE_KNOWLEDGE_GAP",
    "SEVERITY_ERROR",
    "SEVERITY_WARNING",
    "FingerprintVerifier",
    "WorldIssue",
    "check_fingerprint_taboos",
    "check_knowledge_gap",
    "has_hard_conflict",
    "run_world_precheck",
    "validate_causal_chain",
    "validate_foreshadowing_chain",
]
