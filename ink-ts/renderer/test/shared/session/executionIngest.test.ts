/**
 * 执行树落位写面测试（回执 → 会话桶 + 活动窗口镜像）。
 *
 * 测什么：活动窗口双写（桶 + state.executionRuns）、后台线程只落桶不污染
 * 当前窗口镜像、容量截尾（保留最近 N 份）、清除面。
 */

import { ChannelHub } from '@/shared/session/channelHub';
import type { ExecutionReceipt } from '@/shared/session/executionTypes';
import {
  EXECUTION_RECEIPTS_MAX,
  clearExecutionReceipts,
  ingestExecutionReceipt,
} from '@/shared/session/executionIngest';

function receipt(runId: string): ExecutionReceipt {
  return {
    run_id: runId,
    blocked: false,
    block_reason: null,
    outcome: 'success',
    final_product: {},
    degraded_summaries: [],
    runs: [{ run_id: runId, parent_run_id: null, entry_scope: 'main', outcome: 'success', hops: [], cost: {}, error: null }],
    events: [],
    trails: [],
  };
}

function hubWithActive(active: string): ChannelHub {
  const hub = new ChannelHub();
  hub.setState({ activeSessionId: active });
  return hub;
}

describe('ingestExecutionReceipt（落位与窗口隔离）', () => {
  it('活动窗口：桶与全局镜像双写', () => {
    const hub = hubWithActive('t1');
    ingestExecutionReceipt(hub, 't1', receipt('r1'));
    const snap = hub.getSnapshot();
    expect(snap.executionRuns.map((r) => r.run_id)).toEqual(['r1']);
    expect(snap.perThread['t1'].executionRuns.map((r) => r.run_id)).toEqual(['r1']);
  });

  it('后台线程：只落桶，不污染当前窗口镜像', () => {
    const hub = hubWithActive('t1');
    ingestExecutionReceipt(hub, 't2', receipt('r-bg'));
    expect(hub.getSnapshot().executionRuns).toEqual([]);
    expect(hub.getSnapshot().perThread['t2'].executionRuns.map((r) => r.run_id)).toEqual(['r-bg']);
  });

  it('超容量截尾保留最近 N 份', () => {
    const hub = hubWithActive('t1');
    for (let i = 0; i < EXECUTION_RECEIPTS_MAX + 5; i += 1) {
      ingestExecutionReceipt(hub, 't1', receipt(`r-${i}`), 1 + i);
    }
    const snap = hub.getSnapshot();
    expect(snap.executionRuns).toHaveLength(EXECUTION_RECEIPTS_MAX);
    expect(snap.executionRuns[snap.executionRuns.length - 1].run_id).toBe(`r-${EXECUTION_RECEIPTS_MAX + 4}`);
  });

  it('clearExecutionReceipts：活动窗清双处、后台窗只清桶', () => {
    const hub = hubWithActive('t1');
    ingestExecutionReceipt(hub, 't1', receipt('ra'));
    ingestExecutionReceipt(hub, 't2', receipt('rb'));
    clearExecutionReceipts(hub, 't1');
    expect(hub.getSnapshot().executionRuns).toEqual([]);
    expect(hub.getSnapshot().perThread['t2'].executionRuns).toHaveLength(1);
  });
});
