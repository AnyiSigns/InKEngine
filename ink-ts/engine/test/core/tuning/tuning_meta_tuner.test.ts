/**
 * 调参器（MetaTuner）单测（对标 Python test_tuning.py「低分反馈降权」与
 * 「执行统计驱动的机制参数调整」段）。
 *
 * 语义检查点：
 * - 模拟低分反馈 → 维度权重自动下调 → 评审评分随权重调整变化符合预期
 *   （基准断言：劣质维度降权后总分抬升、可复算）；
 * - 降权/升权上下限保护（维度不因反馈被降没/失衡主导）；
 * - 历史遗留越界权重在调参入口收敛到边界（不阻塞后续调参）；
 * - 失败率/收敛轮数驱动的机制参数调整（重试预算/web 阈值/探索宽度）；
 * - 快照随规则版本落库（回放语义）；边界封顶不产生虚假变更说明。
 *
 * 延后（defer）：executor/LLM-钩子集成用例（L2 参数回归整链过闸、宿主
 * 自定义闸门注入、快照 sink 落库）归 tune_regression 套件；LLM 判定
 * 钩子 seam 属宿主装配层，本套件纯逻辑零 IO。
 */
import { describe, expect, it } from 'vitest';

import {
  ScoreDimension,
  ScoringConfig,
  WeightedScorer,
} from '../../../src/core/scoring/scoring.js';
import { MetaTuner, TunableParams, TurnMetrics } from '../../../src/core/tuning/index.js';

function scorer(weights: Record<string, number>): WeightedScorer {
  return new WeightedScorer(
    new ScoringConfig(
      Object.entries(weights).map(([name, weight]) => new ScoreDimension(name, weight)),
    ),
  );
}

describe('低分反馈降权（基准：评审评分随权重调整变化）', () => {
  it('模拟低分反馈 → 权重自动下调（劣质维度降权）', () => {
    const params = new TunableParams({ weights: { 质量: 0.7, 一致性: 0.3 } });
    const metrics = new TurnMetrics();
    const result = new MetaTuner().tune(params, metrics, { feedback: { 一致性: 0.2 } });
    expect(result.params.weights['一致性']!).toBeLessThan(0.3); // 低分维度降权
    expect(result.params.weights['质量']).toBe(0.7); // 未反馈维度不动
    expect(result.changes.some((change) => change.includes('降权'))).toBe(true);
  });

  it('基准：评审评分随权重调整变化符合预期（劣质维度主导减弱，总分抬升）', () => {
    const params = new TunableParams({ weights: { A: 0.5, B: 0.5 } });
    const metrics = new TurnMetrics();
    const tuned = new MetaTuner().tune(params, metrics, { feedback: { B: 0.2 } });
    const scorerBefore = scorer(params.weights);
    const scorerAfter = scorer(tuned.params.weights);
    const before = scorerBefore.score({ A: 0.9, B: 0.1 }).total;
    const after = scorerAfter.score({ A: 0.9, B: 0.1 }).total;
    expect(after).toBeGreaterThan(before); // B 降权 → 低分拖累减弱 → 总分抬升
    expect(before).toBe(0.5);
    expect(after).toBeGreaterThan(0.5);
    // 确定性：同输入同输出（可断言、可回归）
    expect(scorerAfter.score({ A: 0.9, B: 0.1 }).total).toBe(after);
  });

  it('高分反馈升权（正向强化）', () => {
    const params = new TunableParams({ weights: { A: 0.5 } });
    const result = new MetaTuner().tune(params, new TurnMetrics(), {
      feedback: { A: 0.9 },
    });
    expect(result.params.weights['A']!).toBeGreaterThan(0.5);
  });

  it('降权下限保护（维度不因反馈被降没）', () => {
    const params = new TunableParams({ weights: { A: 0.15 } });
    const result = new MetaTuner().tune(params, new TurnMetrics(), {
      feedback: { A: 0.0 },
    });
    expect(result.params.weights['A']!).toBeGreaterThanOrEqual(0.1);
  });

  it('升权上限保护（维度不因反馈失衡主导——上界与回归边界同口径）', () => {
    let params = new TunableParams({ weights: { A: 0.9 } });
    let result = new MetaTuner().tune(params, new TurnMetrics(), {
      feedback: { A: 1.0 },
    });
    expect(result.params.weights['A']!).toBeLessThanOrEqual(1.0);
    // 连续高分反馈多次仍不越界
    for (let i = 0; i < 10; i++) {
      params = result.params;
      result = new MetaTuner().tune(params, new TurnMetrics(), {
        feedback: { A: 1.0 },
      });
    }
    expect(result.params.weights['A']!).toBeLessThanOrEqual(1.0);
  });

  it('历史遗留越界权重在调参入口收敛到边界（不阻塞后续调参）', () => {
    const params = new TunableParams({ weights: { A: 5.0, B: 0.5 } });
    const result = new MetaTuner().tune(params, new TurnMetrics(), {
      feedback: { B: 0.9 },
    });
    expect(result.params.weights['A']).toBe(1.0); // 越上限收敛
    expect(result.params.weights['B']!).toBeGreaterThan(0.5); // 正常维度照常调整
    expect(result.changes.some((change) => change.includes('越上限'))).toBe(true);
  });

  it('未知维度反馈不调整（口径漂移由配置侧修复，不静默增删）', () => {
    const params = new TunableParams({ weights: { A: 0.5 } });
    const result = new MetaTuner().tune(params, new TurnMetrics(), {
      feedback: { 幽灵维度: 0.1 },
    });
    expect(result.params.weights).toEqual({ A: 0.5 });
    expect(result.changes).toEqual([]);
  });
});

