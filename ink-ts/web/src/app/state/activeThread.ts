/**
 * 当前活动会话 thread_id（产品壳上下文）。
 *
 * 设置节等注册式组件（不接收壳 props）取用当前会话上下文时经此读面——
 * 审计恢复的回退点是 per-thread 语义：以当前活动会话为上下文，无活动
 * 会话 = 空态（组件显示引导文案，不误触发全量/空目标操作）。
 */

import { useSyncExternalStore } from 'react';

let currentThreadId = '';
const listeners = new Set<() => void>();

/** 写入活动会话（宿主 App 随 activeSessionId 变化调用）。 */
export function setActiveThreadId(threadId: string): void {
  const next = threadId ?? '';
  if (next === currentThreadId) return;
  currentThreadId = next;
  for (const listener of listeners) listener();
}

export function getActiveThreadId(): string {
  return currentThreadId;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 活动会话订阅（设置节随会话切换即时更新上下文）。 */
export function useActiveThreadId(): string {
  return useSyncExternalStore(subscribe, getActiveThreadId, getActiveThreadId);
}
