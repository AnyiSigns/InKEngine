/**
 * 沉淀单元：指纹缓存接口（fail-closed）与失败点提案钩子。
 *
 * 对标 ink_engine/tests/test_settle.py 的「指纹缓存接口（fail-closed）」
 * 与 test_node_proposal_hook_records_drafts 节：
 * - 无闸门或无缓存 = fail-closed 不入缓存；闸门拒绝 = 记录判定但不入库；
 * - 闸门通过 + 缓存注入 → upsert（指纹 = 图摘要，证据快照随附）；
 * - callable context_fingerprint 写入键与组装查找侧同空间；callable 异常 =
 *   解析失败不入缓存（安全 fail-closed）；
 * - 提案钩子：历史失败达到阈值才登记提案（契约草案，非代码）。
 */

import { describe, expect, it } from 'vitest';

import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/store.js';
import { FingerprintSettleHook } from '../../../src/core/settle/fingerprint.js';
import { NodeProposalSettleHook } from '../../../src/core/settle/proposal.js';
import {
  TRACE_FAILED,
  TRACE_SUCCESS,
} from '../../../src/core/settle/_constants.js';
import {
  FakeCache,
  StubGate,
  edgeKey,
  linearGraph,
  makeCtx,
  stepsOf,
} from './helpers.js';

const successSteps = stepsOf(
  ['start', TRACE_SUCCESS],
  ['mid', TRACE_SUCCESS],
  ['end', TRACE_SUCCESS],
);

describe('FingerprintSettleHook fail-closed', () => {
  it('无闸门或无缓存 = 不入缓存（高质量归纳前提不满足）', async () => {
    const store = new EdgeEvidenceStore();
    const cache = new FakeCache();
    const noGate = new FingerprintSettleHook(cache, null, store);
    await noGate.settle(makeCtx(successSteps));
    expect(noGate.attempts).toEqual([]);
    expect(cache.upserts).toEqual([]);
    const noCache = new FingerprintSettleHook(null, new StubGate(true), store);
    await noCache.settle(makeCtx(successSteps));
    expect(cache.upserts).toEqual([]);
    // 闸门拒绝 = 记录判定但不入库
    const rejected = new FingerprintSettleHook(cache, new StubGate(false), store);
    await rejected.settle(makeCtx(successSteps));
    expect(rejected.attempts.length).toBe(1);
    expect(rejected.attempts[0]!['gate_passed']).toBe(false);
    expect(cache.upserts).toEqual([]);
    await store.close();
  });

  it('闸门通过 + 缓存注入 → upsert（指纹 = 图摘要，证据快照随附）', async () => {
    const store = new EdgeEvidenceStore();
    const cache = new FakeCache();
    const hook = new FingerprintSettleHook(cache, new StubGate(true), store);
    const g = linearGraph();
    await hook.settle(
      makeCtx(stepsOf(['start', 'success'], ['mid', 'success']), { graph: g }),
    );
    expect(cache.upserts.length).toBe(1);
    expect(cache.upserts[0]!['fingerprint']).toBe(g.digest());
    expect(cache.upserts[0]!['gate_passed']).toBe(true);
    expect(Array.isArray(cache.upserts[0]!['evidence_snapshot'])).toBe(true);
    // 失败 run 不入库
    await hook.settle(
      makeCtx(stepsOf(['start', 'success'], ['mid', 'failed']), { graph: g }),
    );
    expect(cache.upserts.length).toBe(1);
    await store.close();
  });

  it('callable context_fingerprint：写入键 = 组装请求指纹；callable 异常 = 降级不入缓存', async () => {
    const store = new EdgeEvidenceStore();
    const cache = new FakeCache();
    const g = linearGraph();
    const holder = { key: 'req-fp-1' };
    const hook = new FingerprintSettleHook(cache, new StubGate(true), store, {
      context_fingerprint: () => holder.key,
    });
    await hook.settle(
      makeCtx(stepsOf(['start', 'success'], ['mid', 'success']), { graph: g }),
    );
    expect(cache.upserts.length).toBe(1);
    expect(cache.upserts[0]!['fingerprint']).toBe('req-fp-1');
    // callable 抛出 → 解析失败 = 不入缓存（写入键不可得的安全降级）
    const bad = new FingerprintSettleHook(cache, new StubGate(true), store, {
      context_fingerprint: () => {
        throw new Error('指纹不可得');
      },
    });
    await bad.settle(
      makeCtx(stepsOf(['start', 'success'], ['mid', 'success']), { graph: g }),
    );
    expect(cache.upserts.length).toBe(1); // 未新增
    await store.close();
  });
});

describe('NodeProposalSettleHook 失败点提案', () => {
  it('历史失败达到阈值才登记提案（契约草案，非代码）', async () => {
    const store = new EdgeEvidenceStore();
    const sinkCalls: Array<Record<string, unknown>> = [];
    const hook = new NodeProposalSettleHook(store, {
      proposal_sink: (record) => sinkCalls.push(record),
    });
    const key = edgeKey('start', 'mid');
    // 未达阈值：1 次失败 + 0 成功 → 不提案
    await hook.settle(
      makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_FAILED]), {
        reason: 'error',
      }),
    );
    expect(hook.proposals).toEqual([]);
    // 累计失败达率线（2 样本全败，率 1.0 > 0.4）→ 提案
    await store.record_failure(key);
    await store.record_failure(key);
    await hook.settle(
      makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_FAILED]), {
        reason: 'error',
      }),
    );
    expect(hook.proposals.length).toBe(1);
    expect(hook.proposals[0]!['node_type']).toBe('mid');
    expect('input_schema' in hook.proposals[0]!).toBe(true);
    expect(sinkCalls).toEqual(hook.proposals); // 回调与登记同源
    await store.close();
  });
});
