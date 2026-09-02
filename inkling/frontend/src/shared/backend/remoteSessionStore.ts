/**
 * 远程会话存储（SessionStore 契约的真实数据实现）：引擎 sqlite 会话记录。
 *
 * 会话记录 = 引擎 records 通道持久化（重启恢复）；本实现只做前端侧的
 * 内存镜像 + 宿主操作下发（新建/重命名/删除/回合后刷新经后端适配器），
 * 订阅通知在本地镜像变更时触发（组件按既有契约消费，不感知存储介质）。
 * 宿主不可用 = 回落本地存储实现（夹具/浏览器 dev 形态）。
 */

import type { SessionRecord, SessionStore } from '../session/sessionStore';
import { generateSessionTitle } from '../session/sessionStore';
import type { BackendAdapter, SessionRemoteRecord } from './backendAdapter';

function toLocalRecord(record: SessionRemoteRecord): SessionRecord {
  const createdAt = Math.round(record.created_at * 1000);
  return {
    id: record.thread_id,
    title: record.title || generateSessionTitle('', createdAt),
    titleSource: record.rename_count > 0 ? 'manual' : 'generated',
    createdAt,
    lastActiveAt: Math.round(record.updated_at * 1000),
    messages: [],
    message_count: record.message_count,
    deleted: record.deleted,
  };
}

/** 远程会话存储（后端适配器支撑；订阅本地镜像变更）。 */
export class RemoteSessionStore implements SessionStore {
  private records = new Map<string, SessionRecord>();
  private listeners = new Set<() => void>();

  constructor(private readonly backend: BackendAdapter, seed: SessionRemoteRecord[] = []) {
    for (const record of seed) {
      const local = toLocalRecord(record);
      this.records.set(local.id, local);
    }
  }

  /** 宿主拉取（重建镜像 + 通知）；失败保留既有镜像（零闪断）。 */
  async reload(): Promise<void> {
    try {
      const remote = await this.backend.sessionList();
      const next = new Map<string, SessionRecord>();
      for (const record of remote) {
        const local = toLocalRecord(record);
        // 保留本地已落盘的实时消息（回合结束回写），避免刷新覆盖历史
        const existing = this.records.get(local.id);
        if (existing && existing.messages.length > 0) {
          local.messages = existing.messages;
          // 计数与本地实际消息同步（上一回合 session_refresh 的 message_count 滞后）
          local.message_count = existing.messages.length;
        }
        next.set(local.id, local);
      }
      this.records = next;
      this.commit();
    } catch {
      // 宿主不可达：保留既有镜像（下次面板操作重试）
    }
  }

  list(): SessionRecord[] {
    return [...this.records.values()]
      .filter((r) => !r.deleted)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  create(title?: string): SessionRecord {
    // 真实数据：宿主生成线程 id + 空标题（标题生成走回合后刷新）；
    // 宿主不可用时本地生成（夹具形态）
    if (!title && this.backend.available) {
      const placeholderId = `pending-${Date.now()}`;
      const record: SessionRecord = {
        id: placeholderId,
        title: `创建中…`,
        titleSource: 'generated',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        messages: [],
      };
      this.records.set(placeholderId, record);
      this.commit();
      this.backend
        .sessionCreate()
        .then((remote) => {
          const local = toLocalRecord(remote);
          localStorageWarnFallback(local);
          // 转移占位期已回写的消息（避免 race：round-end 先回写到占位 id，
          // 随后 sessionCreate 完成删占位导致首回合消息丢失）
          const placeholder = this.records.get(placeholderId);
          if (placeholder && placeholder.messages.length > 0) local.messages = placeholder.messages;
          // 成功：占位替换为真实记录（不留双条目）
          this.records.delete(placeholderId);
          this.records.set(local.id, local);
          this.commit();
        })
        .catch(() => {
          // 失败：先清占位再本地兜底（占位 + fallback 双记录问题）
          this.records.delete(placeholderId);
          this.createLocalFallback();
        });
      return record;
    }
    return this.createLocalFallback(title);
  }

  private createLocalFallback(title?: string): SessionRecord {
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
    this.records.set(id, { ...record, title: title.trim(), titleSource: 'manual' });
    this.commit();
    if (this.backend.available) {
      void this.backend.sessionRename(id, title.trim()).catch(() => undefined);
    }
  }

  remove(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    this.commit();
    if (this.backend.available) {
      // 删除失败回滚镜像（引擎删除/墓碑失败不静默丢失会话）：会话重现
      void this.backend.sessionDelete(id).catch(() => {
        if (!this.records.has(id)) {
          this.records.set(id, record);
          this.commit();
        }
      });
    }
  }

  touch(id: string, at = Date.now()): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.set(id, { ...record, lastActiveAt: at });
    this.commit();
  }

  replaceMessages(id: string, messages: SessionRecord['messages']): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.set(id, { ...record, messages, message_count: messages.length, lastActiveAt: Date.now() });
    this.commit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 会话替换（重命名/标题生成后按宿主记录覆盖本地镜像）。 */
  applyRemote(record: SessionRemoteRecord): void {
    const local = toLocalRecord(record);
    this.records.set(local.id, local);
    this.commit();
  }

  private commit(): void {
    for (const listener of this.listeners) listener();
  }
}

function localStorageWarnFallback(_record: SessionRecord): void {
  // 备用镜像路径：本地建立即生效（宿主记录落库后替换）
}

/**
 * 会话存储选择：宿主可用 → 远程实现（真实 CRUD）；否则回落持久化
 * 本地实现（夹具/浏览器 dev 形态，行为与既有抽象一致）。
 */
export function createSessionStoreFrom(backend: BackendAdapter, fallback: () => SessionStore): SessionStore {
  if (backend.available) {
    const store = new RemoteSessionStore(backend);
    void store.reload();
    return store;
  }
  return fallback();
}
