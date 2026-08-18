"""世界状态提取层：确定性更新载荷 + LLM best-effort 提取。

提取是增强项：失败返回空变更（fail-open），不阻断写流程。返回的变更
随后经 :func:`ink_engine.novel_harness.world_state.apply.apply_state_changes`
应用（含校验拦截）。
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .models import CausalEvent, CausalLink, CharacterFingerprint, RelationshipState, WorldState

logger = logging.getLogger(__name__)

# LLM 提取护栏（防长文/大上下文撑爆请求与解析）
_MAX_TEXT_CHARS = 4000
_MAX_CONTEXT_CHARS = 1500
_MAX_JSON_ITEMS = 30


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


__all__ = [
    "CharacterUpdate",
    "ExtractedStateChanges",
    "ForeshadowingUpdate",
    "KnowledgeGain",
    "LLMStateChangeExtractor",
    "StateChangeExtractor",
    "parse_extracted_changes",
]
