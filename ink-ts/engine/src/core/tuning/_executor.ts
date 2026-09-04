/**
 * 参数回归执行器（tuning.py ParamRegressionExecutor 段移植）。
 *
 * 与 GateL2FixtureExecutor 的分工：规则条目回归由规则引擎跑样例；参数
 * 条目（权重/阈值）无规则执行语义，回归 = 取值边界校验——fixture 用例
 * 声明每类参数的合法边界（bounds），期望全合规/至少一条越界
 * （expected_pass 语义），与样例库机制同构（纯数据、可断言、fixture
 * 全绿才允许参数落库）。
 *
 * FixtureCase.data 契约：
 * - weights/thresholds：本次要校验的参数子集（缺省 = 校验条目携带的
 *   全部参数）；
 * - bounds：边界声明 {"weights": {"min": .., "max": ..},
 *   "thresholds": {"min": .., "max": ..}}（缺省口径 = 权重下限调参
 *   保护、上限 1.0；阈值非负）。
 */

import type { JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import { GateL2Result } from '../knowledge_gate/index.js';
import type { KnowledgeExecutor } from '../knowledge_gate/index.js';
import type { KnowledgeEntry } from '../knowledge_set/knowledge_entry.js';
import { FixtureResult } from '../rules/index.js';
import type { FixtureSet } from '../rules/index.js';
import {
  _DEFAULT_THRESHOLD_MAX,
  _DEFAULT_THRESHOLD_MIN,
  _DEFAULT_WEIGHT_MAX,
  _DEFAULT_WEIGHT_MIN,
} from './_constants.js';

/** 参数回归执行器：新参数须落在 fixture 声明的取值边界内（L2 回归）。 */
export class ParamRegressionExecutor implements KnowledgeExecutor {
  async run(
    entry: KnowledgeEntry,
    fixtures: FixtureSet,
    _options: { context_rules?: JsonRecord | null } = {},
  ): Promise<GateL2Result> {
    const rawWeights = entry.data['weights'];
    const weights: Record<string, unknown> = isRecord(rawWeights)
      ? { ...rawWeights }
      : {};
    const rawThresholds = entry.data['thresholds'];
    const thresholds: Record<string, unknown> = isRecord(rawThresholds)
      ? { ...rawThresholds }
      : {};
    const results: FixtureResult[] = [];
    for (const case_ of fixtures.cases) {
      const rawBounds = case_.data['bounds'];
      const bounds: JsonRecord = isRecord(rawBounds) ? rawBounds : {};
      const rawWeightBounds = bounds['weights'];
      const weightBounds: JsonRecord = isRecord(rawWeightBounds)
        ? rawWeightBounds
        : {};
      const rawThresholdBounds = bounds['thresholds'];
      const thresholdBounds: JsonRecord = isRecord(rawThresholdBounds)
        ? rawThresholdBounds
        : {};
      const violations: string[] = [];
      const weightMin = Number(weightBounds['min'] ?? _DEFAULT_WEIGHT_MIN);
      const weightMax = Number(weightBounds['max'] ?? _DEFAULT_WEIGHT_MAX);
      for (const [name, value] of Object.entries(weights)) {
        const numeric = Number(value);
        if (!(weightMin - 1e-9 <= numeric && numeric <= weightMax + 1e-9)) {
          violations.push(`权重 ${name}=${String(value)} 越界[${weightMin}, ${weightMax}]`);
        }
      }
      const thresholdMin = Number(thresholdBounds['min'] ?? _DEFAULT_THRESHOLD_MIN);
      const thresholdMax = Number(thresholdBounds['max'] ?? _DEFAULT_THRESHOLD_MAX);
      for (const [name, value] of Object.entries(thresholds)) {
        const numeric = Number(value);
        if (!(thresholdMin - 1e-9 <= numeric && numeric <= thresholdMax + 1e-9)) {
          violations.push(
            `阈值 ${name}=${String(value)} 越界[${thresholdMin}, ${thresholdMax}]`,
          );
        }
      }
      const passed = case_.expected_pass
        ? violations.length === 0
        : violations.length > 0;
      let reason = '';
      if (passed) {
        reason = '';
      } else if (!case_.expected_pass) {
        reason = '期望至少一条越界，实际全部合规';
      } else {
        reason = violations.slice(0, 3).join('; ');
      }
      results.push(
        new FixtureResult({
          case_id: case_.id,
          passed,
          violations: [],
          expected_pass: case_.expected_pass,
          reason,
        }),
      );
    }
    const allPassed = results.every((result) => result.passed);
    return new GateL2Result({
      passed: allPassed,
      fixture_results: results,
      accuracy: results.length
        ? results.filter((result) => result.passed).length / results.length
        : 0.0,
      regression_samples: results.length,
      note: allPassed ? '' : '参数回归样例未全绿',
    });
  }
}
