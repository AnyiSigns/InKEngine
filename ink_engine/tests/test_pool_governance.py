"""结点池治理单测：容量/淘汰/合并/预算四条规则（只判定登记不执行）。

覆盖（硬规则断言段）：
- 容量上限：每域 N_max=500；满则新提案须携带淘汰候选；
- 死结点淘汰：usage_count=0 且未转正且 age>90 天 → 标记失效登记
  （不物理删）；
- 近重复合并：字段 Jaccard>0.8 或目的嵌入余弦>0.9 → 转合并提案；
- 提案预算：3/周/域，耗尽拒绝。
"""
from __future__ import annotations

import pytest

from ink_engine.core.pool_governance import (
    DEAD_NODE_MIN_AGE_DAYS,
    GOV_INVALIDATE,
    GOV_VERDICT_ALLOW,
    GOV_VERDICT_MERGE,
    GOV_VERDICT_REJECT,
    MERGE_COSINE_THRESHOLD,
    MERGE_JACCARD_THRESHOLD,
    POOL_CAPACITY_MAX,
    PROPOSAL_WEEKLY_BUDGET,
    PoolGovernance,
    PoolNodeSnapshot,
    at_capacity,
    dead_node_eligible,
    evaluate_proposal,
    fields_jaccard,
    invalidation_record,
    near_duplicate_by_embedding,
    near_duplicate_by_fields,
    proposal_allowed,
    proposal_budget_remaining,
)

# ── 容量上限 ──

def test_capacity_threshold():
    """容量上限边界：达上限（=500）即满。"""
    assert POOL_CAPACITY_MAX == 500
    assert not at_capacity(499)
    assert at_capacity(500)
    assert at_capacity(501)


def test_eviction_required_when_full():
    """满则新提案须携带淘汰候选（判定登记，放行与否由宿主评审）。"""
    verdict = evaluate_proposal(
        "new_node", ("a", "b"),
        pool_count=500, used_this_week=0,
    )
    assert verdict.verdict == GOV_VERDICT_ALLOW  # 仍放行进评审
    assert verdict.eviction_required is True
    not_full = evaluate_proposal(
        "new_node", ("a", "b"),
        pool_count=499, used_this_week=0,
    )
    assert not_full.eviction_required is False


# ── 死结点淘汰 ──

def test_dead_node_eligibility():
    """死结点淘汰：usage_count=0 且未转正且 age>90 天。"""
    assert DEAD_NODE_MIN_AGE_DAYS == 90
    assert dead_node_eligible(0, age_days=91.0)
    assert not dead_node_eligible(0, age_days=90.0)  # 边界：>90 才淘汰
    assert not dead_node_eligible(1, age_days=200.0)  # 有使用不淘汰
    assert not dead_node_eligible(0, promoted=True, age_days=200.0)  # 转正不淘汰


def test_invalidation_record_is_mark_not_delete():
    """淘汰 = 标记失效登记（不物理删；登记含动作与原因）。"""
    record = invalidation_record("old_node", "零调用且超龄")
    assert record["action"] == GOV_INVALIDATE
    assert record["node_id"] == "old_node"
    assert "reason" in record and "ts" in record


def test_dead_candidates_listed_in_verdict():
    """判定附带死结点淘汰候选清单（供宿主替换语义参考）。"""
    nodes = [
        PoolNodeSnapshot(node_id="dead1", usage_count=0, age_days=200.0),
        PoolNodeSnapshot(node_id="alive", usage_count=5, age_days=200.0),
        PoolNodeSnapshot(node_id="dead2", usage_count=0, age_days=95.0),
    ]
    verdict = evaluate_proposal(
        "new_node", ("a",),
        pool_count=500, used_this_week=0, pool_nodes=nodes,
    )
    assert verdict.eviction_required is True
    assert verdict.eviction_candidates == ("dead1", "dead2")


# ── 近重复合并 ──

def test_jaccard():
    """字段 Jaccard 计算（空集 = 0 防除零）。"""
    assert fields_jaccard(("a", "b"), ("a", "b")) == 1.0
    assert fields_jaccard(("a", "b"), ("a",)) == pytest.approx(0.5)
    assert fields_jaccard((), ()) == 0.0
    assert fields_jaccard(("a",), ()) == 0.0