describe('执行统计驱动的机制参数调整', () => {
  it('失败率偏高 → 重试预算上调 + web 验证阈值下调', () => {
    const metrics = new TurnMetrics();
    metrics.record_turn({ failed: true });
    metrics.record_turn({ failed: true });
    const result = new MetaTuner().tune(
      new TunableParams({ retry_budget: 1 }),
      metrics,
    );
    expect(result.params.retry_budget).toBeGreaterThanOrEqual(2);
    expect(result.params.web_verify_threshold).toBeLessThan(0.5);
  });

  it('失败率偏低 → 重试预算回落（省成本）', () => {
    const metrics = new TurnMetrics();
    metrics.record_turn();
    const result = new MetaTuner().tune(
      new TunableParams({ retry_budget: 2 }),
      metrics,
    );
    expect(result.params.retry_budget).toBe(1);
  });

  it('平均收敛轮数偏高 → 发散宽度加宽（探索更多候选）', () => {
    const metrics = new TurnMetrics();
    metrics.record_convergence(3);
    metrics.record_convergence(4);
    const result = new MetaTuner().tune(
      new TunableParams({ divergence_width: 3 }),
      metrics,
    );
    expect(result.params.divergence_width).toBe(4);
  });

  it('平均收敛轮数偏低 → 发散宽度收窄（收敛更快）', () => {
    const metrics = new TurnMetrics();
    metrics.record_convergence(1);
    metrics.record_convergence(1);
    const result = new MetaTuner().tune(
      new TunableParams({ divergence_width: 3 }),
      metrics,
    );
    expect(result.params.divergence_width).toBe(2);
  });

  it('无指标驱动变化时返回原参数（changes 空，不空转调参）', () => {
    const metrics = new TurnMetrics();
    const result = new MetaTuner().tune(new TunableParams({ retry_budget: 1 }), metrics);
    expect(result.params.retry_budget).toBe(1);
    expect(result.changes).toEqual([]);
  });

  it('提供规则版本时快照随调参结果落库（回放语义）', () => {
    const result = new MetaTuner().tune(
      new TunableParams({ weights: { A: 0.5 } }),
      new TurnMetrics(),
      { feedback: { A: 0.1 }, rule_version: 'rules-v7' },
    );
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.rule_version).toBe('rules-v7');
    expect(result.snapshot!.params.weights['A']!).toBeLessThan(0.5);
  });

  it('未提供规则版本 = 快照不落（调用方按需决定回放语义）', () => {
    const result = new MetaTuner().tune(new TunableParams(), new TurnMetrics());
    expect(result.snapshot).toBeNull();
  });

  it('边界封顶不产生虚假变更说明（无实际变化不 append）', () => {
    const metrics = new TurnMetrics();
    metrics.record_turn({ failed: true });
    metrics.record_turn({ failed: true }); // 失败率 = 1.0（高位驱动）
    // 重试预算已保底、web 阈值已封底 → 不再产生「变更」
    const params = new TunableParams({ retry_budget: 2, web_verify_threshold: 0.1 });
    const result = new MetaTuner().tune(params, metrics);
    expect(result.changes).toEqual([]); // 修复前会空转 append 两条变更说明
    expect(result.params.retry_budget).toBe(2);
    expect(result.params.web_verify_threshold).toBe(0.1);
  });
});
