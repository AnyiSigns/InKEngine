/**
 * 三层闸门结果形态（knowledge_gate.py GateL1/L2/L3Result dataclass 段移植）。
 *
 * Python frozen dataclass 语义由 readonly 字段 + Object.freeze 表达（字段
 * 次序与默认值逐一对齐）；to_dict 序列化对齐 Python（错误/维度改善转列表、
 * fixtures 折叠为 case_id/passed/reason 明细，指标随结果留痕可审计）。
 */

import type { JsonRecord } from '../json.js';
import type { FixtureResult } from '../rules/index.js';

/** L1 准入结果（形式合法 + 安全扫描 + 最小功能）。 */
export class GateL1Result {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly injection_hits: readonly string[];

  constructor(init: {
    passed: boolean;
    errors?: readonly string[];
    injection_hits?: readonly string[];
  }) {
    this.passed = init.passed;
    this.errors = [...(init.errors ?? [])];
    this.injection_hits = [...(init.injection_hits ?? [])];
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    return {
      passed: this.passed,
      errors: [...this.errors],
      injection_hits: [...this.injection_hits],
    };
  }
}

/** L2 效果评估结果（完整 fixtures + 回归，含指标留痕）。 */
export class GateL2Result {
  readonly passed: boolean;
  readonly fixture_results: readonly FixtureResult[];
  readonly accuracy: number; // 样例通过率（0-1）
  readonly latency_ms: number; // 样例评估总耗时（毫秒，指标留痕）
  readonly token_cost: number; // token 消耗（机制件统计口径；LLM 判定时由实现方填报）
  readonly safety_score: number; // 安全合规评分（0-1；L1 通过 = 满分基线）
  readonly regression_samples: number; // 历史回归用例数（采样补充的样本量）
  readonly note: string;

  constructor(init: {
    passed: boolean;
    fixture_results?: readonly FixtureResult[];
    accuracy?: number;
    latency_ms?: number;
    token_cost?: number;
    safety_score?: number;
    regression_samples?: number;
    note?: string;
  }) {
    this.passed = init.passed;
    this.fixture_results = [...(init.fixture_results ?? [])];
    this.accuracy = init.accuracy ?? 0.0;
    this.latency_ms = init.latency_ms ?? 0.0;
    this.token_cost = init.token_cost ?? 0;
    this.safety_score = init.safety_score ?? 1.0;
    this.regression_samples = init.regression_samples ?? 0;
    this.note = init.note ?? '';
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    return {
      passed: this.passed,
      accuracy: this.accuracy,
      latency_ms: this.latency_ms,
      token_cost: this.token_cost,
      safety_score: this.safety_score,
      regression_samples: this.regression_samples,
      note: this.note,
      fixtures: this.fixture_results.map((r) => ({
        case_id: r.case_id,
        passed: r.passed,
        reason: r.reason,
      })),
    };
  }
}

/** L3 目标筛选结果（不差于旧版 + 至少一维严格优于 / 多样性保留）。 */
export class GateL3Result {
  readonly passed: boolean;
  readonly reason: string;
  readonly dimension_improvements: readonly string[]; // 严格优于的维度
  readonly diversity_kept: boolean; // 多样性保留（变体并存，供下轮进化）

  constructor(init: {
    passed: boolean;
    reason?: string;
    dimension_improvements?: readonly string[];
    diversity_kept?: boolean;
  }) {
    this.passed = init.passed;
    this.reason = init.reason ?? '';
    this.dimension_improvements = [...(init.dimension_improvements ?? [])];
    this.diversity_kept = init.diversity_kept ?? false;
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    return {
      passed: this.passed,
      reason: this.reason,
      dimension_improvements: [...this.dimension_improvements],
      diversity_kept: this.diversity_kept,
    };
  }
}
