/**
 * 界面状态可注入存储（折叠态 / 输入草稿等轻量 UI 状态的单一事实源）。
 *
 * 用途：主题档/视图切换不得丢失会话侧 UI 状态——消息折叠、输入草稿、
 * 面板尺寸等均经本存储读写（key = 语义字符串，值 = 任意可序列化值），
 * 组件本地 useState 只承载瞬时态。框架无关：get/subscribe 契约，
 * React 侧 useSyncExternalStore 消费。
 */

import { useSyncExternalStore } from 'react';

export interface UiStateStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  subscribe(listener: () => void): () => void;
}

type Listener = () => void;

export class MemoryUiStateStore implements UiStateStore {
  private values = new Map<string, unknown>();
  private listeners = new Set<Listener>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.values.set(key, value);
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const shared = new MemoryUiStateStore();

/** 默认实现（内存存储，进程内单例）。 */
export function uiStateStore(): UiStateStore {
  return shared;
}

let provider: (() => UiStateStore) | null = null;

/** 注入自定义实现（测试/多实例；传 null 还原默认）。 */
export function setUiStateStoreProvider(providerFn: (() => UiStateStore) | null): void {
  provider = providerFn;
}

export function getUiStateStore(): UiStateStore {
  return provider ? provider() : shared;
}

/** React 消费面：按 key 读写 + 订阅（初值缺省用 initial 兜底）。 */
export function useUiState<T>(key: string, initial?: T): [T, (value: T) => void] {
  const store = getUiStateStore();
  const value = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.get<T>(key),
  );
  const current = value === undefined ? initial : value;
  return [current as T, (next: T) => store.set<T>(key, next)];
}
