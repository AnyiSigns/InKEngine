"""结点池治理（容量/淘汰/合并/预算四条规则；只判定登记不执行决策）。

池子不能只长不收——四条治理规则全部为**规则判定纯函数 + 登记记录**，
不执行任何决策（是否采纳由宿主按既有评审通道裁决）：

- **容量上限**：每域 N_max = 500 结点；达上限时新提案必须携带
  「淘汰候选」（替换谁）才进入评审；
- **死结点淘汰**：usage_count = 0 且未转正且 age > 90 天 → 标记失效
  （不物理删，沿用「标记失效而非物理删」语义）；失效结点不可参与
  组装与检索；
- **近重复合并**：新提案契约与池中结点相似（字段 Jaccard > 0.8 或
  目的嵌入余弦 > 0.9）→ 转为合并提案（走审批），拒绝重复入池；
- **提案预算**：每周期提案数上限（默认 3/周/域），防自动生成的
  垃圾/一次性技能堆积。

数值为默认可配（引擎钉死默认，宿主可覆盖）。本模块无 I/O、无
LLM——判定输入为池快照（由调用方提供），输出为登记记录。
"""
from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

# 容量上限（每域 N_max = 500 结点；满则新提案须带淘汰候选）
POOL_CAPACITY_MAX = 500

# 死结点淘汰：usage_count = 0 且未转正且 age > 90 天 → 标记失效
DEAD_NODE_MIN_AGE_DAYS = 90

# 近重复合并判定阈值（字段 Jaccard > 0.8 或目的嵌入余弦 > 0.9）
MERGE_JACCARD_THRESHOLD = 0.8
MERGE_COSINE_THRESHOLD = 0.9

# 提案预算（默认 3/周/域）
PROPOSAL_WEEKLY_BUDGET = 3

# 池治理登记种类（声明式枚举，防魔法字符串）
GOV_VERDICT_ALLOW = "allow"
GOV_VERDICT_REJECT = "reject"
GOV_VERDICT_MERGE = "merge"
GOV_INVALIDATE = "invalidate"


@dataclass(frozen=True, slots=True)
class PoolNodeSnapshot:
    """池内结点快照（治理判定的输入；数据由调用方汇总）。"""

    node_id: str
    usage_count: int = 0
    promoted: bool = False  # 是否已转正（推荐先验待遇）
    age_days: float = 0.0
    fields: tuple[str, ...] = ()  # 契约字段名集合（Jaccard 判定输入）
    domain: str = "default"


@dataclass(frozen=True, slots=True)
class GovernanceVerdict:
    """治理判定记录（只登记不执行：宿主据此走既有评审通道）。

    Attributes:
        verdict: allow（放行评审）/ reject（拒绝）/ merge（转合并提案）。
        reasons: 判定原因清单（可审计可展示）。
        eviction_required: 容量满时是否须携带淘汰候选。
        eviction_candidates: 死结点淘汰候选清单（标记失效登记）。
        merge_target: 近重复命中的池内结点 id（verdict=merge 时非空）。
        budget_remaining: 本周提案余量（0 = 预算耗尽）。
    """

    verdict: str
    reasons: tuple[str, ...] = ()
    eviction_required: bool = False
    eviction_candidates: tuple[str, ...] = ()
    merge_target: str = ""
    budget_remaining: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "reasons": list(self.reasons),
            "eviction_required": self.eviction_required,
            "eviction_candidates": list(self.eviction_candidates),
            "merge_target": self.merge_target,
            "budget_remaining": self.budget_remaining,
        }


def at_capacity(pool_count: int, *, capacity: int = POOL_CAPACITY_MAX) -> bool:
    """容量判定：池内结点数 ≥ 上限 = 满（新提案须带淘汰候选）。"""
    return pool_count >= capacity


def dead_node_eligible(
    usage_count: int,
    *,
    promoted: bool = False,
    age_days: float,
    min_age_days: float = DEAD_NODE_MIN_AGE_DAYS,
) -> bool:
    """死结点淘汰判定：usage_count = 0 且未转正且 age > 90 天。"""
    if usage_count != 0 or promoted:
        return False
    return age_days > min_age_days


def invalidation_record(node_id: str, reason: str, *, ts: float | None = None) -> dict[str, Any]:
    """失效登记记录（标记失效而非物理删；随治理日志落审计）。"""
    return {
        "action": GOV_INVALIDATE,
        "node_id": node_id,
        "reason": reason,
        "ts": ts if ts is not None else time.time(),
    }


