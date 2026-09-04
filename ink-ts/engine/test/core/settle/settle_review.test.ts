/**
 * 沉淀单元：策略边对抗复审（增量 + 限频）与池治理登记钩子。
 *
 * 对标 ink_engine/tests/test_settle.py 的「策略边对抗复审」「池治理登记」
 * 节：
 * - 复审钩子：失败累计超阈值 → 提请 L2 复审 + 复审前降级普通统计边；
 * - 域证据均值反超承诺 → 复审 + 降级；
 * - 增量面（ENG1-9）：未触达的策略边不评估（不做每 run 全量扫描）；
 * - 限频面（ENG1-9）：域证据均值带缓存（scan_interval 内不重复全量扫描）；
 * - 池治理钩子可注册进 SettleHooks 链；settle 为 no-op 占位。
 */

import { describe, expect, it } from 'vitest';

import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/store.js';
import { PoolGovernance } from '../../../src/core/pool_governance/pool_governance.js';
import { Graph } from '../../../src/core/graph/graph.js';
import {
  PolicyEdgeReviewSettleHook,
  PoolGovernanceSettleHook,
} from '../../../src/core/settle/review.js';
import { SettleHooks } from '../../../src/core/settle/hooks.js';
import {
  TRACE_SUCCESS,
} from '../../../src/core/settle/_constants.js';
import {
  NOW,
  edgeKey,
  linearGraph,
  makeCtx,
  stepsOf,
} from './helpers.js';

/** 策略边落库（policy=true；origin 由 store 强制为 policy）。 */
async function putEdge(
  store: EdgeEvidenceStore,
  src: string,
  dst: string,
  success: number,
  fail: number,
  policy: boolean,
): Promise<void> {
  await store.put({
    key: edgeKey(src, dst),
    success_count: success,
    fail_count: fail,
    avg_cost: 0.0,
    policy,
    origin: 'policy',
    last_used_at: NOW,
    created_at: NOW,
  });
}

