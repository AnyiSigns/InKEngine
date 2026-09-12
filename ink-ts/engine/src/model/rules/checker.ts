/**
 * 混合判定门面（rules.py ConstraintChecker 段移植）。
 *
 * 混合判定语义（v4 已确立的 fail-open 模式）：确定性规则引擎跑声明式
 * 规则（快/可测/可审计）；规则覆盖不到的深度启发式经 llm_hook 退回
 * LLM 判定。钩子异常/超时仅留痕跳过，绝不阻断主流程——检查是增强护栏
 * 不是写门禁。钩子返回的形态非法条目（非 dict/缺 message）就地丢弃并
 * 留日志；日志留痕属观察面副作用，纯核心省略，归一化规则本身即文档。
 */

import type { Json, JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import { HOOK_RULE_ID, SEVERITY_ERROR, type RawIssue } from './_types.js';
import { RuleCheckResult, errMessage } from './check_result.js';
import { RuleEngine } from './engine.js';
import { RuleViolation } from './rule_data.js';
import type { RuleSet } from './rule_data.js';

/**
 * LLM 钩子签名：深度启发式补充判定（返回违规清单；异常 fail-open 跳过）。
 *
 * 入参 = (数据对象, 评估上下文, 确定性规则已产出的违规)。
 */
export type RuleHook = (
  data: unknown,
  context: JsonRecord,
  issues: readonly RuleViolation[],
) => RawIssue[] | Promise<RawIssue[]>;

/** 约束检查器：确定性规则 + 可选 LLM 钩子的混合判定门面。 */
export class ConstraintChecker {
  readonly engine: RuleEngine;
  readonly llm_hook: RuleHook | null;

  constructor(init?: { engine?: RuleEngine | null; llm_hook?: RuleHook | null }) {
    this.engine = init?.engine ?? new RuleEngine();
    this.llm_hook = init?.llm_hook ?? null;
  }

  /**
   * 组合评估：确定性规则 → LLM 钩子补充（异常 fail-open）。
   *
   * @returns 违规 = 确定性 + 钩子并集；skipped 含钩子失败留痕
   *   （rule_id = "__llm_hook__"）。
   */
  async check(
    rule_set: RuleSet,
    data: unknown,
    options?: { context?: JsonRecord | null },
  ): Promise<RuleCheckResult> {
    const result = this.engine.evaluate(rule_set, data, options);
    if (this.llm_hook === null) {
      return result;
    }
    const mergedContext: JsonRecord = { root: data as Json, ...(options?.context ?? {}) };
    let hookIssues: RawIssue[];
    try {
      hookIssues = await this.llm_hook(data, mergedContext, result.issues);
    } catch (err) {
      return new RuleCheckResult({
        issues: result.issues,
        skipped: [...result.skipped, [HOOK_RULE_ID, `钩子异常: ${errMessage(err)}`]],
        broken: result.broken,
        checked: result.checked,
      });
    }
    const extra = normalizeHookIssues(hookIssues);
    return new RuleCheckResult({
      issues: [...result.issues, ...extra],
      skipped: result.skipped,
      broken: result.broken,
      checked: result.checked,
    });
  }
}

/**
 * 钩子返回违规清单 → RuleViolation 归一化（形态非法条目丢弃并留痕）。
 *
 * rule_id/kind/severity 取声明值或默认占位（钩子违规可溯源到
 * "__llm_hook__"）；entity_type/entity_id 非字符串形态按 null 兜底。
 */
export function normalizeHookIssues(rawIssues: readonly RawIssue[] | null | undefined): RuleViolation[] {
  const normalized: RuleViolation[] = [];
  for (const raw of rawIssues ?? []) {
    if (!isRecord(raw)) {
      continue; // 非 dict 条目丢弃（Python 侧 logging 留痕省略）
    }
    const message = raw['message'];
    if (typeof message !== 'string' || !message) {
      continue; // 缺 message 条目丢弃（留痕同上）
    }
    normalized.push(
      new RuleViolation({
        rule_id: raw['rule_id'] ? String(raw['rule_id']) : HOOK_RULE_ID,
        kind: raw['kind'] ? String(raw['kind']) : 'rule',
        severity: raw['severity'] ? String(raw['severity']) : SEVERITY_ERROR,
        message,
        entity_type: typeof raw['entity_type'] === 'string' ? raw['entity_type'] : null,
        entity_id: raw['entity_id'] !== undefined ? (raw['entity_id'] as Json) : null,
      }),
    );
  }
  return normalized;
}