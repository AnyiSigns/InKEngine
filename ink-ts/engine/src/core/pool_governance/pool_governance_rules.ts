/**
 * 结点池治理的规则判定纯函数（pool_governance.py 移植，判定面无状态）。
 *
 * 四条规则全部为**规则判定纯函数 + 登记记录**，不执行任何决策（是否采纳
 * 由宿主按既有评审通道裁决）：容量上限（满则须带淘汰候选）、死结点淘汰
 * （零调用且未转正且超龄 → 标记失效登记）、近重复合并（字段 Jaccard 或
 * 目的嵌入余弦超阈值 → 转合并提案）、提案预算（周窗口余量，耗尽拒绝）。
 *
 * 数值为默认可配（引擎钉死默认，宿主可覆盖）；本文件不含时间副作用。
 */

import { GovernanceVerdict } from './pool_governance_types.js';
import type { ProposalKnobs, ProposalSnapshot } from './pool_governance_types.js';

// 容量上限（每域 N_max = 500 结点；满则新提案须带淘汰候选）
export const POOL_CAPACITY_MAX = 500;

// 死结点淘汰：usage_count = 0 且未转正且 age > 90 天 → 标记失效
export const DEAD_NODE_MIN_AGE_DAYS = 90;

// 近重复合并判定阈值（字段 Jaccard > 0.8 或目的嵌入余弦 > 0.9）
export const MERGE_JACCARD_THRESHOLD = 0.8;
export const MERGE_COSINE_THRESHOLD = 0.9;

// 提案预算（默认 3/周/域）
export const PROPOSAL_WEEKLY_BUDGET = 3;

// 池治理登记种类（声明式枚举，防魔法字符串）
export const GOV_VERDICT_ALLOW = 'allow';
export const GOV_VERDICT_REJECT = 'reject';
export const GOV_VERDICT_MERGE = 'merge';
export const GOV_INVALIDATE = 'invalidate';

/** 容量判定：池内结点数 ≥ 上限 = 满（新提案须带淘汰候选）。 */
export function at_capacity(pool_count: number, options: { capacity?: number } = {}): boolean {
  return pool_count >= (options.capacity ?? POOL_CAPACITY_MAX);
}

/** 死结点淘汰判定：usage_count = 0 且未转正且 age > 90 天。 */
export function dead_node_eligible(
  usage_count: number,
  age_days: number,
  options: { promoted?: boolean; min_age_days?: number } = {},
): boolean {
  const { promoted = false, min_age_days = DEAD_NODE_MIN_AGE_DAYS } = options;
  if (usage_count !== 0 || promoted) return false;
  return age_days > min_age_days;
}

/** 失效登记记录（标记失效而非物理删；随治理日志落审计）。 */
export function invalidation_record(
  node_id: string,
  reason: string,
  options: { ts?: number } = {},
): Record<string, unknown> {
  return {
    action: GOV_INVALIDATE,
    node_id,
    reason,
    ts: options.ts ?? 0,
  };
}

/** 字段集合 Jaccard 相似度（0-1；空集 = 0，防除零）。 */
export function fields_jaccard(fields_a: readonly string[], fields_b: readonly string[]): number {
  const a = new Set(fields_a);
  const b = new Set(fields_b);
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** 字段 Jaccard > 阈值 = 近重复（转合并提案，拒绝重复入池）。 */
export function near_duplicate_by_fields(
  fields_a: readonly string[],
  fields_b: readonly string[],
  options: { threshold?: number } = {},
): boolean {
  return fields_jaccard(fields_a, fields_b) > (options.threshold ?? MERGE_JACCARD_THRESHOLD);
}

/** 目的嵌入余弦 > 阈值 = 近重复（转合并提案）。 */
export function near_duplicate_by_embedding(
  cosine: number,
  options: { threshold?: number } = {},
): boolean {
  return cosine > (options.threshold ?? MERGE_COSINE_THRESHOLD);
}

/** 本周提案余量（上限扣已用；负数按 0 计）。 */
export function proposal_budget_remaining(
  used_this_week: number,
  options: { weekly_budget?: number } = {},
): number {
  const budget = options.weekly_budget ?? PROPOSAL_WEEKLY_BUDGET;
  return Math.max(0, budget - Math.max(0, used_this_week));
}

/**
 * 提案综合判定（纯函数）：预算 → 容量 → 近重复 → 死结点候选。
 *
 * 判定只产出登记记录，不执行任何动作（放行 = 进入宿主评审通道；
 * 淘汰候选/合并目标供宿主参考）。合并原因中的阈值文字随 Python
 * 消息形态逐字保留（判定边界数值仍以常量旋钮为准）。
 */
export function evaluate_proposal(
  node_id: string,
  fields: readonly string[],
  snapshot: ProposalSnapshot,
  knobs: ProposalKnobs = {},
): GovernanceVerdict {
  const { capacity = POOL_CAPACITY_MAX, weekly_budget = PROPOSAL_WEEKLY_BUDGET } = knobs;
  const remaining = proposal_budget_remaining(snapshot.used_this_week, { weekly_budget });
  if (remaining <= 0) {
    return new GovernanceVerdict({
      verdict: GOV_VERDICT_REJECT,
      reasons: ['提案预算已耗尽（3/周/域）'],
      budget_remaining: 0,
    });
  }
  const poolNodes = snapshot.pool_nodes ?? [];
  for (const node of poolNodes) {
    if (node.node_id === node_id) continue;
    if (near_duplicate_by_fields(fields, node.fields)) {
      return new GovernanceVerdict({
        verdict: GOV_VERDICT_MERGE,
        reasons: [
          `与池内结点 ${node.node_id} 字段近重复（Jaccard ${fields_jaccard(fields, node.fields).toFixed(2)} > 0.8）`,
        ],
        merge_target: node.node_id,
        budget_remaining: remaining,
      });
    }
    const cosine = snapshot.duplicate_cosine ?? 0;
    if (near_duplicate_by_embedding(cosine)) {
      return new GovernanceVerdict({
        verdict: GOV_VERDICT_MERGE,
        reasons: [
          `与池内结点 ${node.node_id} 目的嵌入近重复（余弦 ${cosine.toFixed(2)} > 0.9）`,
        ],
        merge_target: node.node_id,
        budget_remaining: remaining,
      });
    }
  }
  const full = at_capacity(snapshot.pool_count, { capacity });
  const dead: string[] = [];
  for (const node of poolNodes) {
    if (dead_node_eligible(node.usage_count, node.age_days, { promoted: node.promoted })) {
      dead.push(node.node_id);
    }
  }
  return new GovernanceVerdict({
    verdict: GOV_VERDICT_ALLOW,
    reasons: full ? ['容量已满（须携带淘汰候选）'] : [],
    eviction_required: full,
    eviction_candidates: dead,
    budget_remaining: remaining,
  });
}
