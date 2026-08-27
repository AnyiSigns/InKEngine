"""记忆无感提取 + 冲突消解。

蒸馏链显式信号之外，回合账本事件流中用户意图 / 结论要点自动提取入记忆
（规则抽取优先——用户指令 / 最终回复 / 确认，零 LLM）；冲突消解 = 同
namespace + kind 条目按可信度 / 时间序仲裁（新旧并存留痕，不静默覆盖）。

逻辑全在 ink_engine 包内（不新增 inkling_host 模块），复用
``StorageBackedMemoryStore`` 同一记忆接口；语义归并（可选弱模型档）留作
扩展点，本模块默认零 LLM 规则抽取。
"""

from __future__ import annotations

import json

from .memory import MemoryEntry, MemoryQuery, StorageBackedMemoryStore

# 确认类事件类型（规则抽取触发点）。
CONFIRMATION_EVENTS = ("confirmation", "approval_accept", "user_confirm")

# 默认记忆域（用户级）。
DEFAULT_NAMESPACE = "user:default"

# 抽取条目的优先级档（数据化，ENG1-13：旧实现硬编码 6/5/7 魔法数字）。
# 语义：确认类（用户显式确认 = 最强事实）> 意图（回合指令）> 结论
# （模型产出要点）。宿主可按产品语义覆盖。
PRIORITY_CONFIRMATION = 7
PRIORITY_INTENT = 6
PRIORITY_CONCLUSION = 5


def extract_entries_from_ledger(
    ledger: dict,
    *,
    namespace: str = DEFAULT_NAMESPACE,
    priority_confirmation: int = PRIORITY_CONFIRMATION,
    priority_intent: int = PRIORITY_INTENT,
    priority_conclusion: int = PRIORITY_CONCLUSION,
) -> list[MemoryEntry]:
    """从回合账本规则抽取记忆条目（零 LLM）。

    抽取点：意图（intent）、结论（conclusion）、确认类事件（approval /
    confirm）。每条带 ledger_round 溯源，便于回溯与去重仲裁。优先级档
    为数据化参数（缺省 = 模块常量），宿主可覆盖。
    """
    out: list[MemoryEntry] = []
    round_id = ledger.get("round_id")
    meta_base = {"ledger_round": round_id, "source": "round_ledger"}

    intent = ledger.get("intent")
    if intent:
        out.append(
            MemoryEntry(
                namespace=namespace,
                kind="intent",
                content=intent,
                source="round_ledger",
                priority=priority_intent,
                meta={**meta_base},
            )
        )

    conclusion = ledger.get("conclusion")
    if conclusion:
        out.append(
            MemoryEntry(
                namespace=namespace,
                kind="conclusion",
                content=conclusion,
                source="round_ledger",
                priority=priority_conclusion,
                meta={**meta_base},
            )
        )

    for ev in ledger.get("events", []) or []:
        kind = ev.get("kind") or ev.get("type") or ""
        if kind not in CONFIRMATION_EVENTS:
            continue
        detail = ev.get("detail") or ev.get("payload") or {}
        content = (
            detail.get("content")
            or detail.get("message")
            or json.dumps(detail, ensure_ascii=False)
        )
        out.append(
            MemoryEntry(
                namespace=namespace,
                kind="confirmation",
                content=content,
                source="round_ledger",
                priority=priority_confirmation,
                meta={**meta_base},
            )
        )

    return out


def _normalize(content: str) -> str:
    """内容归一（去空白），用于冲突判定（同源重写视为同一条）。"""
    return " ".join(str(content).split())


def _conflicts(old: MemoryEntry, new: MemoryEntry) -> bool:
    """冲突判定：同 namespace + kind 且内容不同（归一后）→ 冲突。
    内容相同视为重复抽取，不视为冲突（去重处理）。"""
    return _normalize(old.content) != _normalize(new.content)


async def arbitrate_and_store(
    store: StorageBackedMemoryStore,
    entries: list[MemoryEntry],
) -> dict:
    """仲裁并存储抽取条目（异步协程，由调用方 await）。

    仲裁规则：同 namespace + kind 且内容冲突 → 新旧并存留痕（不静默覆盖）：
    旧条目不删，新条目以可信度（priority）落位，双方互写 ``arbitration``
    溯源（coexist:<id>）；内容相同（重复抽取）→ 跳过存储（去重）。
    返回 ``{stored, arbitrations, skipped}``。
    """
    stored: list[str] = []
    arbitrations: list[dict] = []
    skipped: list[str] = []
    for entry in entries:
        existing = await store.query(
            MemoryQuery(namespace=entry.namespace, kind=entry.kind)
        )
        # 内容相同 → 去重跳过
        for old in existing:
            if _normalize(old.content) == _normalize(entry.content):
                skipped.append(old.id or "")
                break
        else:
            # 无相同内容：检查冲突（不同内容同 namespace+kind）
            conflict_old = None
            for old in existing:
                if _conflicts(old, entry):
                    conflict_old = old
                    break
            entry_id = await store.save(entry)
            stored.append(entry_id)
            if conflict_old is not None and conflict_old.id is not None:
                # 新旧并存留痕（不静默覆盖）
                await store.update(
                    conflict_old.id,
                    {
                        "meta": {
                            **conflict_old.meta,
                            "arbitration": f"coexist:{entry_id}",
                        }
                    },
                )
                await store.update(
                    entry_id,
                    {
                        "meta": {
                            **entry.meta,
                            "arbitration": f"coexist:{conflict_old.id}",
                        }
                    },
                )
                arbitrations.append(
                    {
                        "action": "coexist",
                        "new_id": entry_id,
                        "old_id": conflict_old.id,
                        "new_priority": entry.priority,
                        "old_priority": conflict_old.priority,
                    }
                )
    return {"stored": stored, "arbitrations": arbitrations, "skipped": skipped}


__all__ = [
    "DEFAULT_NAMESPACE",
    "PRIORITY_CONCLUSION",
    "PRIORITY_CONFIRMATION",
    "PRIORITY_INTENT",
    "arbitrate_and_store",
    "extract_entries_from_ledger",
]
