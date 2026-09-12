/**
 * execution.run 回执落位（写面）：回执 → 会话桶 + 当前窗口镜像。
 *
 * 与 eventIngest 的回合事件归约同纪律：按 thread 分桶（后台窗口切走后落
 * 桶不污染当前窗口），仅活动线程同步全局镜像（state.executionRuns 子通道
 * 消费面）。容量上限截尾保留最近 N 份回执，防长会话无限累积。
 *
 * W8A 增量面：主线回合（rounds.send/resume）运行期间执行事件带经 ws 实时
 * 到达——ingestRunEvent 把事件累积为镜像回执（buildReceiptFromRunEvents）后
 * 按 round 归属 upsert 落位（同轮多次事件就地替换，不重复追加卡片）。
 */

import type { ChannelHub } from './channelHub';
import { emptyThreadBucket } from './channelHub';
import type {
  ExecutionEvent,
  ExecutionReceipt,
  ExecutionRunRecord,
} from './executionTypes';

/** 单线程回执容量上限（超限截尾保留最近）。 */
export const EXECUTION_RECEIPTS_MAX = 20;

/** 增量累积桶上限（同线程同时留存回执数；超限截尾保留最近）。 */
const PENDING_ROUND_MAX = EXECUTION_RECEIPTS_MAX;

/**
 * 回执落位：写入 threadId 对应桶；threadId = 当前活动窗口时镜像全局快照。
 * threadId 空/无桶 = 建桶落位（execution.run 无回合前置，落位即建档）。
 */
export function ingestExecutionReceipt(
  hub: ChannelHub,
  threadId: string,
  receipt: ExecutionReceipt,
  at = Date.now(),
): void {
  const snapshot = hub.getSnapshot();
  const bucket = (threadId ? snapshot.perThread[threadId] : undefined) ?? emptyThreadBucket();
  const receipts = [...(bucket.executionRuns ?? []), receipt].slice(-EXECUTION_RECEIPTS_MAX);
  const nextBucket = { ...bucket, executionRuns: receipts, lastSeenAt: at };
  const isActive = threadId !== '' && threadId === snapshot.activeSessionId;
  hub.setState({
    perThread: { ...snapshot.perThread, [threadId]: nextBucket },
    ...(isActive ? { executionRuns: receipts } : {}),
  });
}

/** 清空指定线程回执（复盘面板「清除」动作面；活动窗口同步镜像）。 */
export function clearExecutionReceipts(hub: ChannelHub, threadId: string): void {
  const snapshot = hub.getSnapshot();
  const bucket = snapshot.perThread[threadId];
  if (!bucket) return;
  const isActive = threadId === snapshot.activeSessionId;
  hub.setState({
    perThread: { ...snapshot.perThread, [threadId]: { ...bucket, executionRuns: [], lastSeenAt: Date.now() } },
    ...(isActive ? { executionRuns: [] } : {}),
  });
}

/**
 * 按 round 归属替换/追加回执（增量落位写面）。round_id 命中 = 就地替换该轮
 * 卡片（运行中事件驱动逐步刷新）；未命中 = 追加（execution.run 回执等）。
 */
export function upsertExecutionReceipt(
  hub: ChannelHub,
  threadId: string,
  receipt: ExecutionReceipt,
  at = Date.now(),
): void {
  const snapshot = hub.getSnapshot();
  const bucket = (threadId ? snapshot.perThread[threadId] : undefined) ?? emptyThreadBucket();
  const existing = bucket.executionRuns ?? [];
  const idx = receipt.round_id !== undefined
    ? existing.findIndex((row) => row.round_id === receipt.round_id)
    : -1;
  const receipts = idx >= 0
    ? existing.map((row, i) => (i === idx ? receipt : row))
    : [...existing, receipt];
  const capped = receipts.slice(-EXECUTION_RECEIPTS_MAX);
  const nextBucket = { ...bucket, executionRuns: capped, lastSeenAt: at };
  const isActive = threadId !== '' && threadId === snapshot.activeSessionId;
  hub.setState({
    perThread: { ...snapshot.perThread, [threadId]: nextBucket },
    ...(isActive ? { executionRuns: capped } : {}),
  });
}

