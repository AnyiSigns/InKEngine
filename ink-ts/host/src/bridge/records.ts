/**
 * records 命令面（sessions / 链记录）——宿主只读查询，语义留在引擎。
 *
 * sessions = host 会话索引薄数据（rounds 收尾 upsert；S6 会话域服务在
 * 此基础上定稿，补分支/标题）；链记录 = engine storage 权威（checkpoint
 * 版本链 chain_index + 最近快照 to_dict），host 只透传 JSON 化，不复制
 * 台账。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

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

/** 会话查询结果（脱敏固定字段，不整表透传）。 */
interface SessionView {
  thread_id: string;
  title: string;
  created_at: string;
  updated_at: string;
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

export function buildRecordsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  const sessions: BridgeHandler = async (): Promise<SessionView[]> => {
    const storage = deps.runtime.storage;
    if (storage === null) return [];
    const records = await storage.list_records('host.sessions').catch(() => []);
    const views = records.map((record) => ({
      thread_id: String(record['thread_id'] ?? ''),
      title: String(record['title'] ?? ''),
      created_at: String(record['created_at'] ?? ''),
      updated_at: String(record['updated_at'] ?? ''),
      round_count: Number(record['round_count'] ?? 0),
      last_round_id: (record['last_round_id'] ?? null) as string | null,
      ...(record['last_outcome'] !== undefined
        ? { last_outcome: String(record['last_outcome']) }
        : {}),
    }));
    return views.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
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
