/**
 * 回合指标聚合（tuning.py TurnMetrics dataclass 段移植）。
 *
 * 触发条件与聚合语义：meta 节点回合收尾时调用 record_*，snapshot 汇出
 * 结构化指标（调参输入，随评估记录可落库）。聚合口径：失败率 = 失败/回合
 * （无回合 = 0，不除零）；评审分/收敛轮数只留近期窗口（_METRICS_WINDOW
 * 上限，防长跑留痕无限膨胀）；挡位调用统计与 TierCallStats.snapshot 同
 * 口径——非正计数为观测噪声（清零/非法输入），不并入。
 */

import { GraphDefinitionError } from '../errors.js';
import type { JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import { _METRICS_WINDOW } from './_constants.js';

/** TurnMetrics 构造选项（Python dataclass 默认字段的 TS 映射）。 */
export interface TurnMetricsInit {
  turns?: number;
  failures?: number;
  review_scores?: readonly number[];
  convergence_rounds?: readonly number[];
  llm_calls_by_tier?: Readonly<Record<string, number>>;
  last_error?: string;
}

/**
 * 回合指标聚合（引擎自承载：失败率/评审分/收敛轮数/挡位调用）。
 */
export class TurnMetrics {
  turns: number;
  failures: number;
  review_scores: number[];
  convergence_rounds: number[];
  llm_calls_by_tier: Record<string, number>;
  last_error: string;

  constructor(init: TurnMetricsInit = {}) {
    this.turns = init.turns ?? 0;
    this.failures = init.failures ?? 0;
    this.review_scores = init.review_scores ? [...init.review_scores] : [];
    this.convergence_rounds = init.convergence_rounds
      ? [...init.convergence_rounds]
      : [];
    this.llm_calls_by_tier = init.llm_calls_by_tier
      ? { ...init.llm_calls_by_tier }
      : {};
    this.last_error = init.last_error ?? '';
  }

  /** 记录一个回合（失败标记 + 错误摘要——失败率/根因留痕）。 */
  record_turn(options: { failed?: boolean; error?: string } = {}): void {
    const failed = options.failed ?? false;
    const error = options.error ?? '';
    this.turns += 1;
    if (failed) {
      this.failures += 1;
      if (error) {
        this.last_error = error;
      }
    }
  }

  /** 记录一次评审分（0-1；评审收敛循环每轮产出即记录）。 */
  record_review(score: number): void {
    if (!(score >= 0 && score <= 1)) {
      throw new GraphDefinitionError(`评审分必须在 [0, 1] 内: ${score}`);
    }
    this.review_scores.push(score);
    if (this.review_scores.length > _METRICS_WINDOW) {
      this.review_scores.shift();
    }
  }

  /** 记录一次收敛循环的轮数（探索-收敛的收敛速度观测）。 */
  record_convergence(rounds: number): void {
    if (rounds < 0) {
      throw new GraphDefinitionError(`收敛轮数不能为负: ${rounds}`);
    }
    this.convergence_rounds.push(Math.trunc(rounds));
    if (this.convergence_rounds.length > _METRICS_WINDOW) {
      this.convergence_rounds.shift();
    }
  }

  /** 并入挡位调用统计（TierCallStats.snapshot 产物，逐挡位累加）。
   *
   * 与挡位统计同口径：非正计数为观测噪声（清零/非法输入），不并入。
   */
  record_llm_calls(tier_stats: Readonly<Record<string, unknown>> | null = null): void {
    for (const [tier, count] of Object.entries(tier_stats ?? {})) {
      const value = Math.trunc(Number(count));
      if (value <= 0) {
        continue;
      }
      this.llm_calls_by_tier[tier] = (this.llm_calls_by_tier[tier] ?? 0) + value;
    }
  }

  /** 失败率（0-1；无回合 = 0，不除零）。 */
  get failure_rate(): number {
    return this.turns ? this.failures / this.turns : 0.0;
  }

  /** 平均评审分（无评审记录 = 0）。 */
  get avg_review_score(): number {
    return this.review_scores.length
      ? this.review_scores.reduce((sum, score) => sum + score, 0) /
          this.review_scores.length
      : 0.0;
  }

  /** 汇出结构化指标（调参输入；可随评估记录落库/审计）。 */
  snapshot(): JsonRecord {
    return {
      turns: this.turns,
      failures: this.failures,
      failure_rate: this.failure_rate,
      avg_review_score: this.avg_review_score,
      review_count: this.review_scores.length,
      review_scores: [...this.review_scores],
      convergence_rounds: [...this.convergence_rounds],
      llm_calls_by_tier: { ...this.llm_calls_by_tier },
      last_error: this.last_error,
    };
  }

  /** 从快照还原（评估记录回放/审计用）。 */
  static from_snapshot(data: unknown): TurnMetrics {
    if (!isRecord(data)) {
      throw new GraphDefinitionError('回合指标快照非法: 期望 dict');
    }
    const rawReviews = data['review_scores'];
    const rawConvergence = data['convergence_rounds'];
    const rawCalls = data['llm_calls_by_tier'];
    const calls: Record<string, number> = {};
    if (isRecord(rawCalls)) {
      for (const [tier, count] of Object.entries(rawCalls)) {
        calls[String(tier)] = Math.trunc(Number(count));
      }
    }
    return new TurnMetrics({
      turns: Math.trunc(Number(data['turns'] ?? 0)),
      failures: Math.trunc(Number(data['failures'] ?? 0)),
      review_scores: Array.isArray(rawReviews)
        ? rawReviews.map((score) => Number(score))
        : [],
      convergence_rounds: Array.isArray(rawConvergence)
        ? rawConvergence.map((round) => Math.trunc(Number(round)))
        : [],
      llm_calls_by_tier: calls,
      last_error:
        data['last_error'] === undefined || data['last_error'] === null
          ? ''
          : String(data['last_error']),
    });
  }
}
