/**
 * 会话存储（可注入 store 抽象）：会话元数据 + 消息快照的持久化底座。
 *
 * 契约：list 按最近活跃排序（默认展示最近活跃）；create/rename/remove/
 * touch/replaceMessages 全量经过 store；持久化经存储适配器注入
 * （默认 localStorage，测试注入内存实现 = 刷新语义不可用时的回落）。
 * 组件只消费 store 接口，不感知存储介质。
 */

import type { InkMessage } from './types';

export type SessionTitleSource = 'generated' | 'manual';

export interface SessionRecord {
  id: string;
  title: string;
  titleSource: SessionTitleSource;
  createdAt: number;
  lastActiveAt: number;
  messages: InkMessage[];
}

export interface SessionStore {
  list(): SessionRecord[];
  get(id: string): SessionRecord | undefined;
  create(title?: string): SessionRecord;
  rename(id: string, title: string): void;
  remove(id: string): void;
  touch(id: string, at?: number): void;
  replaceMessages(id: string, messages: InkMessage[]): void;
  subscribe(listener: () => void): () => void;
}

type Listener = () => void;

const TITLE_MAX_CHARS = 12;

/** 标题生成：≤12 字（首行内容截断），空内容降级时间戳。 */
export function generateSessionTitle(content: string, at = Date.now()): string {
  const cleaned = content
    .replace(/[#*`>\[\]|]/g, '')
    .split(/\r?\n/)[0]
    .trim();
  if (cleaned) {
    return cleaned.length > TITLE_MAX_CHARS ? `${cleaned.slice(0, TITLE_MAX_CHARS)}…` : cleaned;
  }
  const time = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `会话 ${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

export class MemorySessionStore implements SessionStore {
  private records = new Map<string, SessionRecord>();
  private listeners = new Set<Listener>();

  constructor(seed: SessionRecord[] = []) {
    for (const record of seed) this.records.set(record.id, record);
  }

  list(): SessionRecord[] {
    return [...this.records.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  create(title?: string): SessionRecord {
    const now = Date.now();
    const record: SessionRecord = {
      id: `session-${now}-${Math.random().toString(36).slice(2, 7)}`,
      title: title ?? generateSessionTitle('', now),
      titleSource: title ? 'manual' : 'generated',
      createdAt: now,
      lastActiveAt: now,
      messages: [],
    };
    this.records.set(record.id, record);
    this.commit();
    return record;
  }

  rename(id: string, title: string): void {
    const record = this.records.get(id);
    if (!record || !title.trim()) return;
    this.records.set(id, { ...record, title: title.trim().slice(0, 40), titleSource: 'manual' });
    this.commit();
  }

  remove(id: string): void {
    if (!this.records.delete(id)) return;
    this.commit();
  }

  touch(id: string, at = Date.now()): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.set(id, { ...record, lastActiveAt: at });
    this.commit();
  }

  replaceMessages(id: string, messages: InkMessage[]): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.set(id, { ...record, messages, lastActiveAt: Date.now() });
    this.commit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = 'inkling.sessions';

export function localStorageAdapter(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function createMemoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

/** 序列化/反序列化（版本字段隔离未来契约漂移）。 */
function serialize(store: MemorySessionStore): string {
  return JSON.stringify({ version: 1, records: store.list() });
}

/**
 * 持久化会话存储：内存实现 + 存储适配器回写（读取失败/写入受限时
 * 静默降级为纯内存，不抛——会话管理不让位于存储异常）。
 */
export function createPersistentSessionStore(storage?: StorageLike): SessionStore {
  const adapter = storage ?? localStorageAdapter();
  let seeded: SessionRecord[] = [];
  if (adapter) {
    try {
      const raw = adapter.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { version?: number; records?: SessionRecord[] };
        seeded = parsed.version === 1 && Array.isArray(parsed.records) ? parsed.records : [];
      }
    } catch {
      seeded = [];
    }
  }
  const inner = new MemorySessionStore(seeded);
  const persist = (): void => {
    if (!adapter) return;
    try {
      adapter.setItem(STORAGE_KEY, serialize(inner));
    } catch {
      // 存储受限：静默降级为纯内存
    }
  };
  return {
    list: () => inner.list(),
    get: (id) => inner.get(id),
    create: (title) => {
      const record = inner.create(title);
      persist();
      return record;
    },
    rename: (id, title) => {
      inner.rename(id, title);
      persist();
    },
    remove: (id) => {
      inner.remove(id);
      persist();
    },
    touch: (id, at) => {
      inner.touch(id, at);
      persist();
    },
    replaceMessages: (id, messages) => {
      inner.replaceMessages(id, messages);
      persist();
    },
    subscribe: (listener) => inner.subscribe(listener),
  };
}

/** 会话摘要降级面（列表展示：时间短格式）。 */
export function sessionTimeLabel(at: number): string {
  const time = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}
