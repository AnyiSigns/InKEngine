/**
 * P4.1 兜底零强化（组装反路径锁定 ①）：单节点终态兜底成功不得固化指纹缓存
 * 条目。
 *
 * 测什么：
 * - 0 边单节点图（组装兜底形态 = 从池选 flags.terminal 候选出的最小可行回合
 *   单节点图；成功仅因“无更好”）成功收尾 → FingerprintSettleHook 不 upsert，
 *   尝试留痕带 skipped_reason=terminal_fallback_no_reinforce；
 * - skip_single_node=false（显式关闭零强化）时恢复旧语义（可固化）；
 * - 多节点组合路径不受影响（既有固化语义保留，见 settle_fingerprint.test.ts）。
 * 边证据侧无需封堵的说明：单节点图无遍历 → 归因计划为空（attribution_plan
 * 对 0 遍历直接返回 []），天然不写正向 edge evidence（见 settle/attribution）。
 */
import { describe, expect, it } from 'vitest';

import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/store.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { FingerprintSettleHook } from '../../../src/kernel/settle/fingerprint.js';
import { TRACE_SUCCESS } from '../../../src/kernel/settle/_constants.js';
import {
  FakeCache,
  StubGate,
  linearGraph,
  makeCtx,
  stepsOf,
} from './helpers.js';

/** 组装兜底形态图：单结点声明式绑定 + 0 边（entry=exit=同类型）。 */
function fallback_single_node_graph(): Graph {
  const g = new Graph({ name: 'assembly.code', entry: 'llm_decider' });
  g.add_node_type('llm_decider', 'llm_decider', {});
  g.add_exit('llm_decider');
  return g;
}

const successSteps = stepsOf(['llm_decider', TRACE_SUCCESS]);

describe('FingerprintSettleHook 兜底零强化（P4.1）', () => {
  it('单节点终态兜底成功不固化缓存（attempts 留痕 skipped_reason）', async () => {
    const store = new EdgeEvidenceStore();
    const cache = new FakeCache();
    const hook = new FingerprintSettleHook(cache, new StubGate(true), store);
    const graph = fallback_single_node_graph();
    await hook.settle(makeCtx(successSteps, { graph }));
    expect(cache.upserts).toEqual([]);
    expect(hook.attempts.length).toBe(1);
    expect(hook.attempts[0]!['gate_passed']).toBe(true);
    expect(hook.attempts[0]!['skipped_reason']).toBe('terminal_fallback_no_reinforce');
    await store.close();
  });

  it('skip_single_node=false：显式关闭零强化 = 恢复原固化语义', async () => {
    const store = new EdgeEvidenceStore();
    const cache = new FakeCache();
    const hook = new FingerprintSettleHook(cache, new StubGate(true), store, {
      skip_single_node: false,
    });
    const graph = fallback_single_node_graph();
    await hook.settle(makeCtx(successSteps, { graph }));
    expect(cache.upserts.length).toBe(1);
    await store.close();
  });

  it('多节点组合路径成功仍固化（零强化只封单节点兜底形态）', async () => {
    const store = new EdgeEvidenceStore();
    const cache = new FakeCache();
    const hook = new FingerprintSettleHook(cache, new StubGate(true), store);
    const graph = linearGraph();
    await hook.settle(
      makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_SUCCESS]), {
        graph,
      }),
    );
    expect(cache.upserts.length).toBe(1);
    expect(hook.attempts[0]!['skipped_reason']).toBeUndefined();
    await store.close();
  });
});
