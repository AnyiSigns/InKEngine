"""回合账本合并（确定性归约，复用压缩形态）。"""

from ink_engine.core.ledger import SUMMARY_SCHEMA, merge_ledger


def test_merge_first_time_no_old_summary():
    ledgers = [
        {"intent": "做X", "conclusion": "完成", "events": [], "summary": None},
    ]
    out = merge_ledger(None, ledgers)
    assert out["schema"] == SUMMARY_SCHEMA
    assert "做X" in out["summary"]
    assert out["source_count"] == 1


def test_merge_incremental_with_old_summary():
    old = "历史摘要：已做A"
    ledgers = [
        {"intent": "做B", "conclusion": "完成B", "events": [{"kind": "tool_end", "detail": {"path": "a.rs"}}], "summary": None},
    ]
    out = merge_ledger(old, ledgers)
    assert "历史摘要" in out["summary"]
    assert "做B" in out["summary"]
    assert out["source_count"] == 2


def test_merge_is_deterministic_and_uses_llm_hook():
    ledgers = [{"intent": "i", "conclusion": "c", "events": [], "summary": None}]
    base = merge_ledger(None, ledgers)
    again = merge_ledger(None, ledgers)
    assert base["summary"] == again["summary"]
    called = {}
    out = merge_ledger(None, ledgers, llm_summarize=lambda t: (called.update(t=t) or "LLM摘要"))
    assert out["summary"] == "LLM摘要"
    assert "i" in called["t"]
