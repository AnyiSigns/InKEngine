/**
 * 会话宿主薄服务（storage-backed CRUD/收尾刷新/分支树推导）。
 *
 * 不复制引擎机制：链/checkpoint/审批全部在引擎；本服务只读引擎存储做
 * 簿记刷新（消息数/当前叶/时间戳），写宿主命名空间集合。rounds 收尾
 * upsert 与 records.sessions 查询统一经此服务，无第二处直接写点。
 */

import type { Storage } from '@ink-ts/engine';

import {
  HOST_SESSIONS_COLLECTION,
  type HostSessionRecord,
  type SessionBranchTree,
  branch_tree_from_chain,
  fallback_title,
  new_session_record,
  normalize_title,
  parse_session_record,
  session_record_to_json,
} from './model.js';

/** 存储访问器（调用时取 runtime.storage——boot 前为 null 时方法显式拒绝）。 */
export type StorageGetter = () => Storage | null;

/** 会话簿记刷新输入（rounds 收尾透传）。 */
export interface SessionTouchInput {
  round_id: string;
  outcome: string;
  checkpoint_id?: number | null;
}

/** 宿主会话服务错误（参数/状态问题；message 可回请求方）。 */
export class SessionServiceError extends Error {
  readonly code: string;
  constructor(message: string, code = 'session_error') {
    super(message);
    this.name = 'SessionServiceError';
    this.code = code;
  }
}

function shortId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 会话薄服务（一 host 实例一个；闭包持 storage 访问器）。 */
export class HostSessionStore {
  constructor(private readonly storage: StorageGetter) {}

  private requireStorage(): Storage {
    const storage = this.storage();
    if (storage === null) {
      throw new SessionServiceError('运行时存储未装配', 'runtime_unavailable');
    }
    return storage;
  }

  private async getRecord(thread_id: string): Promise<HostSessionRecord | null> {
    const storage = this.requireStorage();
    const data = await storage.get_record(HOST_SESSIONS_COLLECTION, thread_id).catch(() => null);
    return parse_session_record(data);
  }

  private async putRecord(record: HostSessionRecord): Promise<void> {
    const storage = this.requireStorage();
    await storage.put_record(HOST_SESSIONS_COLLECTION, record.thread_id, session_record_to_json(record));
  }

  /** 取全部非删除会话（updated_at 降序）。 */
  async list(): Promise<HostSessionRecord[]> {
    const storage = this.requireStorage();
    const records = await storage.list_records(HOST_SESSIONS_COLLECTION).catch(() => []);
    const sessions = records
      .map((raw) => parse_session_record(raw))
      .filter((record): record is HostSessionRecord => record !== null && !record.deleted);
    return sessions.sort((a, b) => b.updated_at - a.updated_at);
  }

  /** 按 thread_id 取会话（未建/已删 = null）。 */
  async get(thread_id: string): Promise<HostSessionRecord | null> {
    const record = await this.getRecord(thread_id);
    if (record === null || record.deleted) return null;
    return record;
  }

  /** 新建会话（thread_id 缺省自动生成；返回落库记录）。 */
  async create(thread_id?: string | null): Promise<HostSessionRecord> {
    const id = thread_id ?? shortId('t');
    const existing = await this.getRecord(id);
    if (existing !== null && !existing.deleted) return existing;
    const record = new_session_record(id);
    await this.putRecord(record);
    return record;
  }

  /** 改名（标题归一；非法标题抛 SessionServiceError）。 */
  async rename(thread_id: string, title: string): Promise<HostSessionRecord> {
    const normalized = normalize_title(title);
    if (normalized === null) {
      throw new SessionServiceError('标题不能为空（归一后为空串）', 'invalid_title');
    }
    const record = await this.getRecord(thread_id);
    if (record === null) {
      throw new SessionServiceError('会话不存在', 'session_not_found');
    }
    record.title = normalized;
    record.rename_count += 1;
    record.updated_at = Date.now() / 1000;
    await this.putRecord(record);
    return record;
  }

  /** 删除（逻辑删除 tombstone；链数据保留在引擎）。 */
  async remove(thread_id: string): Promise<void> {
    const record = await this.getRecord(thread_id);
    if (record === null) return;
    record.deleted = true;
    record.updated_at = Date.now() / 1000;
    await this.putRecord(record);
  }

  /** 回合收尾簿记刷新（rounds 收尾唯一写点：round_count/结局/时间戳）。 */
  async touch(
    thread_id: string,
    input: SessionTouchInput,
  ): Promise<HostSessionRecord> {
    const now = Date.now() / 1000;
    const existing = await this.getRecord(thread_id);
    const record: HostSessionRecord = existing ?? new_session_record(thread_id);
    record.updated_at = now;
    record.round_count += 1;
    record.last_round_id = input.round_id;
    record.last_outcome = input.outcome;
    if (input.checkpoint_id !== null && input.checkpoint_id !== undefined) {
      record.current_leaf = input.checkpoint_id;
    }
    await this.putRecord(record);
    return record;
  }

  /** 收尾整体刷新：消息数/当前叶派生 + 空标题自动起兜底标题。 */
  async refresh(thread_id: string): Promise<HostSessionRecord> {
    const storage = this.requireStorage();
    const checkpoint = await storage
      .get_latest_checkpoint(thread_id)
      .catch(() => null);
    const existing = await this.getRecord(thread_id);
    const record: HostSessionRecord = existing ?? new_session_record(thread_id);
    record.updated_at = Date.now() / 1000;
    if (checkpoint !== null && checkpoint !== undefined) {
      record.current_leaf = checkpoint.checkpoint_id;
      const messages = (checkpoint.state['messages'] ?? []) as unknown[];
      if (Array.isArray(messages)) {
        record.message_count = messages.filter(
          (entry) =>
            typeof entry === 'object' && entry !== null
            && (entry as { role?: unknown }).role === 'user',
        ).length;
      }
      if (record.title === '' && record.message_count >= 2) {
        record.title = fallback_title(checkpoint.created_at);
      }
    }
    await this.putRecord(record);
    return record;
  }

  /** 分支树（链多叶数据面推导；不落第二份台账）。 */
  async branch_tree(thread_id: string): Promise<SessionBranchTree> {
    const storage = this.requireStorage();
    const chain = await storage.chain_index(thread_id).catch(() => []);
    const record = await this.getRecord(thread_id);
    return branch_tree_from_chain(
      thread_id,
      chain as Array<{ checkpoint_id: number; parent_id: number | null; reason?: string | null }>,
      record?.current_leaf ?? null,
    );
  }
}
