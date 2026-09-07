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

/** records.ledger 单条账本事实行（kind + action + 节点定位 + 细节 + 时间）。 */
export interface LedgerEntryView {
  kind: string;
  action: string;
  node_id: string | null;
  detail?: Record<string, unknown>;
  ts: number;
}

/** records.ledger 查询结果。 */
export interface LedgerView {
  thread_id: string;
  entries: LedgerEntryView[];
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

/** 单条 ledger 记录 → 事实行（round 意图/结论 + events 逐条投影）。 */
function ledgerRecordToEntries(record: Record<string, unknown>): LedgerEntryView[] {
  const ts = typeof record['created_at'] === 'number' ? record['created_at'] : 0;
  const out: LedgerEntryView[] = [];
  if (typeof record['intent'] === 'string' && record['intent'] !== '') {
    out.push({
      kind: 'intent',
      action: 'round',
      node_id: null,
      detail: { text: record['intent'] },
      ts,
    });
  }
  if (typeof record['conclusion'] === 'string' && record['conclusion'] !== '') {
    out.push({
      kind: 'conclusion',
      action: 'round',
      node_id: null,
      detail: { text: record['conclusion'] },
      ts,
    });
  }
  const rawEvents = record['events'];
  const events: unknown[] = Array.isArray(rawEvents) ? rawEvents : [];
  for (const rawEvent of events) {
    if (typeof rawEvent !== 'object' || rawEvent === null) continue;
    const event = rawEvent as Record<string, unknown>;
    const kind = typeof event['kind'] === 'string' && event['kind'] !== ''
      ? event['kind']
      : 'event';
    const detail =
      typeof event['detail'] === 'object' && event['detail'] !== null
        ? (event['detail'] as Record<string, unknown>)
        : {};
    const node = typeof detail['node'] === 'string' ? detail['node'] : null;
    const status = typeof detail['status'] === 'string' ? detail['status'] : null;
    const detailView: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(detail)) {
      if (key === 'node') continue;
      detailView[key] = value;
    }
    out.push({
      kind,
      action: status ?? (kind === 'error' ? 'error' : 'round'),
      node_id: node,
      ...(Object.keys(detailView).length > 0 ? { detail: detailView } : {}),
      ts,
    });
  }
  return out;
}

/** records.ledger 查询窗口（round_index 升序全量后按 ts 倒序 + limit 截取）。 */
const LEDGER_DEFAULT_LIMIT = 200;

function parseLedgerParams(raw: unknown): { thread_id: string; limit: number } {
  const params = raw as { thread_id?: unknown; limit?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError('records.ledger 需 params.thread_id', 'invalid_params');
  }
  let limit = LEDGER_DEFAULT_LIMIT;
  if (params.limit !== undefined && params.limit !== null) {
    const value = Number(params.limit);
    if (!Number.isInteger(value) || value <= 0) {
      throw new BridgeError('records.ledger limit 须为正整数', 'invalid_params');
    }
    limit = Math.min(value, 1000);
  }
  return { thread_id: params.thread_id, limit };
}

/** records 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const RECORDS_COMMANDS = [
  'records.sessions',
  'records.chain',
  'records.ledger',
] as const;

export type RecordsCommand = (typeof RECORDS_COMMANDS)[number];

export function buildRecordsCommands(deps: HostBridgeDeps): Readonly<Record<RecordsCommand, BridgeHandler>> {
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

  /**
   * 回合账本窗口（引擎 ledger 集合 = runtime.ledger 读面同源；事实行投影）。
   * 取数走 storage.list_records_page：按 `thread_id\u001f` 键前缀 + 游标分页
   * 下推，只取该线程的账本行（引擎 ledger 键 = `${thread_id}\u001f${seq}`，
   * 升序 = 回合序），保持滑动窗口不整集物化。
   */
  const ledger: BridgeHandler = async (raw): Promise<LedgerView> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const { thread_id, limit } = parseLedgerParams(raw);
    const prefix = `${thread_id}\u001f`;
    const rows: LedgerEntryView[] = [];
    let cursor: string | null = null;
    let paged = true;
    for (;;) {
      const page: { records: Array<Record<string, unknown>>; next_cursor: string | null } | null =
        await storage
          .list_records_page('ledger', { prefix, limit: 200, cursor })
          .catch(() => null);
      if (page === null) {
        // 分页原语不可得 = 回落全量过滤语义（旧行为；当前驱动均实现分页）
        paged = false;
        break;
      }
      for (const record of page.records) {
        rows.push(...ledgerRecordToEntries(record));
        if (rows.length > limit) rows.splice(0, rows.length - limit);
      }
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    if (!paged) {
      const records = (await storage.list_records('ledger').catch(() => [])) as Array<
        Record<string, unknown>
      >;
      for (const record of records) {
        if (record['thread_id'] !== thread_id) continue;
        rows.push(...ledgerRecordToEntries(record));
      }
    }
    rows.sort((a, b) => b.ts - a.ts || (a.node_id ?? '').localeCompare(b.node_id ?? ''));
    return { thread_id, entries: rows.slice(0, limit) };
  };

  return {
    'records.sessions': sessions,
    'records.chain': chain,
    'records.ledger': ledger,
  };
}
