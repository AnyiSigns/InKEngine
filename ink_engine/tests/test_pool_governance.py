"""结点池治理单测：容量/淘汰/合并/预算四条规则（只判定登记不执行）。

覆盖（硬规则断言段）：
- 容量上限：每域 N_max=500；满则新提案须携带淘汰候选；
- 死结点淘汰：usage_count=0 且未转正且 age>90 天 → 标记失效登记
  （不物理删）；
- 近重复合并：字段 Jaccard>0.8 或目的嵌入余弦>0.9 → 转合并提案；
- 提案预算：3/周/域，耗尽拒绝。

接线现状标注（ENG9b-14 评审结论修正）：本模块**已非孤儿**——壳侧宿主
（inkling_host/host.py:360-364,430-435）按 boot 键
``path_assembly_pool_governance_enabled`` 实例化 PoolGovernance 接入
结点提案链路（NodeProposalSettleHook 提案 sink 经治理判定），
``pool_nodes_from_registry``/``proposal_from_node_draft``/
``weekly_proposal_usage`` 为生产接线辅助。本测试不是「绿但无意义」——
判定规则是生产链路的真实消费面（壳侧装配测试另行覆盖接线闭环）。
"""
from __future__ import annotations

from typing import Any

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


def test_dead_node_records_derived_from_evictions():
    """失效登记由判定记录的 eviction_candidates 派生（ENG9b-9 统一）：

    旧实现按 log 的 action 键过滤恒返回空（死代码）；现由判定记录
    派生——log 保持纯判定记录（周预算统计不被污染），淘汰候选即失效
    登记来源。
    """
    gov = PoolGovernance()
    nodes = [
        PoolNodeSnapshot(node_id="dead1", usage_count=0, age_days=200.0),
        PoolNodeSnapshot(node_id="alive", usage_count=5, age_days=200.0),
    ]
    gov.evaluate(
        {"node_id": "new_node", "fields": ["a"]},
        {"pool_count": 500, "used_this_week": 0, "pool_nodes": nodes},
    )
    records = gov.dead_node_records()
    assert [r["node_id"] for r in records] == ["dead1"]
    assert all(r["action"] == GOV_INVALIDATE for r in records)
    assert all("reason" in r and "ts" in r for r in records)
    # 无淘汰候选 = 空登记（非恒空，是与判定同源的派生结果）
    gov.evaluate(
        {"node_id": "plain", "fields": ["a"]},
        {"pool_count": 10, "used_this_week": 0, "pool_nodes": []},
    )
    assert gov.dead_node_records() == records  # 不重复派生
    # 派生不污染判定 log（周预算统计口径保持纯判定记录）
    assert len(gov.log) == 2


# ── E-P9：接线辅助（提案归一 / 周预算 / 注册表快照）──────────────

def test_proposal_from_node_draft_normalizes():
    """失败点提案记录 → 治理提案形态（node_id = node_type，fields = 产出字段）。"""
    from ink_engine.core.pool_governance import proposal_from_node_draft

    record = {
        "node_type": "web_search",
        "output_schema": {
            "name": "web_search.output",
            "fields": [
                {"name": "result", "required": True},
                {"name": "sources", "required": False},
            ],
        },
    }
    proposal = proposal_from_node_draft(record)
    assert proposal["node_id"] == "web_search"
    assert set(proposal["fields"]) == {"result", "sources"}


def test_proposal_from_node_draft_missing_schema_defaults_empty():
    from ink_engine.core.pool_governance import proposal_from_node_draft

    assert proposal_from_node_draft({"node_type": "x"})["node_id"] == "x"
    assert proposal_from_node_draft({})["node_id"] == ""
    assert proposal_from_node_draft({})["fields"] == ()


def test_weekly_proposal_usage_window():
    """周提案预算的已用口径：时间窗口内条数（越窗不重复扣预算）。"""
    import time

    from ink_engine.core.pool_governance import weekly_proposal_usage

    now = time.time()
    records = [
        {"node_id": "a", "ts": now - 3600},       # 本周内
        {"node_id": "b", "ts": now - 6 * 86400},  # 本周内（< 7 天）
        {"node_id": "c", "ts": now - 8 * 86400},  # 越窗
        {"node_id": "d"},                         # 无 ts = 按当前计
    ]
    assert weekly_proposal_usage(records, now=now) == 3
    assert weekly_proposal_usage(records, now=now + 86400) == 3


def test_pool_nodes_from_registry_contracts_only():
    """注册表 → 治理快照：只取带契约类型，字段 = 产出字段名集。"""
    from ink_engine.core.contracts import NodeContract
    from ink_engine.core.pool_governance import pool_nodes_from_registry
    from ink_engine.core.registry import NodeTypeRegistry

    registry = NodeTypeRegistry()
    registry.register("plain", lambda config: (lambda ctx: None), contract=None)
    registry.register(
        "with_contract",
        lambda config: (lambda ctx: None),
        contract=NodeContract(
            input_schema=_spec("in", _field("q", required=True)),
            output_schema=_spec("out", _field("result"), _field("extra")),
        ),
    )
    nodes = pool_nodes_from_registry(registry)
    assert [n.node_id for n in nodes] == ["with_contract"]
    assert set(nodes[0].fields) == {"result", "extra"}


def _spec(name: str, *fields: Any) -> Any:
    from ink_engine.core.schema_validator import SchemaSpec

    return SchemaSpec(name=name, fields=tuple(fields))


def _field(name: str, required: bool = False) -> Any:
    from ink_engine.core.schema_validator import FIELD_STRING, SchemaField

    return SchemaField(name=name, required=required, kind=FIELD_STRING)


def test_governed_evaluate_rejects_when_budget_exhausted():
    """接线闭环：提案经治理判定（预算耗尽 = reject）——结点提案链路
    四规则生效的判定面断言。"""
    from ink_engine.core.pool_governance import (
        GOV_VERDICT_REJECT,
        proposal_from_node_draft,
        weekly_proposal_usage,
    )

    gov = PoolGovernance()
    record = {
        "node_type": "new_node",
        "output_schema": {
            "name": "new_node.output",
            "fields": [{"name": "result", "required": True}],
        },
    }
    # 预算窗口内已用满（登记 3 条）
    import time

    for _ in range(3):
        gov.evaluate(
            {"node_id": "old", "fields": ["a"]},
            {"pool_count": 1, "used_this_week": 0, "pool_nodes": []},
        )
    snapshot = {
        "pool_count": 2,
        "used_this_week": weekly_proposal_usage(gov.log, now=time.time()),
        "pool_nodes": [],
    }
    verdict = gov.evaluate(proposal_from_node_draft(record), snapshot)
    assert verdict.verdict == GOV_VERDICT_REJECT
    assert any("预算" in r for r in verdict.reasons)
