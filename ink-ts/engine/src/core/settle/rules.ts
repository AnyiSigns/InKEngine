/**
 * 沉淀判据纯函数层（提案/晋升/复审/契约草案/失败分类）。
 *
 * 对标 ink_engine.core.settle 的 classify_failure / should_propose /
 * recommended_prior_eligible / policy_edge_needs_review / draft_node_contract。
 * 全部为纯函数（无 IO / 无副作用）：判据输入 = 计数或证据行，输出 =
 * 决定/草案数据；钩子层负责登记与落库。
 */

import type { EdgeEvidence } from '../edge_evidence/_types.js';
import { laplace_success } from '../edge_evidence/tier_model.js';
import { SchemaField, SchemaSpec } from '../schema/schemaValidator.js';
import {
  FAIL_CAT_MODEL,
  FAIL_CAT_NETWORK,
  FAIL_CAT_PERMISSION,
  FAIL_CAT_UNKNOWN,
  FAIL_CAT_VALIDATION,
  POLICY_REVIEW_FAIL_THRESHOLD,
  PROMOTION_MIN_N,
  PROMOTION_MIN_P,
  PROPOSAL_FAIL_RATE,
  PROPOSAL_MIN_FAILS,
  PROPOSAL_RATE_MIN_N,
} from './_constants.js';

// ── 失败归因分类（error 事件 message 分类器）──
// 纯关键词分类（无 LLM）；命中多类按优先级 permission>validation>
// network>model 取首类，均无 → unknown（能力缺口兜底）。

export function classify_failure(message: string | null): string {
  const text = (message ?? '').toLowerCase();
  const has = (...keywords: string[]): boolean =>
    keywords.some((k) => text.includes(k));
  if (
    has('permission', 'forbidden', 'denied', 'unauthorized', '403')
  ) {
    return FAIL_CAT_PERMISSION;
  }
  if (
    has('validation', 'schema', 'invalid', '400', 'malformed')
  ) {
    return FAIL_CAT_VALIDATION;
  }
  if (
    has('network', 'timeout', 'connection', 'dns', '502', '503', '504')
  ) {
    return FAIL_CAT_NETWORK;
  }
  if (
    has(
      'model',
      'llm',
      'context length',
      'context_length',
      'max tokens',
      'max_tokens',
      'rate limit',
      'rate_limit',
      '429',
      'token',
      'quota',
      'insufficient',
      'billing',
    )
  ) {
    return FAIL_CAT_MODEL;
  }
  return FAIL_CAT_UNKNOWN;
}

// ── 失败点提案判据 ───────────────────────────────────────────────────────────

/**
 * 失败点提案判据：同一失败点累计 N≥3 次或入边失败率>0.4。
 * 入边失败率判定须至少 2 个样本（单样本偶发失败不污染评审队列）。
 */
export function should_propose(fail_count: number, success_count: number): boolean {
  if (fail_count >= PROPOSAL_MIN_FAILS) {
    return true;
  }
  const n = fail_count + success_count;
  if (n < PROPOSAL_RATE_MIN_N) {
    return false;
  }
  return fail_count / n > PROPOSAL_FAIL_RATE;
}

// ── 推荐先验晋升证据判据 ─────────────────────────────────────────────────────

/**
 * 推荐先验晋升证据判据：N≥30 且成功率≥0.9（拉普拉斯口径）。
 * 与信任档推导式（转正档）同一组常数——纯算法自动晋升，零审批；
 * 路径级晋升 = 每条遍历边均达此线 + 闸门 + canary（见钩子）。
 */
export function recommended_prior_eligible(
  success_count: number,
  fail_count: number,
): boolean {
  const n = success_count + fail_count;
  return (
    n >= PROMOTION_MIN_N &&
    laplace_success(success_count, fail_count) >= PROMOTION_MIN_P
  );
}

// ── 策略边对抗复审判据 ───────────────────────────────────────────────────────

/**
 * 策略边对抗复审判据：失败累计≥5，或所在域证据均值反超其承诺。
 * - 失败累计超阈值（默认 5 次）：对抗证据直接触发；
 * - 域证据均值反超：该策略边成功率低于同域非策略边均值——普通统计边已比
 *   「人工堤坝」更可靠，承诺失去优先依据；
 * - domain_average_p 为 null（非策略边样本不足）= 只按失败累计判定。
 * 返回 [是否复审, 原因]；复审动作（L2 提请 + 降级）由钩子执行。
 */
export function policy_edge_needs_review(
  evidence: EdgeEvidence,
  opts: { domain_average_p?: number | null } = {},
): [boolean, string] {
  const domainAverageP = opts.domain_average_p ?? null;
  if (!evidence.policy) {
    return [false, ''];
  }
  if (evidence.fail_count >= POLICY_REVIEW_FAIL_THRESHOLD) {
    return [
      true,
      `策略边失败累计 ${evidence.fail_count} 次` +
        ` ≥ 阈值 ${POLICY_REVIEW_FAIL_THRESHOLD}（对抗证据触发复审）`,
    ];
  }
  if (domainAverageP !== null) {
    const p = laplace_success(evidence.success_count, evidence.fail_count);
    if (p < domainAverageP) {
      return [
        true,
        `策略边成功率 ${p.toFixed(2)} 低于域证据均值 ${domainAverageP.toFixed(2)}` +
          '（域均值反超承诺，触发复审）',
      ];
    }
  }
  return [false, ''];
}

// ── 失败点契约草案 ───────────────────────────────────────────────────────────

/**
 * 失败点契约草案生成（纯函数）：从字段缺口反推输入/输出契约。
 * 草案 = schema 声明（SchemaSpec 数据形态）而非代码——评审走宿主 vetting，
 * 转正后才进结点池。consumes = 缺失的输入字段，produces = 应产出的字段；
 * 字段名去重保序，缺省 type=string/required=True（草案语义：缺口字段必填）。
 */
export function draft_node_contract(
  node_type: string,
  opts: { consumes?: readonly string[]; produces?: readonly string[]; note?: string } = {},
): Record<string, unknown> {
  const consumes = opts.consumes ?? [];
  const produces = opts.produces ?? [];
  const inputFields = [...new Set(consumes)].map(
    (name) => new SchemaField({ name, required: true, kind: 'string' }),
  );
  const outputFields = [...new Set(produces)].map(
    (name) => new SchemaField({ name, required: true, kind: 'string' }),
  );
  const draft: Record<string, unknown> = {
    node_type,
    input_schema: new SchemaSpec({ name: `${node_type}.input`, fields: inputFields }).to_dict(),
    output_schema: new SchemaSpec({ name: `${node_type}.output`, fields: outputFields }).to_dict(),
  };
  if (opts.note) {
    draft['note'] = opts.note;
  }
  return draft;
}
