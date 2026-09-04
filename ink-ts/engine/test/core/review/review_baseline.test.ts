/**
 * 评审确定性基线对标测试（对标 ink_engine/tests/test_review_baseline.py 的
 * core 侧断言；host 产品权威实现对比轨不移植，见文件末说明）：
 * - DeterministicReviewer / DeterministicRegenerator / DeterministicWebVerifier
 *   同输入断言不漂移 + 锚定期望值（长度分 60% + 结构分 40%，4 位小数）；
 * - 协议对齐：Python runtime_checkable isinstance 无 TS 运行时等价，由 TS
 *   结构类型在编译期保证 + 运行时抽查方法形态；
 * - 基线 + MaxRoundsConvergencePolicy 构成确定性收敛循环：两次运行结果
 *   完全一致且收敛。
 */
import { describe, expect, it } from 'vitest';

import {
  CandidateReview,
  ConvergenceDecision,
  DeterministicRegenerator,
  DeterministicReviewer,
  DeterministicWebVerifier,
  MaxRoundsConvergencePolicy,
} from '../../../src/core/review/review.js';
import type { Regenerator, Reviewer, WebVerifier } from '../../../src/core/review/review.js';

type LoopSnapshot = [CandidateReview[], ConvergenceDecision, number];

describe('DeterministicReviewer', () => {
  const CANDIDATES = [
    '',
    'x'.repeat(500),
    'x'.repeat(300) + '\n'.repeat(4),
    'x'.repeat(500) + '\n'.repeat(4),
  ];

  it('同输入断言不漂移：两遍评审产出恒等', async () => {
    const reviewer = new DeterministicReviewer();
    const first = await reviewer.review(CANDIDATES);
    const second = await reviewer.review(CANDIDATES);
    expect(first).toEqual(second);
    expect(first.map((r) => r.candidate_index)).toEqual([0, 1, 2, 3]);
  });

  it('锚定期望分：长度分 60% + 结构分 40%，四舍五入 4 位小数', async () => {
    const reviewer = new DeterministicReviewer();
    const reviews = await reviewer.review(CANDIDATES);
    expect(reviews.map((r) => r.score)).toEqual([0.0, 0.6, 0.7648, 1.0]);
    expect(reviews.map((r) => r.passed)).toEqual([false, false, true, true]);
    for (const r of reviews) {
      expect(r.feedback).toContain('确定性基线');
    }
  });

  it('与 Reviewer 协议结构对齐', async () => {
    const reviewer: Reviewer = new DeterministicReviewer();
    expect(typeof reviewer.review).toBe('function');
  });

  it('context 被接受但忽略（带上下文与不带产出恒等）', async () => {
    const reviewer = new DeterministicReviewer();
    const withContext = await reviewer.review(['x'.repeat(500)], { turn: 1 });
    const without = await reviewer.review(['x'.repeat(500)]);
    expect(withContext).toEqual(without);
  });
});

describe('DeterministicRegenerator', () => {
  it('同输入断言不漂移且锚定期望输出', async () => {
    const regen = new DeterministicRegenerator();
    const first = await regen.regenerate('原稿', '反馈意见');
    const second = await regen.regenerate('原稿', '反馈意见');
    expect(first).toBe('原稿\n\n【确定性基线修订】反馈意见');
    expect(second).toBe('原稿\n\n【确定性基线修订】反馈意见');
  });

  it('空反馈 / 纯空白反馈原样返回候选', async () => {
    const regen = new DeterministicRegenerator();
    expect(await regen.regenerate('原稿', '')).toBe('原稿');
    expect(await regen.regenerate('原稿', '   ')).toBe('原稿');
  });

  it('与 Regenerator 协议结构对齐', async () => {
    const regen: Regenerator = new DeterministicRegenerator();
    expect(typeof regen.regenerate).toBe('function');
  });
});

describe('DeterministicWebVerifier', () => {
  it('同输入断言不漂移且锚定期望输出', async () => {
    const verifier = new DeterministicWebVerifier();
    const first = await verifier.verify('声明A');
    const second = await verifier.verify('声明A');
    expect(first).toBe('【确定性基线验证】声明A（未触发真实联网验证，占位结论）');
    expect(second).toBe('【确定性基线验证】声明A（未触发真实联网验证，占位结论）');
  });

  it('与 WebVerifier 协议结构对齐', async () => {
    const verifier: WebVerifier = new DeterministicWebVerifier();
    expect(typeof verifier.verify).toBe('function');
  });
});

describe('基线 + 引擎策略构成确定性收敛循环', () => {
  async function _runLoop(candidates: string[]): Promise<LoopSnapshot[]> {
    // 确定性收敛循环（与宿主收敛循环同构的骨架）
    const reviewer = new DeterministicReviewer();
    const regenerator = new DeterministicRegenerator();
    const policy = new MaxRoundsConvergencePolicy();
    const snapshots: LoopSnapshot[] = [];
    let rounds = 0;
    while (true) {
      const reviews = await reviewer.review(candidates);
      const decision = policy.decide(reviews, rounds);
      snapshots.push([reviews, decision, rounds]);
      if (decision.converged || decision.regenerate_indices.length === 0) {
        return snapshots;
      }
      for (const index of decision.regenerate_indices) {
        candidates[index] = await regenerator.regenerate(
          candidates[index]!,
          reviews[index]!.feedback,
        );
      }
      rounds += 1;
    }
  }

  it('两次运行结果完全一致且收敛', async () => {
    const first = await _runLoop(['x'.repeat(500)]);
    const second = await _runLoop(['x'.repeat(500)]);
    expect(first).toEqual(second);
    const last = first[first.length - 1]!;
    expect(last[1].converged).toBe(true); // 修订段追加换行后结构分提升应促成收敛
  });
});
