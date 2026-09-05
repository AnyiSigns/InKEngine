/**
 * audit 命令面（审计导出）——append-only 审计集合的宿主只读出口。
 *
 * 审计集合名取引擎公开别名 SET_AUDIT_COLLECTION（self_application 公开
 * 面，数据面单源无第二套字面量）；语义/落库归引擎 audit_log/evolution
 * writer，host 只导出（读透传，含 ts/type 字段排序窗口）。
 */

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

export function buildAuditHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  const auditExport: BridgeHandler = async (raw): Promise<unknown[]> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const limit = parseLimit(raw, DEFAULT_EXPORT_LIMIT);
    const records = await storage.list_records(SET_AUDIT_COLLECTION).catch(() => []);
    return sortByTs(records).slice(0, limit).map((record) => toJsonSafe(record));
  };

  return new Map<string, BridgeHandler>([['audit.export', auditExport]]);
}
