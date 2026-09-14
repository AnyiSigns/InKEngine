/**
 * audit.list 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/audit.ts 迁入，
 * 语义零改）。审计窗口（读 set_audit 只读窗口：kind 过滤 + ts>=after + limit 截断，
 * 时间倒序；与壳 audit_list 窗口语义对齐）。
 */

import { SET_AUDIT_COLLECTION } from '@ink-ts/engine';
import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { toJsonSafe } from '../../../_shared/records.js';
import { parseListParams, recordKind, sortByTs } from '../../../_shared/audit.js';

export default function createAuditList(deps: HostBridgeDeps): BridgeHandler {
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

  return auditList;
}
