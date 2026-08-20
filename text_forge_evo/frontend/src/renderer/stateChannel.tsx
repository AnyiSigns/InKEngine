/**
 * 状态通道：绑定协议（bind.channel/path）的前端落位。
 *
 * 引擎界面描述中的 bind 声明把组件数据挂到状态通道（如 state →
 * messages）；渲染器为绑定组件提供通道订阅——通道变更即重渲。
 * 通道以 getSnapshot + subscribe 契约注入（zustand store 天然适配），
 * 组件经 useBoundPath 按点分路径取值。
 */

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

export interface StateChannel<T> {
  getSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
}

/** 渲染器支持的绑定通道（与引擎绑定白名单同源：state 通道） */
export const SUPPORTED_BIND_CHANNELS = ['state'];

const StateChannelContext = createContext<StateChannel<unknown> | null>(null);

/** 通道提供者：渲染器挂载点注入通道（缺省 = 组件显示未绑定提示）。 */
export function StateChannelProvider({
  channel,
  children,
}: {
  channel: StateChannel<unknown> | null;
  children: ReactNode;
}) {
  return (
    <StateChannelContext.Provider value={channel}>
      {children}
    </StateChannelContext.Provider>
  );
}

function readPath(obj: unknown, path: string): unknown {
  // 空路径 = 整个通道；点分路径逐段下钻（缺段返回 undefined）
  if (!path) return obj;
  let current = obj;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 绑定组件消费通道：按点分路径取值，通道变更自动重渲。 */
export function useBoundPath<T>(path: string): T | undefined {
  const channel = useContext(StateChannelContext);
  const value = useSyncExternalStore(
    channel?.subscribe ?? (() => () => undefined),
    () => {
      if (!channel) return undefined;
      return readPath(channel.getSnapshot(), path);
    },
  );
  return value as T | undefined;
}
