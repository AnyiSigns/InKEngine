/**
 * 执行树落位写面测试（回执 → 会话桶 + 活动窗口镜像 + W8A 增量事件面）。
 *
 * 测什么：活动窗口双写（桶 + state.executionRuns）、后台线程只落桶不污染
 * 当前窗口镜像、容量截尾（保留最近 N 份）、清除面；W8A 增量面——运行中
 * 执行事件带 → 镜像回执（runs 由事件推导/终态事件更新）→ 按 round 归属
 * upsert（同轮多次事件就地替换不重复追加，跨轮并存）。
 */

import { ChannelHub } from '@/shared/session/channelHub';
import type { ExecutionEvent, ExecutionReceipt } from '@/shared/session/executionTypes';
import {
  EXECUTION_RECEIPTS_MAX,
  buildReceiptFromRunEvents,
  clearExecutionReceipts,
  ingestExecutionReceipt,
  ingestRunEvent,
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

function runEvent(runId: string, parent: string | null, scope: string, action: string): ExecutionEvent {
  return { run_id: runId, parent_run_id: parent, scope, action, detail: null };
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

describe('buildReceiptFromRunEvents（增量回执构建：事件流 → 执行树镜像）', () => {
  it('runs 由事件流推导：run_id 首见建档（entry_scope/parent 随事件），事件带全量保留', () => {
    const events = [
      runEvent('r-root', null, 'main', 'run_start'),
      runEvent('r-root', null, 'main', 'scope_turn'),
      runEvent('r-root.c0', 'r-root', 'subagent', 'scope_turn'),
      runEvent('r-root', null, 'main', 'merge'),
      runEvent('r-root', null, 'main', 'run_end'),
    ];
    const receipt = buildReceiptFromRunEvents('r-root', events, 'round-1');
    expect(receipt.run_id).toBe('r-root');
    expect(receipt.round_id).toBe('round-1');
    expect(receipt.events).toHaveLength(5);
    expect(receipt.runs.map((r) => r.run_id)).toEqual(['r-root', 'r-root.c0']);
    const root = receipt.runs[0]!;
    expect(root.entry_scope).toBe('main');
    expect(root.outcome).toBe('success');
    const child = receipt.runs[1]!;
    expect(child.parent_run_id).toBe('r-root');
    expect(child.entry_scope).toBe('subagent');
  });

  it('终态事件更新 outcome：run_blocked = 执行阻断、pending_approval = 审批挂起', () => {
    const blocked = buildReceiptFromRunEvents('r', [
      runEvent('r', null, 'main', 'run_blocked'),
    ], 'r1');
    expect(blocked.runs[0]!.outcome).toBe('failure');
    expect(blocked.runs[0]!.error).toBe('执行阻断');
    const pending = buildReceiptFromRunEvents('r', [
      runEvent('r', null, 'main', 'scope_turn'),
      runEvent('r', null, 'main', 'pending_approval'),
    ], 'r2');
    expect(pending.runs[0]!.outcome).toBe('failure');
    expect(pending.runs[0]!.error).toBe('审批挂起');
  });

  it('空事件带 = 单节点合成回执（outcome null，不崩）', () => {
    const receipt = buildReceiptFromRunEvents('r', [], 'round-0');
    expect(receipt.run_id).toBe('r');
    expect(receipt.outcome).toBeNull();
    expect(receipt.runs).toEqual([]);
  });
});

describe('ingestRunEvent（运行中事件增量落位：同轮替换、跨轮并存、窗口隔离）', () => {
  it('同轮多次事件：按 round_id 就地替换（不重复追加）；事件逐步累积', () => {
    const hub = hubWithActive('t1');
    ingestRunEvent(hub, 't1', runEvent('r:main', null, 'main', 'run_start'), 'round-1');
    ingestRunEvent(hub, 't1', runEvent('r:main', null, 'main', 'scope_turn'), 'round-1');
    ingestRunEvent(hub, 't1', runEvent('r:main', null, 'main', 'run_end'), 'round-1');
    const snap = hub.getSnapshot();
    expect(snap.executionRuns).toHaveLength(1);
    expect(snap.executionRuns[0]!.round_id).toBe('round-1');
    expect(snap.executionRuns[0]!.events).toHaveLength(3);
    expect(snap.executionRuns[0]!.runs[0]!.entry_scope).toBe('main');
  });

  it('跨轮并存：不同 round_id 各落一张卡（同 run_id 多轮）', () => {
    const hub = hubWithActive('t1');
    ingestRunEvent(hub, 't1', runEvent('r:t1', null, 'main', 'run_start'), 'round-1');
    ingestRunEvent(hub, 't1', runEvent('r:t1', null, 'main', 'run_end'), 'round-1');
    ingestRunEvent(hub, 't1', runEvent('r:t1', null, 'main', 'run_start'), 'round-2');
    const snap = hub.getSnapshot();
    expect(snap.executionRuns).toHaveLength(2);
    expect(snap.executionRuns.map((r) => r.round_id)).toEqual(['round-1', 'round-2']);
  });

  it('后台线程增量：只落桶不污染当前窗口', () => {
    const hub = hubWithActive('t1');
    ingestRunEvent(hub, 't2', runEvent('r:bg', null, 'main', 'run_start'), 'round-b');
    expect(hub.getSnapshot().executionRuns).toEqual([]);
    expect(hub.getSnapshot().perThread['t2'].executionRuns).toHaveLength(1);
  });

  it('与回执落位同桶：execution.run 回执与主线增量卡并存', () => {
    const hub = hubWithActive('t1');
    ingestExecutionReceipt(hub, 't1', receipt('run:1'));
    ingestRunEvent(hub, 't1', runEvent('r:main', null, 'main', 'run_start'), 'round-1');
    const snap = hub.getSnapshot();
    expect(snap.executionRuns.map((r) => r.run_id)).toEqual(['run:1', 'r:main']);
  });
});
