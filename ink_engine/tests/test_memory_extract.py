"""记忆无感提取（零 LLM 规则抽取）+ 冲突消解（新旧并存留痕）。"""

import asyncio

from ink_engine.core.memory import MemoryEntry, StorageBackedMemoryStore
from ink_engine.core.memory_extract import (
    extract_entries_from_ledger,
    arbitrate_and_store,
)
from ink_engine.core.storage_memory import MemoryStorage


def _store():
    return StorageBackedMemoryStore(MemoryStorage())


def test_extract_pulls_intent_conclusion_confirmation():
    ledger = {
        "round_id": "r1",
        "intent": "帮我把灯关了",
        "conclusion": "已关闭灯光",
        "events": [
            {"kind": "tool_end", "detail": {"path": "a.rs"}},
            {"kind": "approval_accept", "detail": {"content": "确认关灯"}},
        ],
    }
    entries = extract_entries_from_ledger(ledger)
    kinds = {e.kind for e in entries}
    assert "intent" in kinds
    assert "conclusion" in kinds
    assert "confirmation" in kinds
    confirm = [e for e in entries if e.kind == "confirmation"][0]
    assert "确认关灯" in confirm.content


def test_arbitrate_dedup_same_content():
    store = _store()
    ledger = {"round_id": "r1", "intent": "同一意图", "conclusion": None, "events": []}
    entries = extract_entries_from_ledger(ledger)
    r1 = asyncio.run(arbitrate_and_store(store, entries))
    # 重复抽取同内容 → 跳过存储（不重复落库）
    r2 = asyncio.run(arbitrate_and_store(store, entries))
    assert len(r1["stored"]) == 1
    assert len(r2["stored"]) == 0
    assert len(r2["skipped"]) == 1


def test_arbitrate_conflict_coexist_no_silent_overwrite():
    store = _store()
    # 第一条意图
    e1 = extract_entries_from_ledger({"intent": "旧意图", "conclusion": None, "events": []})
    r1 = asyncio.run(arbitrate_and_store(store, e1))
    assert len(r1["stored"]) == 1
    # 冲突内容（同 namespace+kind，内容不同）→ 新旧并存留痕
    e2 = extract_entries_from_ledger({"intent": "新意图", "conclusion": None, "events": []})
    r2 = asyncio.run(arbitrate_and_store(store, e2))
    assert len(r2["stored"]) == 1
    assert len(r2["arbitrations"]) == 1
    arb = r2["arbitrations"][0]
    assert arb["action"] == "coexist"
    assert arb["new_id"] != arb["old_id"]
    # 旧条目仍在（未被静默覆盖），且双方互留溯源
    old_id = arb["old_id"]
    rec = asyncio.run(store.get(old_id))
    assert rec is not None
    assert rec.meta.get("arbitration", "").startswith("coexist:")
    new_rec = asyncio.run(store.get(arb["new_id"]))
    assert new_rec.meta.get("arbitration", "").startswith("coexist:")
