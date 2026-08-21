/**
 * 事件通道 React 绑定（绑定协议 events.* 通道的消费端）。
 *
 * 细粒度订阅：useBoundEvent 只订阅 bind.channel 对应的事件类型，
 * 其余事件不触发重渲（避免大对象循环/全局重渲）。事件负载原样投递，
 * 组件只消费自己声明的事件面。
 */

import { useSyncExternalStore } from 'react';

import type { EventTypeName } from '@/shared/session/eventTypes';
import type { HubEvent } from '@/shared/session/channelHub';
import { getBindSource } from './bindSource';

function subscribeNoop(): () => void {
  return () => undefined;
}

/**
 * 订阅 events.<type> 通道：返回该类型的最新事件（快照语义，无事件时为
 * undefined）；事件到达即重渲。channel 形如 "events.reply_token"。
 */
export function useBoundEvent(channel: string): HubEvent | undefined {
  const source = getBindSource();
  const hub = source?.hub ?? null;
  const type = channel.startsWith('events.') ? (channel.slice('events.'.length) as EventTypeName) : null;

  return useSyncExternalStore(
    hub && type ? (listener) => hub.onEvent(type, listener) : subscribeNoop,
    () => (hub && type ? hub.getLastEvent(type) : undefined),
  ) as HubEvent | undefined;
}
