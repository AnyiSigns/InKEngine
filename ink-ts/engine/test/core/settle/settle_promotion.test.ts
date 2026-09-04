/**
 * 沉淀单元：推荐先验自动晋升（路径全通 + 闸门 + canary + 去重持久化）。
 *
 * 对标 ink_engine/tests/test_settle.py 的「推荐先验自动晋升」节：
 * - 晋升证据判据（recommended_prior_eligible 阈值）见 settle_rules.test.ts；
 * - 钩子：路径全通 + 全边达晋升线 + 闸门 + canary → 晋升登记 + 审计；
 * - fail-closed：无闸门注入 = 不晋升；闸门拒绝同样不晋升；
 * - 任一遍历边未达晋升线 = 整条路径不晋升；
 * - 去重：重复触发不重复登记；persisted_signatures 重启恢复（ENG1-18）。
 */

import { describe, expect, it } from 'vitest';

import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/store.js';
import {
  RecommendedPriorSettleHook,
  promotion_signature_key,
} from '../../../src/core/settle/promotion.js';
import {
  TRACE_SUCCESS,
} from '../../../src/core/settle/_constants.js';
import {
  NOW,
  StubGate,
  edgeKey,
  makeCtx,
  stepsOf,
} from './helpers.js';

/** 预置 start→mid / mid→end 两条 N=30 全成功的高强度证据边。 */
async function seedStrongPath(store: EdgeEvidenceStore): Promise<void> {
  for (const [src, dst] of [
    ['start', 'mid'],
    ['mid', 'end'],
  ] as const) {
    await store.put({
      key: edgeKey(src, dst),
      success_count: 30,
      fail_count: 0,
      avg_cost: 0.0,
      policy: false,
      origin: 'runtime',
      last_used_at: NOW,
      created_at: NOW,
    });
  }
}

const fullPathCtx = () =>
  makeCtx(
    stepsOf(
      ['start', TRACE_SUCCESS],
      ['mid', TRACE_SUCCESS],
      ['end', TRACE_SUCCESS],
    ),
  );

describe('RecommendedPriorSettleHook 晋升钩子', () => {
  it('路径全通 + 全边达线 + 闸门 + canary → 晋升登记 + 审计', async () => {
    const store = new EdgeEvidenceStore();
    await seedStrongPath(store);
    const records: Array<Record<string, unknown>> = [];
    const hook = new RecommendedPriorSettleHook(store, new StubGate(true), {
      canary_ok: () => true,
      sink: (record) => records.push(record),
    });
    const ctx = fullPathCtx();
    await hook.settle(ctx);
    expect(hook.promotions.length).toBe(1);
    const promotion = hook.promotions[0]!;
    expect(promotion['type']).toBe('recommended_prior_promotion');
    expect(promotion['domain']).toBe('code');
    expect(promotion['gate_passed']).toBe(true);
    expect((promotion['edges'] as unknown[]).length).toBe(2);
    expect(records).toEqual([promotion]);
    // 重复触发去重（同一路径不重复登记）
    await hook.settle(ctx);
    expect(hook.promotions.length).toBe(1);
    await store.close();
  });

  it('fail-closed：无闸门注入 = 不晋升（高质量归纳前提不满足）', async () => {
    const store = new EdgeEvidenceStore();
    await seedStrongPath(store);
    const hook = new RecommendedPriorSettleHook(store);
    const ctx = fullPathCtx();
    await hook.settle(ctx);
    expect(hook.promotions).toEqual([]);
    // 闸门拒绝同样不晋升
    const gated = new RecommendedPriorSettleHook(store, new StubGate(false), {
      canary_ok: () => true,
    });
    await gated.settle(ctx);
    expect(gated.promotions).toEqual([]);
    await store.close();
  });

  it('任一遍历边未达晋升线 = 整条路径不晋升', async () => {
    const store = new EdgeEvidenceStore();
    await store.put({
      key: edgeKey('start', 'mid'),
      success_count: 30,
      fail_count: 0,
      avg_cost: 0.0,
      policy: false,
      origin: 'runtime',
      last_used_at: NOW,
      created_at: NOW,
    });
    await store.put({
      key: edgeKey('mid', 'end'),
      success_count: 3,
      fail_count: 2, // N=5 未达晋升线
      avg_cost: 0.0,
      policy: false,
      origin: 'runtime',
      last_used_at: NOW,
      created_at: NOW,
    });
    const hook = new RecommendedPriorSettleHook(store, new StubGate(true));
    await hook.settle(fullPathCtx());
    expect(hook.promotions).toEqual([]);
    await store.close();
  });

  it('去重键可持久化恢复（重启后不再重复登记，ENG1-18）', async () => {
    const store = new EdgeEvidenceStore();
    await seedStrongPath(store);
    const persisted = new Set<string>();
    const recorded: string[][][] = [];
    const persist = (signature: readonly string[][]): void => {
      persisted.add(promotion_signature_key(signature));
      recorded.push(signature.map((tuple) => [...tuple]));
    };
    const gate = new StubGate(true);
    const ctx = fullPathCtx();
    const hook = new RecommendedPriorSettleHook(store, gate, {
      canary_ok: () => true,
      on_promoted: persist,
    });
    await hook.settle(ctx);
    expect(hook.promotions.length).toBe(1);
    expect(persisted.size).toBe(1);
    expect(recorded.length).toBe(1);
    expect(hook.promotions[0]!['signature']).toEqual(recorded[0]); // 记录携带去重键
    // 「重启」= 新实例从持久化恢复：同路径不再重复登记
    const restarted = new RecommendedPriorSettleHook(store, gate, {
      canary_ok: () => true,
      persisted_signatures: persisted,
      on_promoted: persist,
    });
    await restarted.settle(ctx);
    expect(restarted.promotions).toEqual([]);
    expect(recorded.length).toBe(1); // 恢复后不再触发持久化回调
    // 无恢复（旧行为面）：仍会重复登记——持久化是宿主装配选择
    const fresh = new RecommendedPriorSettleHook(store, gate, {
      canary_ok: () => true,
    });
    await fresh.settle(ctx);
    expect(fresh.promotions.length).toBe(1);
    await store.close();
  });
});
