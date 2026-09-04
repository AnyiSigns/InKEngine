/**
 * 回合指标聚合与参数快照单测（对标 Python test_tuning.py TurnMetrics /
 * ParameterSnapshot / TunableParams 段）。
 *
 * 语义检查点：
 * - TurnMetrics 聚合失败率/评审分/收敛轮数/挡位调用，快照可还原；
 * - ParameterSnapshot 随评估记录落库（规则版本 + 权重快照——推演回放
 *   按快照重算，避免「标尺在动」）；
 * - TunableParams 序列化 round-trip；
 * - 挡位调用统计非正计数不并入（观测噪声/清零信号过滤）；指标窗口有界
 *   （长跑留痕只留近期，防无限膨胀）。
 *
 * 延后（defer）：executor/LLM-钩子集成用例（LLM 判定谓词经规则钩子接入
 * 样例闸门的 fail-open/fail-closed 语义归 rules 套件；参数回归执行器的
 * 整链过闸与快照落库 sink 归 tune_regression 套件）——本套件纯逻辑零 IO，
 * 时间 seam 走确定性缺省（created_at = 0，可复现）。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  ParameterSnapshot,
  TunableParams,
  TurnMetrics,
} from '../../../src/core/tuning/index.js';

describe('TurnMetrics：回合指标聚合', () => {
  it('失败率/评审分/收敛轮数/挡位调用聚合', () => {
    const metrics = new TurnMetrics();
    metrics.record_turn();
    metrics.record_turn({ failed: true, error: '超时' });
    metrics.record_review(0.8);
    metrics.record_review(0.6);
    metrics.record_convergence(2);
    metrics.record_convergence(4);
    metrics.record_llm_calls({ main: 3, router: 1 });
    metrics.record_llm_calls({ main: 2 });
    expect(metrics.failure_rate).toBe(0.5);
    expect(metrics.avg_review_score).toBe(0.7);
    expect(metrics.llm_calls_by_tier).toEqual({ main: 5, router: 1 });
    expect(metrics.last_error).toBe('超时');
  });

  it('无回合 = 失败率 0（不除零）', () => {
    const metrics = new TurnMetrics();
    expect(metrics.failure_rate).toBe(0.0);
    expect(metrics.avg_review_score).toBe(0.0);
  });

  it('指标快照可还原（评估记录落库/回放契约）', () => {
    const metrics = new TurnMetrics();
    metrics.record_turn({ failed: true });
    metrics.record_review(0.9);
    const rebuilt = TurnMetrics.from_snapshot(metrics.snapshot());
    expect(rebuilt.failure_rate).toBe(1.0);
    expect(rebuilt.avg_review_score).toBe(0.9);
  });

  it('评审分越界拒绝（口径防线）', () => {
    const metrics = new TurnMetrics();
    expect(() => metrics.record_review(1.5)).toThrow(/评审分/);
    expect(() => metrics.record_review(1.5)).toThrow(GraphDefinitionError);
  });

  it('挡位调用统计非正计数不并入（观测噪声与清零信号过滤）', () => {
    const metrics = new TurnMetrics();
    metrics.record_llm_calls({ main: 5 });
    metrics.record_llm_calls({ main: -10 });
    expect(metrics.llm_calls_by_tier).toEqual({ main: 5 });
  });

  it('指标窗口有界：长跑留痕只保留近期窗口（防无限膨胀）', () => {
    const metrics = new TurnMetrics();
    for (let i = 0; i < 1200; i++) {
      metrics.record_review(0.5);
      metrics.record_convergence(1);
    }
    expect(metrics.review_scores.length).toBeLessThanOrEqual(600);
    expect(metrics.convergence_rounds.length).toBeLessThanOrEqual(600);
  });
});

describe('ParameterSnapshot：参数快照序列化', () => {
  it('参数快照序列化 round-trip（规则版本 + 权重冻结）', () => {
    const snapshot = new ParameterSnapshot({
      rule_version: 'rules-v3',
      params: new TunableParams({
        divergence_width: 4,
        weights: { 质量: 0.7, 一致性: 0.3 },
        thresholds: { pass: 0.6 },
      }),
    });
    const rebuilt = ParameterSnapshot.from_dict(snapshot.to_dict());
    expect(rebuilt.rule_version).toBe('rules-v3');
    expect(rebuilt.params.divergence_width).toBe(4);
    expect(rebuilt.params.weights).toEqual({ 质量: 0.7, 一致性: 0.3 });
    expect(rebuilt.params.thresholds).toEqual({ pass: 0.6 });
  });

  it('非法快照（缺 params 结构）拒绝', () => {
    expect(() => ParameterSnapshot.from_dict({ rule_version: 'v1' })).toThrow(
      /参数快照/,
    );
    expect(() => ParameterSnapshot.from_dict({ rule_version: 'v1' })).toThrow(
      GraphDefinitionError,
    );
  });

  it('可调参数集合序列化 round-trip', () => {
    const params = new TunableParams({
      divergence_width: 5,
      retry_budget: 2,
      web_verify_threshold: 0.4,
      weights: { a: 0.6 },
      thresholds: { t: 0.3 },
    });
    const rebuilt = TunableParams.from_dict(params.to_dict());
    expect(rebuilt.divergence_width).toBe(5);
    expect(rebuilt.retry_budget).toBe(2);
    expect(rebuilt.web_verify_threshold).toBe(0.4);
    expect(rebuilt.weights).toEqual({ a: 0.6 });
    expect(rebuilt.thresholds).toEqual({ t: 0.3 });
  });
});
