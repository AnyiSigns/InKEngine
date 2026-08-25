"""回合账本合并（按需 LLM，便宜档）——复用引擎既有压缩形态。

回合账本 = 压缩前的事实快照；LLM 合并 = 复用 ``context.py`` 消息压缩同一
摘要替换形态（cutoff + summary 落位），不另起炉灶。本模块提供「确定性
归约合并」（无模型可用时回落）与「LLM 合并」（配置便宜档时调用）两条
路径，二者产出同构摘要 JSON，落位语义与 ``patch_chain.build_message_compress_patches``
的 summary 落链首一致——摘要即压缩后链首消息，可被同一召回/续跑形态复用。
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable

SUMMARY_SCHEMA = "round_ledger_summary/1"

# 确定性压缩文本上限（超过截断，保留关键行）。
COMPRESS_LIMIT = 2000


def _ledger_text(ledger: dict) -> str:
    """单账本 → 可压缩文本（意图/结论/事件要点）。"""
    parts: list[str] = []
    intent = ledger.get("intent")
    if intent:
        parts.append(f"意图: {intent}")
    conclusion = ledger.get("conclusion")
    if conclusion:
        parts.append(f"结论: {conclusion}")
    for ev in ledger.get("events", []) or []:
        kind = ev.get("kind") or ev.get("type") or "event"
        detail = ev.get("detail") or ev.get("payload") or {}
        if isinstance(detail, dict):
            detail = json.dumps(detail, ensure_ascii=False)
        parts.append(f"- {kind}: {detail}")
    summary = ledger.get("summary")
    if summary:
        parts.append(f"既有摘要: {summary}")
    return "\n".join(parts)


def _deterministic_compress(text: str, limit: int = COMPRESS_LIMIT) -> str:
    """确定性抽取压缩（零模型）：保留关键行，超上限截断。"""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    kept: list[str] = []
    total = 0
    for ln in lines:
        if total + len(ln) + 1 > limit:
            kept.append("…(截断)")
            break
        kept.append(ln)
        total += len(ln) + 1
    return "\n".join(kept)


def merge_ledger(
    old_summary: str | None,
    new_ledgers: list[dict],
    *,
    llm_summarize: Callable[[str], str] | None = None,
) -> dict:
    """合并旧摘要 + 新账本为一次增量摘要（同构摘要 JSON）。

    Args:
        old_summary: 既有摘要链最新一条（None = 首次合并）。
        new_ledgers: 本轮新增账本（事实快照列表）。
        llm_summarize: 可选便宜档摘要函数(文本)->摘要；未提供走确定性压缩。

    Returns:
        ``{schema, generated_at, summary, source_count}``——摘要形态与
        ``build_message_compress_patches`` 的 summary 落位同构，可被续跑
        上下文复用为链首压缩消息。
    """
    combined: list[str] = []
    if old_summary:
        combined.append(f"[旧摘要]\n{old_summary}")
    for lg in new_ledgers or []:
        combined.append(_ledger_text(lg))
    text = "\n\n".join(combined)
    if llm_summarize is not None:
        summary = llm_summarize(text)
    else:
        summary = _deterministic_compress(text)
    return {
        "schema": SUMMARY_SCHEMA,
        "generated_at": time.time(),
        "summary": summary,
        "source_count": len(new_ledgers or []) + (1 if old_summary else 0),
    }


__all__ = ["SUMMARY_SCHEMA", "merge_ledger"]
