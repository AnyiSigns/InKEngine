/**
 * 确定性规则引擎（rules.py RuleEngine 段移植）。
 *
 * 执行语义：只执行 constraint/transition 规则（规则集里的其它类型声明
 * 在 evaluate 前经 RuleSet.parse 校验拒绝）；每规则按 target_path 提取
 * 检查对象，路径解析失败（字段缺失）= 规则不适用，跳过留痕（适用性
 * 断言显式用 present/absent 谓词）；谓词异常 fail-open——跳过该规则并
 * 留痕（规则引擎是增强护栏不是写门禁，任一环节异常不阻断整体评估）；
 * 未知谓词名 = 声明错误，抛 GraphDefinitionError（不静默跳过——引用即
 * 错误，注册期/解析期暴露）。
 */

import { isRecord } from '../json.js';
import type { Json, JsonRecord } from '../json.js';
import { getPath } from './_path.js';
import { evaluateOnce, RuleCheckResult } from './check_result.js';
import { RuleTypeRegistry } from './registry.js';
import { _EXECUTABLE_RULE_TYPES } from './_types.js';
import type { RuleSet } from './rule_data.js';
import type { RuleViolation } from './rule_data.js';

/** 确定性规则引擎：规则集 × 数据对象 → 违规清单。 */
export class RuleEngine {
  readonly registry: RuleTypeRegistry;

  constructor(registry?: RuleTypeRegistry | null) {
    this.registry = registry ?? new RuleTypeRegistry();
  }

  /**
   * 评估规则集对数据对象的违规清单。
   *
   * context 为评估上下文（追加注入；root 键保留 = 数据对象，调用时
   * 参数如输入文本/目标实体经此传递——规则集保持静态）。
   */
  evaluate(
    rule_set: RuleSet,
    data: unknown,
    options?: { context?: JsonRecord | null },
  ): RuleCheckResult {
    const mergedContext: JsonRecord = { root: data as Json, ...(options?.context ?? {}) };
    const issues: RuleViolation[] = [];
    const skipped: [string, string][] = [];
    const broken: [string, string][] = [];
    let checked = 0;
    for (const rule of rule_set.rules) {
      if (!(_EXECUTABLE_RULE_TYPES as readonly string[]).includes(rule.type)) {
        skipped.push([rule.id, `规则类型不可执行: ${rule.type}`]);
        continue;
      }
      const target = getPath(data, rule.target_path);
      if (target === null && rule.target_path !== null) {
        skipped.push([rule.id, `目标路径不存在: ${rule.target_path}`]);
        continue;
      }
      const predicate = this.registry.create(rule.predicate);
      if (rule.iterate_items) {
        const items = iterableItems(target);
        if (items === null) {
          skipped.push([rule.id, '目标非集合（iterate_items 需集合形态）']);
          continue;
        }
        checked += 1;
        for (const item of items) {
          issues.push(...evaluateOnce(predicate, item, rule, mergedContext, skipped, broken));
        }
      } else {
        checked += 1;
        issues.push(...evaluateOnce(predicate, target, rule, mergedContext, skipped, broken));
      }
    }
    return new RuleCheckResult({ issues, skipped, broken, checked });
  }
}

/**
 * iterate_items 的逐条形态：dict = 值序列（与领域校验器遍历语义对齐）；
 * list = 原序；其余形态 = 非集合（返回 null 由调用方跳过留痕）。
 */
export function iterableItems(target: unknown): unknown[] | null {
  if (isRecord(target)) return Object.values(target);
  if (Array.isArray(target)) return [...target];
  return null;
}