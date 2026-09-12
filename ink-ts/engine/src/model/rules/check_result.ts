/**
 * 单条规则评估的原语与结果容器（rules.py RuleCheckResult/_evaluate_once
 * 移植）。
 *
 * fail-open 的留痕分两个面：skipped = 跳过明细（谓词异常/数据不适用，
 * 观测而不阻断）；broken = 失效明细（谓词执行异常或产出畸形——返回
 * 非 dict/缺 message 的规则 = 规则本身失效，样例闸门据此拒绝，静默
 * 失效的规则不得骗过闸门）。数据不适用类跳过（目标缺失/非集合）不属
 * 失效，只入 skipped。GraphDefinitionError 为声明错误，穿透不吞（建图
 * 期应暴露的配置错误不得被 fail-open 掩盖）。
 */

import type { JsonRecord } from '../json.js';
import { isRecord, typeName } from '../json.js';
import { GraphDefinitionError } from '../errors.js';
import { SEVERITY_ERROR, type RawIssue, type RulePredicate } from './_types.js';
import { RuleViolation } from './rule_data.js';
import type { Rule } from './rule_data.js';

/** 一次规则评估结果（违规 + 跳过留痕——fail-open 可审计）。 */
export class RuleCheckResult {
  /** 违规清单（按规则声明序）。 */
  readonly issues: readonly RuleViolation[];
  /** 跳过规则明细 ((rule_id, reason)…)——谓词异常/数据不适用留痕。 */
  readonly skipped: readonly (readonly [string, string])[];
  /** 失效跳过明细 ((rule_id, reason)…)——谓词执行异常或产出畸形的规则。 */
  readonly broken: readonly (readonly [string, string])[];
  /** 实际执行（未被跳过）的规则数。 */
  readonly checked: number;

  constructor(init: {
    issues: readonly RuleViolation[];
    skipped?: readonly (readonly [string, string])[];
    broken?: readonly (readonly [string, string])[];
    checked?: number;
  }) {
    this.issues = [...init.issues];
    this.skipped = init.skipped === undefined ? [] : [...init.skipped];
    this.broken = init.broken === undefined ? [] : [...init.broken];
    this.checked = init.checked ?? 0;
    Object.freeze(this);
  }

  /** 是否存在需裁决的硬冲突（error 级）——与领域校验语义对齐。 */
  has_hard_conflict(): boolean {
    return this.issues.some((issue) => issue.severity === SEVERITY_ERROR);
  }
}

/**
 * 单条目标执行谓词并归一化违规（异常 fail-open 跳过留痕）。
 *
 * 谓词执行异常与产出畸形（非 dict/缺 message）同时计入失效明细
 * （broken）——样例闸门据此拒绝静默失效的规则。
 *
 * @returns 本条目标产出的违规清单（无效产出就地丢弃并留痕）。
 */
export function evaluateOnce(
  predicate: RulePredicate,
  target: unknown,
  rule: Rule,
  context: JsonRecord,
  skipped: [string, string][],
  broken: [string, string][],
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  let rawIssues: RawIssue[] | undefined;
  try {
    rawIssues = predicate(target, rule.config, context);
  } catch (err) {
    if (err instanceof GraphDefinitionError) {
      throw err; // 声明错误穿透（谓词自身配置校验失败 = 建图期应暴露）
    }
    const reason = `谓词执行异常（fail-open 跳过）: ${errMessage(err)}`;
    skipped.push([rule.id, reason]);
    broken.push([rule.id, reason]);
    return violations;
  }
  for (const raw of rawIssues ?? []) {
    if (!isRecord(raw)) {
      const reason = `谓词返回非 dict 违规: ${typeName(raw)}`;
      skipped.push([rule.id, reason]);
      broken.push([rule.id, reason]);
      continue;
    }
    const message = raw['message'];
    if (typeof message !== 'string' || !message) {
      const reason = '谓词违规缺 message';
      skipped.push([rule.id, reason]);
      broken.push([rule.id, reason]);
      continue;
    }
    violations.push(
      new RuleViolation({
        rule_id: rule.id,
        kind: rule.kind,
        severity: raw['severity'] ? String(raw['severity']) : rule.severity,
        message,
        entity_type: rule.entity_type,
        entity_id: raw['entity_id'],
      }),
    );
  }
  return violations;
}

/** 异常消息字符串化（Python str(exc) 口径：Error 取 message，其余兜底）。 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}