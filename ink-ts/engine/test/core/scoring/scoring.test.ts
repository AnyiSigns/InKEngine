/**
 * core/scoring.ts 测试：配置数据形态 / 加权均值 / 双门槛判定 / 口径校验。
 *
 * 对标 pytest test_scoring.py（本模块语义用例；test_simulation/test_tuning
 * 中的集成用例跳过）。
 *
 * 语义检查点：配置即数据（维度 + 权重 + 达标线可序列化，构造期校验）；
 * 总分 = 加权均值（按权重归一，确定性可断言）；维度达标线与总分门槛
 * 独立判定；未知/缺失维度 = 口径错误显式拒绝（不静默忽略——调参基准
 * 失真会让权重学习失效）。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  DimensionScore,
  ScoreDimension,
  ScoreResult,
  ScoringConfig,
  WeightedScorer,
} from '../../../src/core/scoring/scoring.js';

function _config(): ScoringConfig {
  return new ScoringConfig(
    [
      new ScoreDimension('plot', 2.0, 0.6),
      new ScoreDimension('style', 1.0, 0.5),
    ],
    0.7,
  );
}

describe('ScoringConfig 配置数据形态', () => {
  it('test_scoring_config_round_trip：序列化 → 重建完整还原', () => {
    const rebuilt = ScoringConfig.from_dict(_config().to_dict());
    expect(rebuilt.dimensions.map((d) => d.name)).toEqual(['plot', 'style']);
    expect(rebuilt.dimensions[0]!.weight).toBe(2.0);
    expect(rebuilt.dimensions[0]!.threshold).toBe(0.6);
    expect(rebuilt.overall_threshold).toBe(0.7);
  });

  it('test_scoring_config_minimal_round_trip：缺省字段最小形态往返', () => {
    const minimal = new ScoringConfig([new ScoreDimension('a')]);
    const rebuilt = ScoringConfig.from_dict(minimal.to_dict());
    expect(rebuilt.overall_threshold).toBeNull();
    expect(rebuilt.dimensions[0]!.threshold).toBeNull();
    expect(rebuilt.dimensions[0]!.weight).toBe(1.0);
  });

  it('test_scoring_config_rejects_invalid：构造期类型闸门', () => {
    expect(() =>
      ScoringConfig.from_dict({ dimensions: [{ name: 'a', weight: 0 }] }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      ScoringConfig.from_dict({ dimensions: [{ name: 'a', weight: 0 }] }),
    ).toThrow(/权重必须为正/);
    expect(() =>
      ScoringConfig.from_dict({ dimensions: [{ name: 'a', threshold: 1.5 }] }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      ScoringConfig.from_dict({ dimensions: [{ name: 'a', threshold: 1.5 }] }),
    ).toThrow(/\[0, 1\]/);
    expect(() =>
      ScoringConfig.from_dict({ dimensions: [{ name: 'a' }, { name: 'a' }] }),
    ).toThrow(/重复/);
    expect(() =>
      ScoringConfig.from_dict({ dimensions: [{ name: 'a' }], overall_threshold: 2 }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      ScoringConfig.from_dict({ dimensions: [{ name: 'a' }], overall_threshold: 2 }),
    ).toThrow(/\[0, 1\]/);
  });

  it('test_scoring_config_declaration_gate：声明形态闸门', () => {
    expect(() => ScoreDimension.from_dict('oops')).toThrow(/期望 dict/);
    expect(() => ScoreDimension.from_dict({})).toThrow(/缺 name/);
    expect(() => ScoringConfig.from_dict({ dimensions: 'oops' })).toThrow(
      /dimensions 须为清单/,
    );
  });
});

describe('WeightedScorer 加权均值与门槛判定', () => {
  it('test_weighted_mean_math：加权均值确定性可断言', () => {
    const scorer = new WeightedScorer(_config());
    const result = scorer.score({ plot: 0.8, style: 0.6 });
    expect(result.total).toBeCloseTo((0.8 * 2 + 0.6 * 1) / 3, 12);
    const low_plot = scorer.score({ plot: 0.2, style: 1.0 });
    expect(low_plot.total).toBeLessThan(result.total);
  });

  it('test_overall_threshold_gate：总分门槛达标判定', () => {
    const scorer = new WeightedScorer(_config());
    expect(scorer.score({ plot: 0.8, style: 0.6 }).passed).toBe(true);
    expect(scorer.score({ plot: 0.6, style: 0.6 }).passed).toBe(false);
    const no_gate = new WeightedScorer(new ScoringConfig([new ScoreDimension('a')]));
    expect(no_gate.score({ a: 0.1 }).passed).toBe(true);
  });

  it('test_dimension_threshold_flags_failing：维度达标线独立判定', () => {
    const scorer = new WeightedScorer(_config());
    const result = scorer.score({ plot: 0.5, style: 0.9 });
    expect(result.failing_dimensions.map((d) => d.name)).toEqual(['plot']);
    expect(result.passed).toBe(false);
    expect(scorer.score({ plot: 0.8, style: 0.6 }).failing_dimensions).toEqual([]);
  });

  it('test_dimension_score_notes_carried：note 随结果留痕', () => {
    const scorer = new WeightedScorer(_config());
    const result = scorer.score([
      new DimensionScore('plot', 0.8, '主线完整'),
      new DimensionScore('style', 0.6, '文风稳定'),
    ]);
    expect(result.scores[0]!.note).toBe('主线完整');
    expect(result.scores[1]!.note).toBe('文风稳定');
  });

  it('test_missing_and_unknown_dimension_rejected：口径错误显式拒绝', () => {
    const scorer = new WeightedScorer(_config());
    expect(() => scorer.score({ style: 0.9 })).toThrow(/未提供维度 plot/);
    expect(() => scorer.score({ plot: 2.0, style: 0.5 })).toThrow(RangeError);
    expect(() => scorer.score({ plot: 2.0, style: 0.5 })).toThrow(/得分必须在/);
    expect(() => scorer.score({ plot: 0.8, style: 0.5, extra: 0.9 })).toThrow(
      /未知打分维度/,
    );
  });

  it('test_score_result_serializable：结果可序列化可审计', () => {
    const scorer = new WeightedScorer(_config());
    const result = scorer.score({ plot: 0.5, style: 0.9 });
    const data = result.to_dict();
    expect(data['passed']).toBe(false);
    expect(data['failing_dimensions']).toEqual(['plot']);
    expect((data['scores'] as unknown[]).length).toBe(2);
    expect((data['scores'] as Record<string, unknown>[])[0]!['name']).toBe('plot');
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(1);
    expect(result instanceof ScoreResult).toBe(true);
  });

  it('test_empty_config_returns_zero_total：空维度配置合法边界', () => {
    const scorer = new WeightedScorer(new ScoringConfig());
    const result = scorer.score({});
    expect(result.total).toBe(0.0);
    expect(result.passed).toBe(true);
    expect(result.scores).toEqual([]);
    expect(result.failing_dimensions).toEqual([]);
  });

  it('test_unknown_dimension_fail_closed：口径漂移抛错不留静默（无日志副作用）', () => {
    const scorer = new WeightedScorer(_config());
    expect(() => scorer.score({ plot: 0.8, style: 0.5, extra: 0.9 })).toThrow(
      /未知打分维度/,
    );
    const after = scorer.score({ plot: 0.8, style: 0.6 });
    expect(after.passed).toBe(true);
  });
});