/**
 * 增量回执构建（运行中执行事件带 → 执行树镜像回执；纯函数数据面）。runs 由
 * 事件流推导：run_id 首见建档（entry_scope = 首见 scope、parent 随事件），
 * 终态事件（run_blocked/pending_approval）更新 outcome；root = 回执 run_id
 * 的建档行（缺 = 事件首行）。hops/cost/trails 事件带不携带（保持运行中零
 * 猜测——终态详情以 execution.run 回执为准）。
 */
export function buildReceiptFromRunEvents(
  runId: string,
  events: readonly ExecutionEvent[],
  roundId: string,
): ExecutionReceipt {
  const byId = new Map<string, ExecutionRunRecord>();
  for (const event of events) {
    let run = byId.get(event.run_id);
    if (run === undefined) {
      run = {
        run_id: event.run_id,
        parent_run_id: event.parent_run_id,
        entry_scope: event.scope,
        outcome: 'success',
        hops: [],
        cost: {},
        error: null,
      };
      byId.set(event.run_id, run);
    }
    if (event.action === 'run_blocked') {
      run.outcome = 'failure';
      run.error = '执行阻断';
    } else if (event.action === 'pending_approval') {
      run.outcome = 'failure';
      run.error = '审批挂起';
    }
  }
  let rootRun = byId.get(runId) ?? null;
  if (rootRun === null && events.length > 0) {
    rootRun = byId.get(events[0]!.run_id) ?? null;
  }
  return {
    run_id: runId,
    round_id: roundId,
    blocked: false,
    block_reason: null,
    outcome: rootRun === null ? null : rootRun.outcome,
    final_product: {},
    degraded_summaries: [],
    runs: [...byId.values()],
    events: [...events],
    trails: [],
  };
}

/**
 * 运行中执行事件增量落位（W8A 主线实时事件带消费面）。按 (threadId, roundId)
 * 累积事件带 → 重建镜像回执 → upsert（同轮替换）。事件源 = ws events.*
 * （hosts 侧 forwardRunEvent → round_transports → EventHub）；形状非法事件
 * （缺 run_id/scope）由调用方判定拦截。
 */
export function ingestRunEvent(
  hub: ChannelHub,
  threadId: string,
  event: ExecutionEvent,
  roundId: string,
  at = Date.now(),
): void {
  const bucketKey = roundId !== '' ? roundId : `run:${event.run_id}`;
  let rounds = pendingRounds.get(threadId);
  if (rounds === undefined) {
    rounds = new Map<string, PendingRunEvents>();
    pendingRounds.set(threadId, rounds);
  }
  let pending = rounds.get(bucketKey);
  if (pending === undefined) {
    pending = { roundId: bucketKey, runId: event.run_id, events: [] };
    rounds.set(bucketKey, pending);
    // 同线程留存轮数上限（截尾保留最近；防长会话无限累积）
    if (rounds.size > PENDING_ROUND_MAX) {
      const oldest = rounds.keys().next().value;
      if (oldest !== undefined) rounds.delete(oldest as string);
    }
  }
  pending.events.push(event);
  if (pending.runId === '') pending.runId = event.run_id;
  upsertExecutionReceipt(
    hub,
    threadId,
    buildReceiptFromRunEvents(pending.runId, pending.events, pending.roundId),
    at,
  );
}

/** 增量累积桶（threadId → roundId → 事件带；round 边界 = 事件信封 round_id）。 */
interface PendingRunEvents {
  roundId: string;
  runId: string;
  events: ExecutionEvent[];
}
const pendingRounds = new Map<string, Map<string, PendingRunEvents>>();
