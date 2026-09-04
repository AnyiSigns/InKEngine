/**
 * review 移植对标测试（逐点对标 ink_engine/tests/test_review.py）：
 * CandidateReview 冻结数据类语义、MaxRoundsConvergencePolicy 参数校验/单一
 * 阈值收敛门槛/Beam 再生成/轮次上限、中性分不达标、ConvergenceResult
 * best_index 的候选位置推导与过滤回落。
 *
 * 错误映射沿用移植口径：阈值/Beam/轮次上限越界的 ValueError → RangeError；
 * Python FrozenInstanceError（AttributeError 子类）在 TS 为冻结实例赋值抛
 * TypeError（ES 严格模式）。
 */
import { describe, expect, it } from 'vitest';

import {
  CandidateReview,
  ConvergenceResult,
  MaxRoundsConvergencePolicy,
  NEUTRAL_SCORE,
} from '../../../src/core/review/review.js';

function _review(index: number, score: number, passed?: boolean): CandidateReview {
  return new CandidateReview(index, score, passed ?? score >= 0.75);
}

describe('CandidateReview 冻结数据类', () => {
  it('frozen 语义：字段赋值即抛错', () => {
    const r = _review(0, 0.8);
    expect(() => {
      (r as unknown as Record<string, unknown>)['score'] = 0.9;
    }).toThrow(TypeError);
  });

  it('paragraphs 缺省为空', () => {
    expect(_review(0, 0.8).paragraphs).toEqual([]);
  });
});

describe('MaxRoundsConvergencePolicy', () => {
  it('校验构造参数：越界阈值 / 非正 Beam / 负轮次上限均拒绝', () => {
    expect(() => new MaxRoundsConvergencePolicy(1.5)).toThrow(RangeError);
    expect(() => new MaxRoundsConvergencePolicy(1.5)).toThrow(/\[0, 1\]/);
    expect(() => new MaxRoundsConvergencePolicy(0.75, 0)).toThrow(RangeError);
    expect(() => new MaxRoundsConvergencePolicy(0.75, 1, -1)).toThrow(RangeError);
  });

  it('空评审集 = 无候选可判定：收敛失败', () => {
    const decision = new MaxRoundsConvergencePolicy().decide([], 0);
    expect(decision.converged).toBe(false);
    expect(decision.accepted_indices).toEqual([]);
    expect(decision.regenerate_indices).toEqual([]);
    expect(decision.notes.length).toBeGreaterThan(0);
  });

  it('策略 threshold 真实生效：评审器 passed 但分数低于策略门槛不收敛', () => {
    const policy = new MaxRoundsConvergencePolicy(0.9);
    const reviews = [_review(0, 0.8)]; // 评审器 0.75 判 passed，但未达策略 0.9
    const decision = policy.decide(reviews, 0);
    expect(decision.converged).toBe(false);
    expect(decision.regenerate_indices).toEqual([0]);
    // 默认门槛（0.75）下 0.8 收敛
    const decision2 = new MaxRoundsConvergencePolicy().decide(reviews, 0);
    expect(decision2.converged).toBe(true);
    expect(decision2.accepted_indices).toEqual([0]);
  });

  it('策略 threshold 是唯一收敛门槛：评审器 passed 标志不参与判定', () => {
    // 评审器阈值更严（0.9 才判 passed），策略阈值 0.75：分数 0.8 虽
    // passed=False，按单一阈值源（0.8 >= 0.75）即收敛
    const reviews = [_review(0, 0.8, false)];
    const decision = new MaxRoundsConvergencePolicy().decide(reviews, 0);
    expect(decision.converged).toBe(true);
    expect(decision.accepted_indices).toEqual([0]);
    // 收紧策略阈值（0.9）：同样分数不收敛
    const tight = new MaxRoundsConvergencePolicy(0.9);
    expect(tight.decide(reviews, 0).converged).toBe(false);
  });

  it('存在达标候选即收敛，接受分数最高者', () => {
    const policy = new MaxRoundsConvergencePolicy();
    const reviews = [_review(0, 0.6), _review(1, 0.9), _review(2, 0.85)];
    const decision = policy.decide(reviews, 0);
    expect(decision.converged).toBe(true);
    expect(decision.accepted_indices).toEqual([1]);
  });

  it('第 0 轮无达标：按分数降序取 Beam 宽度的候选再生成', () => {
    const policy = new MaxRoundsConvergencePolicy(0.75, 2, 3);
    const reviews = [_review(0, 0.5), _review(1, 0.7), _review(2, 0.3)];
    const decision = policy.decide(reviews, 0);
    expect(decision.converged).toBe(false);
    expect(decision.regenerate_indices).toEqual([1, 0]); // 分数降序前 2
  });

  it('到轮次上限仍未达标：停止并呈交现状', () => {
    const policy = new MaxRoundsConvergencePolicy(0.75, 1, 2);
    const reviews = [_review(0, 0.5)];
    const decision = policy.decide(reviews, 2);
    expect(decision.converged).toBe(false);
    expect(decision.regenerate_indices).toEqual([]);
    expect(decision.notes[0]!).toContain('上限');
  });

  it('默认阈值与轮次配置', () => {
    const policy = new MaxRoundsConvergencePolicy();
    expect(policy.threshold).toBe(0.75);
    expect(policy.max_rounds).toBe(2);
    expect(policy.beam).toBe(1);
  });
});

describe('NEUTRAL_SCORE 中性分', () => {
  it('中性分不达标（默认阈值 0.75）', () => {
    const review = _review(0, NEUTRAL_SCORE);
    expect(review.passed).toBe(false);
  });
});

describe('ConvergenceResult.best_index', () => {
  function _result(candidates: string[], reviews: CandidateReview[]): ConvergenceResult {
    return new ConvergenceResult(candidates, reviews, true, 1);
  }

  it('返回 candidates 列表位置（评审轮内下标对齐时与 candidate_index 同值）', () => {
    const reviews = [_review(0, 0.5), _review(1, 0.9), _review(2, 0.85)];
    const result = _result(['c0', 'c1', 'c2'], reviews);
    expect(result.best_index).toBe(1);
    expect(result.candidates[result.best_index]).toBe('c1');
  });

  it('候选集被过滤时按 reviews 序列位置推导，越界回落 0', () => {
    const reviews = [_review(3, 0.9)]; // 评审下标 3（过滤前枚举）越界
    const result = _result(['c1'], reviews);
    // reviews 首位（对齐候选列表 0 位）→ 回落 0，取到被接受的候选
    expect(result.best_index).toBe(0);
    expect(result.candidates[result.best_index]).toBe('c1');
    // 无评审 = 回落 0
    expect(_result(['c1'], []).best_index).toBe(0);
  });
});
