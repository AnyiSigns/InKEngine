/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/records.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * records.sessions/chain + audit/knowledge/sessions 命令共享辅助。
 */

import type { Storage } from '@ink-ts/engine';
import { BridgeError } from '@ink-ts/host';
import { HostSessionStore } from '../../domains/sessions/faces/logic/index.js';
import type { BridgeHandler, HostBridgeDeps, HostSessionRecord } from '@ink-ts/host';

/** JSON 化任意引擎对象（有 to_dict 用 to_dict；否则字段透传/字符串化）。 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const record = value as { to_dict?: () => unknown };
  if (typeof record.to_dict === 'function') {
    return toJsonSafe(record.to_dict());
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(entry);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => toJsonSafe(entry));
  return value;
}

/** 会话查询结果（薄簿记形态透传；时间戳 epoch 秒）。 */
export interface SessionView {
  thread_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  current_leaf: number | null;
  rename_count: number;
  round_count: number;
  last_round_id: string | null;
  last_outcome?: string;
}

/** 链记录查询结果。 */
interface ChainView {
  thread_id: string;
  chain: unknown[];
  checkpoints: unknown[];
}

export function requireThread(raw: unknown): string {
  const params = raw as { thread_id?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError('records.chain 需 params.thread_id', 'invalid_params');
  }
  return params.thread_id;
}

/** 会话簿记 → 视图（时间戳 epoch 秒；optional 字段缺省不落）。 */
export function sessionToView(record: HostSessionRecord): SessionView {
  const view: SessionView = {
    thread_id: record.thread_id,
    title: record.title,
    created_at: record.created_at,
    updated_at: record.updated_at,
    message_count: record.message_count,
    current_leaf: record.current_leaf,
    rename_count: record.rename_count,
    round_count: record.round_count,
    last_round_id: record.last_round_id,
  };
  if (record.last_outcome !== undefined) {
    view['last_outcome'] = record.last_outcome;
  }
  return view;
}

/** 处理器表形态（命令方法名真源 = plugins/commands/<id> spec.id；此处字符串键）。 */
export type RecordsHandlers = Readonly<Record<string, BridgeHandler>>;

/** 每宿主共享缓存：同一 deps 对象取同一份处理器（records.sessions 簿记 store 单例）。 */
const recordsCache = new WeakMap<HostBridgeDeps, RecordsHandlers>();

/** records 方法组构造（S3 迁入原实现；簿记 store 每 host 单例）。 */
export function buildRecordsCommands(deps: HostBridgeDeps): RecordsHandlers {
  const cached = recordsCache.get(deps);
  if (cached !== undefined) return cached;
  const sessionsStore = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  const sessions: BridgeHandler = async (): Promise<SessionView[]> => {
    const records = await sessionsStore.list().catch(() => []);
    return records.map((record) => sessionToView(record));
  };

  const chain: BridgeHandler = async (raw): Promise<ChainView> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const thread_id = requireThread(raw);
    const links = await storage.chain_index(thread_id).catch(() => []);
    const checkpoints = await storage
      .list_checkpoints(thread_id, { limit: 50 })
      .catch(() => []);
    return {
      thread_id,
      chain: links.map((link) => toJsonSafe(link)),
      checkpoints: checkpoints.map((checkpoint) => toJsonSafe(checkpoint)),
    };
  };

  const handlers: RecordsHandlers = {
    'records.sessions': sessions,
    'records.chain': chain,
  };
  recordsCache.set(deps, handlers);
  return handlers;
}