def fields_jaccard(fields_a: Sequence[str], fields_b: Sequence[str]) -> float:
    """字段集合 Jaccard 相似度（0-1；空集 = 0，防除零）。"""
    a = set(fields_a)
    b = set(fields_b)
    if not a and not b:
        return 0.0
    union = a | b
    return len(a & b) / len(union)


def near_duplicate_by_fields(
    fields_a: Sequence[str],
    fields_b: Sequence[str],
    *,
    threshold: float = MERGE_JACCARD_THRESHOLD,
) -> bool:
    """字段 Jaccard > 阈值 = 近重复（转合并提案，拒绝重复入池）。"""
    return fields_jaccard(fields_a, fields_b) > threshold


def near_duplicate_by_embedding(
    cosine: float, *, threshold: float = MERGE_COSINE_THRESHOLD
) -> bool:
    """目的嵌入余弦 > 阈值 = 近重复（转合并提案）。"""
    return cosine > threshold


def proposal_budget_remaining(
    used_this_week: int, *, weekly_budget: int = PROPOSAL_WEEKLY_BUDGET
) -> int:
    """本周提案余量（上限扣已用；负数按 0 计）。"""
    return max(0, weekly_budget - max(0, used_this_week))


def evaluate_proposal(
    node_id: str,
    fields: Sequence[str],
    *,
    pool_count: int,
    used_this_week: int,
    pool_nodes: Sequence[PoolNodeSnapshot] = (),
    duplicate_cosine: float = 0.0,
    capacity: int = POOL_CAPACITY_MAX,
    weekly_budget: int = PROPOSAL_WEEKLY_BUDGET,
) -> GovernanceVerdict:
    """提案综合判定（纯函数）：预算 → 容量 → 近重复 → 死结点候选。

    判定只产出登记记录，不执行任何动作（放行 = 进入宿主评审通道；
    淘汰候选/合并目标供宿主参考）。
    """
    remaining = proposal_budget_remaining(used_this_week, weekly_budget=weekly_budget)
    if remaining <= 0:
        return GovernanceVerdict(
            verdict=GOV_VERDICT_REJECT,
            reasons=("提案预算已耗尽（3/周/域）",),
            budget_remaining=0,
        )
    for node in pool_nodes:
        if node.node_id == node_id:
            continue
        if near_duplicate_by_fields(fields, node.fields):
            return GovernanceVerdict(
                verdict=GOV_VERDICT_MERGE,
                reasons=(
                    f"与池内结点 {node.node_id} 字段近重复"
                    f"（Jaccard {fields_jaccard(fields, node.fields):.2f} > 0.8）",
                ),
                merge_target=node.node_id,
                budget_remaining=remaining,
            )
        if near_duplicate_by_embedding(duplicate_cosine):
            return GovernanceVerdict(
                verdict=GOV_VERDICT_MERGE,
                reasons=(
                    f"与池内结点 {node.node_id} 目的嵌入近重复"
                    f"（余弦 {duplicate_cosine:.2f} > 0.9）",
                ),
                merge_target=node.node_id,
                budget_remaining=remaining,
            )
    full = at_capacity(pool_count, capacity=capacity)
    dead = [
        node.node_id
        for node in pool_nodes
        if dead_node_eligible(
            node.usage_count, promoted=node.promoted, age_days=node.age_days
        )
    ]
    return GovernanceVerdict(
        verdict=GOV_VERDICT_ALLOW,
        reasons=(
            ("容量已满（须携带淘汰候选）",) if full else (),
        ),
        eviction_required=full,
        eviction_candidates=tuple(dead),
        budget_remaining=remaining,
    )


