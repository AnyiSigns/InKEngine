/**
 * audit 命令面（审计导出）——append-only 审计集合的宿主只读出口。
 *
 * 审计集合名取引擎公开别名 SET_AUDIT_COLLECTION（self_application 公开
 * 面，数据面单源无第二套字面量）；语义/落库归引擎 audit_log/evolution
 * writer，host 只导出（读透传，含 ts/type 字段排序窗口）。
 */

import type { AuditCommand } from './commands.generated.js';
export { AUDIT_COMMANDS, type AuditCommand } from './commands.generated.js';
import { SET_AUDIT_COLLECTION } from '@ink-ts/engine';

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import { toJsonSafe } from './records.js';

/** 导出窗口上限（默认 500；超出显式给参限流）。 */
const DEFAULT_EXPORT_LIMIT = 500;

function parseLimit(raw: unknown, fallback: number): number {
  const params = raw as { limit?: unknown } | null;
  if (params === null || params.limit === undefined || params.limit === null) {
    return fallback;
  }
  const limit = Number(params.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new BridgeError('audit.export limit 须为正数', 'invalid_params');
  }
  return Math.min(Math.floor(limit), 10_000);
}

/** 记录时间戳排序（ts 数值为主，无 ts 排末尾）。 */
function sortByTs(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...records].sort((a, b) => {
    const aTs = typeof a['ts'] === 'number' ? a['ts'] : -1;
    const bTs = typeof b['ts'] === 'number' ? b['ts'] : -1;
    return bTs - aTs;
  });
}

/** audit.list 窗口参数（limit/after/kind；形态非法显式拒绝）。 */
function parseListParams(raw: unknown): { limit: number; after: number | null; kind: string | null } {
  const params = raw as { limit?: unknown; after?: unknown; kind?: unknown } | null;
  let limit = DEFAULT_EXPORT_LIMIT;
  if (params !== null && params.limit !== undefined && params.limit !== null) {
    const value = Number(params.limit);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BridgeError('audit.list limit 须为正数', 'invalid_params');
    }
    limit = Math.min(Math.floor(value), 10_000);
  }
  let after: number | null = null;
  if (params !== null && params.after !== undefined && params.after !== null) {
    const value = Number(params.after);
    if (!Number.isFinite(value)) {
      throw new BridgeError('audit.list after 须为 epoch 秒数值', 'invalid_params');
    }
    after = value;
  }
  let kind: string | null = null;
  if (params !== null && params.kind !== undefined && params.kind !== null) {
    if (typeof params.kind !== 'string' || params.kind === '') {
      throw new BridgeError('audit.list kind 须为非空字符串', 'invalid_params');
    }
    kind = params.kind;
  }
  return { limit, after, kind };
}

/** 记录 kind 判定（审计记录按 kind 字段归类；type 为历史兼容别名）。 */
function recordKind(record: Record<string, unknown>): string {
  const kind = record['kind'];
  if (typeof kind === 'string' && kind !== '') return kind;
  const type = record['type'];
  return typeof type === 'string' ? type : '';
}

/** audit 命令声明（方法名真源 = plugins/commands → commands.generated.ts 派生；装配由 index 聚合生成物元组）。 */
export function buildAuditCommands(deps: HostBridgeDeps): Readonly<Record<AuditCommand, BridgeHandler>> {
  const auditExport: BridgeHandler = async (raw): Promise<unknown[]> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const limit = parseLimit(raw, DEFAULT_EXPORT_LIMIT);
    const records = await storage.list_records(SET_AUDIT_COLLECTION).catch(() => []);
    return sortByTs(records).slice(0, limit).map((record) => toJsonSafe(record));
  };

  /** 审计窗口（读 set_audit 只读窗口：kind 过滤 + ts>=after + limit 截断，
   *  时间倒序；与壳 audit_list 窗口语义对齐。独立方法，非 audit.export 别名）。 */
  const auditList: BridgeHandler = async (raw): Promise<unknown> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const { limit, after, kind } = parseListParams(raw);
    const records = await storage.list_records(SET_AUDIT_COLLECTION).catch(() => []);
    const windowed = records
      .filter((record) => {
        if (kind !== null && recordKind(record) !== kind) return false;
        if (after !== null) {
          const ts = record['ts'];
          if (typeof ts !== 'number' || ts < after) return false;
        }
        return true;
      });
    return {
      records: sortByTs(windowed).slice(0, limit).map((record) => toJsonSafe(record)),
    };
  };

  return {
    'audit.export': auditExport,
    'audit.list': auditList,
  };
}
