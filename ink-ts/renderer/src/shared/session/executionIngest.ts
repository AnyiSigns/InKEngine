/**
 * execution.run 回执落位（写面）：回执 → 会话桶 + 当前窗口镜像。
 *
 * 与 eventIngest 的回合事件归约同纪律：按 thread 分桶（后台窗口切走后落
 * 桶不污染当前窗口），仅活动线程同步全局镜像（state.executionRuns 子通道
 * 消费面）。容量上限截尾保留最近 N 份回执，防长会话无限累积。
 */

import type { ChannelHub } from './channelHub';
import { emptyThreadBucket } from './channelHub';
import type { ExecutionReceipt } from './executionTypes';

/** 单线程回执容量上限（超限截尾保留最近）。 */
export const EXECUTION_RECEIPTS_MAX = 20;

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
