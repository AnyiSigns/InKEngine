/**
 * 状态通道 React 绑定（绑定协议 state.* 与 inspect_* 通道的消费端）。
 *
 * 细粒度订阅：useBoundChannel 按 (channel, path) 订阅——state.<字段> 取值 =
 * 快照字段（session 通道 = 整快照），path 进一步下钻；订阅粒度到通道，
 * React 侧按快照引用比较决定是否重渲（变更即重渲，无关变更不触发）。
 * 未提供通道时组件显示未绑定提示（不崩）。_ 前缀路径段在白名单层已被拒绝，
 * 此处只负责取值（缺段返回 undefined，不抛）。
 */

import { useSyncExternalStore } from 'react';

import { INSPECT_CHANNEL_NAMES, type InspectChannelName } from '@/shared/session/inspectTypes';
import { getBindSource } from './bindSource';

function subscribeNoop(): () => void {
  return () => undefined;
}

/** 点分路径取值：空路径 = 整个值；缺段返回 undefined（不抛）。 */
export function readPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let current = obj;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 通道 → 快照字段名（state.session = 整快照，路径为空）。 */
function stateFieldOf(channel: string): string {
  return channel.slice('state.'.length);
}

/** 按通道订阅取值：state.* 状态通道 / inspect_* 快照通道。 */
export function useBoundChannel<T>(channel: string, path = ''): T | undefined {
  const source = getBindSource();
  const hub = source?.hub ?? null;

  if (channel.startsWith('inspect_') && INSPECT_CHANNEL_NAMES.includes(channel as InspectChannelName)) {
    const inspectChannel = channel as InspectChannelName;
    return useSyncExternalStore(
      hub ? (listener) => hub.subscribeInspect(inspectChannel, listener) : subscribeNoop,
      () => (hub ? readPath(hub.getInspect(inspectChannel), path) : undefined),
    ) as T | undefined;
  }

  const field = stateFieldOf(channel);
  return useSyncExternalStore(
    hub ? (listener) => hub.subscribeState(listener) : subscribeNoop,
    () => {
      if (!hub) return undefined;
      // state.session = 整快照（path 从根下钻）；state.<字段> = 字段值
      const base = field === 'session' ? hub.getSnapshot() : readPath(hub.getSnapshot(), field);
      return readPath(base, path);
    },
  ) as T | undefined;
}
