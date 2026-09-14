/**
 * audit.export 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/audit.ts 迁入，
 * 语义零改）。审计集合名 = 引擎公开别名 SET_AUDIT_COLLECTION；host 只导出。
 */

import { SET_AUDIT_COLLECTION } from '@ink-ts/engine';
import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { toJsonSafe } from '../../../_shared/records.js';
import { DEFAULT_EXPORT_LIMIT, parseLimit, sortByTs } from '../../../_shared/audit.js';

export default function createAuditExport(deps: HostBridgeDeps): BridgeHandler {
  const auditExport: BridgeHandler = async (raw): Promise<unknown[]> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const limit = parseLimit(raw, DEFAULT_EXPORT_LIMIT);
    const records = await storage.list_records(SET_AUDIT_COLLECTION).catch(() => []);
    return sortByTs(records).slice(0, limit).map((record) => toJsonSafe(record));
  };

  return auditExport;
}
