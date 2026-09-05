/**
 * records 命令面（sessions / 链记录）——宿主只读查询，语义留在引擎。
 *
 * sessions = host 会话簿记（rounds 收尾经 HostSessionStore 统一写入）；
 * 链记录 = engine storage 权威（checkpoint 版本链 chain_index + 最近快照
 * to_dict），host 只透传 JSON 化，不复制台账。
 */

import type { Storage } from '@ink-ts/engine';

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import { HostSessionStore } from '../sessions/store.js';
import type { HostSessionRecord } from '../sessions/model.js';

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

function requireThread(raw: unknown): string {
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

export function buildRecordsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
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

  return new Map<string, BridgeHandler>([
    ['records.sessions', sessions],
    ['records.chain', chain],
  ]);
}