describe('PolicyEdgeReviewSettleHook 复审钩子', () => {
  it('失败累计超阈值 → 提请 L2 复审 + 复审前降级普通统计边', async () => {
    const store = new EdgeEvidenceStore();
    await putEdge(store, 'start', 'mid', 30, 0, true);
    await putEdge(store, 'mid', 'end', 0, 6, true); // 超阈值 5
    const records: Array<Record<string, unknown>> = [];
    const hook = new PolicyEdgeReviewSettleHook(store, {
      sink: (record) => records.push(record),
    });
    const ctx = makeCtx(
      stepsOf(
        ['start', TRACE_SUCCESS],
        ['mid', TRACE_SUCCESS],
        ['end', TRACE_SUCCESS],
      ),
    );
    await hook.settle(ctx);
    expect(hook.reviews.length).toBe(1);
    const review = hook.reviews[0]!;
    expect(review['type']).toBe('policy_edge_review_audit');
    expect(review['review_tier']).toBe('l2');
    expect(review['action']).toBe('downgraded_to_statistical');
    expect(review['src_type']).toBe('mid');
    expect(review['dst_type']).toBe('end');
    // 降级已落库：policy=False（不再 τ=1.0/豁免衰减）
    const downgraded = await store.get(edgeKey('mid', 'end'));
    expect(downgraded).not.toBeNull();
    expect(downgraded!.policy).toBe(false);
    expect(records).toEqual([review]);
    // 未超阈值的策略边保持原状
    const kept = await store.get(edgeKey('start', 'mid'));
    expect(kept).not.toBeNull();
    expect(kept!.policy).toBe(true);
    // 重复触发去重（降级后不再重复提请）
    await hook.settle(ctx);
    expect(hook.reviews.length).toBe(1);
    await store.close();
  });

  it('域证据均值反超策略边承诺 → 复审 + 降级', async () => {
    const store = new EdgeEvidenceStore();
    // 策略边成功率 0.5（1 成 1 败）
    await putEdge(store, 'start', 'mid', 1, 1, true);
    // 两条非策略边高成功率（域均值 ≈ 0.969）
    for (let i = 0; i < 2; i++) {
      await putEdge(store, `s${i}`, `t${i}`, 30, 0, false);
    }
    const hook = new PolicyEdgeReviewSettleHook(store);
    const ctx = makeCtx(
      stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_SUCCESS]),
    );
    await hook.settle(ctx);
    expect(hook.reviews.length).toBe(1);
    expect(String(hook.reviews[0]!['reason'])).toContain('域均值反超');
    const downgraded = await store.get(edgeKey('start', 'mid'));
    expect(downgraded).not.toBeNull();
    expect(downgraded!.policy).toBe(false);
    await store.close();
  });

  it('ENG1-9 增量面：未触达的策略边不评估（不做每 run 全量扫描）', async () => {
    const store = new EdgeEvidenceStore();
    // 两条策略边：一条本 run 触达（健康），一条未触达（失败累计超阈值）
    await putEdge(store, 'start', 'mid', 10, 0, true);
    await putEdge(store, 'ghost', 'never', 0, 99, true);
    const hook = new PolicyEdgeReviewSettleHook(store);
    const ctx = makeCtx(
      stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_SUCCESS]),
    );
    await hook.settle(ctx);
    expect(hook.reviews).toEqual([]); // 未触达的失败策略边不被扫描到
    // 触达该边后判据生效（失败累计 ≥5 → 复审 + 降级）
    const ghostGraph = new Graph({ name: 'g2', entry: 'ghost' });
    ghostGraph.add_node('ghost', async () => ({}));
    ghostGraph.add_node('never', async () => ({}));
    ghostGraph.add_edge('ghost', 'never');
    ghostGraph.add_exit('never');
    const ctx2 = makeCtx(
      stepsOf(['ghost', TRACE_SUCCESS], ['never', TRACE_SUCCESS]),
      { graph: ghostGraph },
    );
    await hook.settle(ctx2);
    expect(hook.reviews.length).toBe(1);
    expect(hook.reviews[0]!['src_type']).toBe('ghost');
    expect(hook.reviews[0]!['dst_type']).toBe('never');
    await store.close();
  });

  it('ENG1-9 限频面：域证据均值带缓存（scan_interval 内不重复全量扫描）', async () => {
    const store = new EdgeEvidenceStore();
    // 策略边成功率高于域均值（不触发复审，但每次触达都评估）
    await putEdge(store, 'start', 'mid', 40, 0, true);
    for (let i = 0; i < 2; i++) {
      await putEdge(store, `s${i}`, `t${i}`, 30, 0, false);
    }
    const hook = new PolicyEdgeReviewSettleHook(store, { scan_interval: 3 });
    const ctx = makeCtx(
      stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_SUCCESS]),
    );
    await hook.settle(ctx); // 首次：计算并缓存域均值
    expect(hook.reviews).toEqual([]); // 策略边未反超，不复审
    expect(hook._runs_since_refresh['code']).toBe(1);
    await hook.settle(ctx); // 缓存复用（runs 递增，不重算）
    expect(hook._runs_since_refresh['code']).toBe(2);
    await hook.settle(ctx); // 缓存复用
    expect(hook._runs_since_refresh['code']).toBe(3);
    await hook.settle(ctx); // 达 scan_interval：重算一次（runs 复位 1）
    expect(hook._runs_since_refresh['code']).toBe(1);
    await store.close();
  });
});

describe('PoolGovernanceSettleHook 池治理登记钩子', () => {
  it('可注册进 SettleHooks 链', () => {
    const gov = new PoolGovernance();
    const hook = new PoolGovernanceSettleHook(gov);
    const hooks = new SettleHooks();
    hooks.register(hook);
    expect(hooks.hooks.length).toBe(1);
    expect(hooks.hooks[0]).toBe(hook);
  });

  it('settle 不报错（占位钩子，只登记不执行）', async () => {
    const gov = new PoolGovernance();
    const hook = new PoolGovernanceSettleHook(gov);
    const ctx = makeCtx(stepsOf(['start', TRACE_SUCCESS]), {
      graph: linearGraph(),
    });
    await hook.settle(ctx);
    // 钩子不执行判定，只占位
    expect(gov.log.length).toBe(0);
  });
});
