"""记忆无感提取（零 LLM 规则抽取）+ 冲突消解（新旧并存留痕）。"""

import asyncio

from ink_engine.core.memory import StorageBackedMemoryStore
from ink_engine.core.memory_extract import (
    arbitrate_and_store,
    extract_entries_from_ledger,
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
            {"kind": "accept", "detail": {"content": "确认关灯"}},
        ],
    }
    entries = extract_entries_from_ledger(ledger)
    kinds = {e.kind for e in entries}
    assert "intent" in kinds
    assert "conclusion" in kinds
    assert "confirmation" in kinds
    confirm = [e for e in entries if e.kind == "confirmation"][0]
    assert "确认关灯" in confirm.content


def test_confirmation_events_match_round_fact_contract():
    """确认类事件口径 = 真实引擎事件类型（accept/edit/reject/user_correction/
    user_confirm）——与壳侧账本归约保留集同源，防账本漏确认类 → 记忆抽不到。"""
    from ink_engine.core.memory_extract import (
        CONFIRMATION_EVENTS,
        ROUND_FACT_EVENTS,
    )

    assert set(CONFIRMATION_EVENTS) == {
        "accept",
        "edit",
        "reject",
        "user_correction",
        "user_confirm",
    }
    # 确认类 ⊆ 账本事实事件全集（壳侧 RECOGNIZED_EVENTS 引用 ROUND_FACT_EVENTS）
    assert set(CONFIRMATION_EVENTS) <= set(ROUND_FACT_EVENTS)
    # 历史虚构类型已移除（approval_accept 非真实引擎事件类型）
    assert "approval_accept" not in CONFIRMATION_EVENTS
    assert "confirmation" not in CONFIRMATION_EVENTS


def test_extract_priorities_data_driven():
    """ENG1-13：抽取优先级数据化（旧硬编码 6/5/7）——缺省 = 模块常量，
    宿主可覆盖；语义：确认类 > 意图 > 结论。"""
    from ink_engine.core.memory_extract import (
        PRIORITY_CONCLUSION,
        PRIORITY_CONFIRMATION,
        PRIORITY_INTENT,
        extract_entries_from_ledger,
    )

    ledger = {
        "round_id": "r1",
        "intent": "意图",
        "conclusion": "结论",
        "events": [{"kind": "user_confirm", "detail": {"content": "确认"}}],
    }
    entries = extract_entries_from_ledger(ledger)
    by_kind = {e.kind: e.priority for e in entries}
    assert by_kind == {
        "intent": PRIORITY_INTENT,
        "conclusion": PRIORITY_CONCLUSION,
        "confirmation": PRIORITY_CONFIRMATION,
    }
    assert PRIORITY_CONFIRMATION > PRIORITY_INTENT > PRIORITY_CONCLUSION
    assert by_kind["intent"] == 6
    assert by_kind["conclusion"] == 5
    assert by_kind["confirmation"] == 7
    # 宿主覆盖生效
    custom = extract_entries_from_ledger(
        ledger,
        priority_intent=9,
        priority_conclusion=1,
        priority_confirmation=5,
    )
    custom_by_kind = {e.kind: e.priority for e in custom}
    assert custom_by_kind["intent"] == 9
    assert custom_by_kind["conclusion"] == 1
    assert custom_by_kind["confirmation"] == 5


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