class PoolGovernance:
    """池治理登记器：调用纯规则判定并登记记录（append-only）。

    判定本身不执行任何决策——登记记录供宿主走既有评审通道时参考
    与审计追溯。
    """

    def __init__(self) -> None:
        self.log: list[dict[str, Any]] = []

    def evaluate(self, proposal: dict[str, Any], snapshot: dict[str, Any]) -> GovernanceVerdict:
        """判定一次新结点提案并登记（输入 = 提案数据 + 池快照）。

        snapshot 形态：``{"pool_count": int, "used_this_week": int,
        "pool_nodes": [PoolNodeSnapshot dict 或对象], "duplicate_cosine": float}``。
        """
        fields = tuple(proposal.get("fields") or ())
        pool_nodes = [
            node if isinstance(node, PoolNodeSnapshot) else PoolNodeSnapshot(**node)
            for node in snapshot.get("pool_nodes") or ()
        ]
        verdict = evaluate_proposal(
            str(proposal.get("node_id", "")),
            fields,
            pool_count=int(snapshot.get("pool_count", 0)),
            used_this_week=int(snapshot.get("used_this_week", 0)),
            pool_nodes=pool_nodes,
            duplicate_cosine=float(snapshot.get("duplicate_cosine", 0.0)),
        )
        record = {
            "node_id": proposal.get("node_id", ""),
            "ts": time.time(),
            **verdict.to_dict(),
        }
        self.log.append(record)
        return verdict

    def dead_node_records(self) -> list[dict[str, Any]]:
        """本登记器历史中全部死结点失效登记（标记失效不物理删）。

        ENG9b-9 统一：旧实现按 log 中的 ``action`` 键过滤——判定记录
        （``evaluate`` 产出）从不带 ``action`` 键，恒返回空清单（死代码）。
        现由判定记录的 ``eviction_candidates`` 派生失效登记（判定与登记
        同源：候选清单即淘汰登记的依据，不重复落 log——log 保持纯判定
        记录，周预算统计（weekly_proposal_usage）不被淘汰登记污染）。
        """
        out: list[dict[str, Any]] = []
        for record in self.log:
            for node_id in record.get("eviction_candidates") or ():
                out.append(
                    invalidation_record(
                        str(node_id),
                        "死结点淘汰（零调用且超龄）",
                        ts=record.get("ts"),
                    )
                )
        return out


def pool_nodes_from_registry(registry: Any) -> list[PoolNodeSnapshot]:
    """结点类型注册表 → 治理快照结点清单（契约字段名集 = Jaccard 判定输入）。

    只取带契约的类型（与组装池同源：无契约结点不参与组装，也不参与
    治理的合并/淘汰判定）；字段集 = 产出字段名（结点对下游的语义面）。
    """
    from .link_validator import produced_field_names

    nodes: list[PoolNodeSnapshot] = []
    for type_name in registry.types():
        contract = registry.contract_for(type_name)
        if contract is None:
            continue
        nodes.append(
            PoolNodeSnapshot(
                node_id=str(type_name),
                fields=tuple(sorted(produced_field_names(contract.output_schema))),
            )
        )
    return nodes


def weekly_proposal_usage(
    records: Sequence[dict[str, Any]],
    *,
    now: float | None = None,
    week_seconds: float = 7 * 24 * 3600,
) -> int:
    """治理登记历史 → 本周提案已用数（时间窗口内条数；无 ts = 按当前计）。

    提案预算规则（3/周/域）的「已用」口径：以登记记录时间戳计窗口内
    提案条数（含预算耗尽拒绝前的放行登记——预算扣减发生在登记时点）。
    无时间戳记录按当前窗口计（刚登记的登记器历史，无从落在旧窗口）。
    """
    current = now if now is not None else time.time()
    cutoff = current - week_seconds
    total = 0
    for record in records:
        ts = record.get("ts")
        if ts is None:
            total += 1  # 无时间戳 = 视为当前窗口
            continue
        if float(ts) >= cutoff:
            total += 1
    return total


def proposal_from_node_draft(record: Mapping[str, Any]) -> dict[str, Any]:
    """失败点结点提案记录 → 治理提案形态（node_id/fields 归一）。

    记录形态（NodeProposalSettleHook 产出）：``node_type`` + 契约草案
    （input_schema/output_schema，SchemaSpec dict 形态）；治理判定的
    字段集 = 产出字段名（Jaccard 合并/近重复判定的语义面）。未知形态
    的键缺省空——判定按缺省走（不因归一失败抛错）。
    """
    schema = record.get("output_schema") or {}
    fields: list[str] = []
    for field in schema.get("fields") or ():
        if isinstance(field, dict) and field.get("name"):
            fields.append(str(field["name"]))
    return {
        "node_id": str(record.get("node_type") or record.get("node_id") or ""),
        "fields": tuple(fields),
    }


__all__ = [
    "DEAD_NODE_MIN_AGE_DAYS",
    "GOV_INVALIDATE",
    "GOV_VERDICT_ALLOW",
    "GOV_VERDICT_MERGE",
    "GOV_VERDICT_REJECT",
    "MERGE_COSINE_THRESHOLD",
    "MERGE_JACCARD_THRESHOLD",
    "POOL_CAPACITY_MAX",
    "PROPOSAL_WEEKLY_BUDGET",
    "GovernanceVerdict",
    "PoolGovernance",
    "PoolNodeSnapshot",
    "at_capacity",
    "dead_node_eligible",
    "evaluate_proposal",
    "fields_jaccard",
    "invalidation_record",
    "near_duplicate_by_embedding",
    "near_duplicate_by_fields",
    "pool_nodes_from_registry",
    "proposal_budget_remaining",
    "proposal_from_node_draft",
    "weekly_proposal_usage",
]
