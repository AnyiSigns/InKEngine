/**
 * fan-in 归并与汇聚点合成测试（fan_in.ts）。
 *
 * 测什么：
 * - 提交契约 full：全部产物采纳（含序）；best：质量信号择优 / 成本择优 /
 *   平局保序，落选 adopted=false 保留但隔离；decision_only：只产采纳决策；
 * - 降级/失败子执行任何契约下只贡献摘要（产物不进主载荷）；
 * - estuary_synthesize：无采纳 = 主持人载荷；单份采纳 = 并入主载荷；多份 =
 *   results 清单；降级摘要走 degraded 键（单份最终产物，后台不污染）；
 * - clean_payload：剔除 `__next`/`_quality` 内部键（旧产物不残留）。
 */
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_COMMIT_BEST,
  CHANNEL_COMMIT_DECISION_ONLY,
  CHANNEL_COMMIT_FULL,
} from '../../../src/core/channels/channel_spec.js';
import {
  clean_payload,
  estuary_synthesize,
  fan_in_merge,
  pick_best,
  strip_quality,
} from '../../../src/core/execution_runtime/fan_in.js';
import type { ChildRunOutcome } from '../../../src/core/execution_runtime/runtime_types.js';

function child(
  run_id: string,
  outcome: 'success' | 'degraded' | 'failure',
  payload: Record<string, unknown>,
  opts: { cost?: number; summary?: string | null } = {},
): ChildRunOutcome {
  return {
    run_id,
    parent_run_id: 'root',
    entry_scope: 'collaborator',
    outcome,
    payload,
    summary: opts.summary ?? null,
    cost: { cost: opts.cost ?? 1 },
    error: null,
  };
}

describe('fan_in_merge 提交契约', () => {
  const a = child('c1', 'success', { opinion: 'A' });
  const b = child('c2', 'success', { opinion: 'B' });
  const bad = child('c3', 'failure', {}, { summary: 'c3 失败' });

  it('full：意见全收（含序）', () => {
    const merged = fan_in_merge([a, b], CHANNEL_COMMIT_FULL);
    expect(merged.adopted.map((c) => c.run_id)).toEqual(['c1', 'c2']);
    expect(merged.decision).toBeNull();
  });

  it('best：质量信号择优（_quality 高者胜），落选 adopted=false 保留', () => {
    const low = child('c1', 'success', { opinion: 'low', _quality: 1 });
    const high = child('c2', 'success', { opinion: 'high', _quality: 9 });
    const merged = fan_in_merge([low, high], CHANNEL_COMMIT_BEST);
    expect(merged.adopted.map((c) => c.run_id)).toEqual(['c2']);
    expect(merged.losers.map((c) => c.run_id)).toEqual(['c1']);
    expect(merged.losers[0]?.adopted).toBe(false);
  });

  it('best：无质量信号回落成本择优（低者胜）；平局保序', () => {
    const cheap = child('c1', 'success', { opinion: 'cheap' }, { cost: 1 });
    const dear = child('c2', 'success', { opinion: 'dear' }, { cost: 9 });
    expect(pick_best([cheap, dear])?.run_id).toBe('c1');
    expect(pick_best([dear, cheap])?.run_id).toBe('c1');
    const tieA = child('t1', 'success', { opinion: 'x' });
    const tieB = child('t2', 'success', { opinion: 'y' });
    expect(pick_best([tieA, tieB])?.run_id).toBe('t1');
  });

  it('decision_only：产物全不采纳，只产采纳决策（有成功 = 采纳）', () => {
    const merged = fan_in_merge([a, bad], CHANNEL_COMMIT_DECISION_ONLY);
    expect(merged.adopted).toEqual([]);
    expect(merged.decision).toBe(true);
    const none = fan_in_merge([bad, child('c4', 'degraded', {}, { summary: '退化' })], CHANNEL_COMMIT_DECISION_ONLY);
    expect(none.decision).toBe(false);
  });

  it('降级/失败子执行任何契约只贡献摘要（不进 adopted 载荷面）', () => {
    const merged = fan_in_merge([a, bad], CHANNEL_COMMIT_FULL);
    expect(merged.degraded_summaries).toEqual(['c3 失败']);
    expect(merged.adopted.filter((c) => c.outcome !== 'success')).toEqual([]);
  });
});

describe('汇聚点合成 estuary_synthesize', () => {
  it('无采纳子产物 = 主持人自身载荷', () => {
    expect(estuary_synthesize({ message: '直答' }, [], [])).toEqual({ message: '直答' });
  });

  it('单份采纳 = 并入主持人载荷（单份最终产物）', () => {
    const product = estuary_synthesize({ message: '综合' }, [child('c1', 'success', { answer: '后台产物' })], []);
    expect(product['message']).toBe('综合');
    expect(product['answer']).toBe('后台产物');
  });

  it('多份采纳 = 收进 results 清单（不做多执行体各答一次）', () => {
    const product = estuary_synthesize(
      { message: '裁决' },
      [child('c1', 'success', { o: 1 }), child('c2', 'success', { o: 2 })],
      [],
    );
    const results = product['results'] as Array<Record<string, unknown>>;
    expect(results.length).toBe(2);
    expect(product['message']).toBe('裁决');
  });

  it('降级/失败子执行 → degraded 摘要键（原始产物不外泄）', () => {
    const product = estuary_synthesize(
      { message: 'ok' },
      [child('c1', 'success', { answer: '正常' })],
      ['c2 失败：工具执行异常'],
    );
    expect(product['degraded']).toEqual(['c2 失败：工具执行异常']);
    expect((product as Record<string, unknown>)['answer']).toBe('正常');
  });
});

describe('clean_payload / strip_quality（旧产物不残留）', () => {
  it('clean_payload 剔除 `__next` 路由键（保留质量信号供归并择优）', () => {
    expect(clean_payload({ __next: { kind: 'sink' }, _quality: 3, message: 'x' })).toEqual({ _quality: 3, message: 'x' });
  });

  it('strip_quality 在注入主载荷前剥离质量信号', () => {
    expect(strip_quality({ _quality: 3, answer: 'x' })).toEqual({ answer: 'x' });
  });
});