def test_near_duplicate_thresholds():
    """近重复阈值：Jaccard>0.8 或余弦>0.9。"""
    assert MERGE_JACCARD_THRESHOLD == 0.8
    assert MERGE_COSINE_THRESHOLD == 0.9
    assert near_duplicate_by_fields(("a", "b", "c"), ("a", "b", "d")) is False  # 2/4=0.5
    assert near_duplicate_by_fields(("a", "b", "c"), ("a", "b", "c", "d")) is False  # 3/4=0.75
    assert near_duplicate_by_fields(("a", "b", "c"), ("a", "b", "c", "d", "e")) is False  # 3/5=0.6
    assert near_duplicate_by_fields(("a", "b", "c", "d"), ("a", "b", "c", "d", "e")) is False  # 4/5=0.8 恰为阈值不触发
    assert near_duplicate_by_fields(("a", "b", "c", "d", "e"), ("a", "b", "c", "d", "e", "f")) is True  # 5/6≈0.83
    assert near_duplicate_by_embedding(0.9) is False  # 边界：>0.9 才触发
    assert near_duplicate_by_embedding(0.91) is True


def test_merge_verdict_by_fields_and_cosine():
    """近重复 → 转合并提案（拒绝重复入池；判定登记含命中目标）。"""
    nodes = [PoolNodeSnapshot(node_id="existing", fields=("a", "b", "c", "d", "e"))]
    # 字段近重复
    verdict = evaluate_proposal(
        "new_node", ("a", "b", "c", "d", "e", "f"),
        pool_count=10, used_this_week=0, pool_nodes=nodes,
    )
    assert verdict.verdict == GOV_VERDICT_MERGE
    assert verdict.merge_target == "existing"
    # 目的嵌入余弦近重复
    verdict2 = evaluate_proposal(
        "new_node", ("x", "y"),
        pool_count=10, used_this_week=0, pool_nodes=nodes,
        duplicate_cosine=0.95,
    )
    assert verdict2.verdict == GOV_VERDICT_MERGE
    assert verdict2.merge_target == "existing"


# ── 提案预算 ──

def test_proposal_budget():
    """提案预算：3/周/域；耗尽拒绝。"""
    assert PROPOSAL_WEEKLY_BUDGET == 3
    assert proposal_budget_remaining(0) == 3
    assert proposal_budget_remaining(2) == 1
    assert proposal_budget_remaining(3) == 0
    assert proposal_budget_remaining(5) == 0  # 负数按 0 计
    assert proposal_allowed(0) and proposal_allowed(2)
    assert not proposal_allowed(3)
    assert not proposal_allowed(4)


def test_budget_exhausted_reject():
    """预算耗尽 = 拒绝（判定登记，不执行）。"""
    verdict = evaluate_proposal(
        "new_node", ("a",),
        pool_count=10, used_this_week=3,
    )
    assert verdict.verdict == GOV_VERDICT_REJECT
    assert verdict.budget_remaining == 0
    assert any("预算" in r for r in verdict.reasons)


# ── 登记器 ──

def test_pool_governance_records_verdicts():
    """登记器：判定结果 append-only 登记（可审计追溯，不执行决策）。"""
    gov = PoolGovernance()
    verdict = gov.evaluate(
        {"node_id": "candidate", "fields": ["a", "b"]},
        {"pool_count": 500, "used_this_week": 1, "pool_nodes": []},
    )
    assert verdict.verdict == GOV_VERDICT_ALLOW
    assert len(gov.log) == 1
    assert gov.log[0]["node_id"] == "candidate"
    assert gov.log[0]["verdict"] == GOV_VERDICT_ALLOW
    # 第二次登记追加
    gov.evaluate(
        {"node_id": "candidate2", "fields": ["a", "b"]},
        {"pool_count": 10, "used_this_week": 4, "pool_nodes": []},
    )
    assert len(gov.log) == 2
    assert gov.log[1]["verdict"] == GOV_VERDICT_REJECT


def test_pool_governance_snapshot_objects():
    """池快照可传对象或 dict（登记器归一化处理）。"""
    gov = PoolGovernance()
    nodes = [
        PoolNodeSnapshot(node_id="dup", fields=("a", "b", "c", "d", "e")),
        {"node_id": "dict_node", "usage_count": 0, "age_days": 100.0},
    ]
    verdict = gov.evaluate(
        {"node_id": "candidate", "fields": ["a", "b", "c", "d", "e", "f"]},
        {"pool_count": 10, "used_this_week": 0, "pool_nodes": nodes},
    )
    assert verdict.verdict == GOV_VERDICT_MERGE
    assert verdict.merge_target == "dup"
    # 死结点候选登记（dict 形态快照同样参与判定）
    verdict2 = gov.evaluate(
        {"node_id": "candidate2", "fields": ["x"]},
        {"pool_count": 500, "used_this_week": 0, "pool_nodes": nodes},
    )
    assert "dict_node" in verdict2.eviction_candidates
