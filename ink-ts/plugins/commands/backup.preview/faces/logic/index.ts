/**
 * backup.preview 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/backup.ts 迁入，
 * 语义零改）。解析备份 zip → 覆盖清单（条目数/总大小/含库/导出时刻）。
 */

import { BridgeError, readBackupFile } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { requirePath } from '../../../_shared/backup.js';

export default function createBackupPreview(deps: HostBridgeDeps): BridgeHandler {
  /** 预览：解析备份 zip → 覆盖清单（条目数/总大小/含库/导出时刻）。 */
  const preview: BridgeHandler = async (raw): Promise<unknown> => {
    const path = requirePath(raw, 'backup.preview');
    let parsed;
    try {
      parsed = await readBackupFile(path);
    } catch (error) {
      throw new BridgeError(
        `backup.preview 解析失败（恢复产物将快照至 data_dir/snapshots 目录）: ${error instanceof Error ? error.message : String(error)}`,
        'invalid_backup',
      );
    }
    const hasDb = parsed.entries.some((entry) => /\.sqlite/i.test(entry.path));
    return {
      path,
      entries_total: parsed.entries.length,
      total_size: parsed.total,
      has_db: hasDb,
      created_at: parsed.manifest?.created_at ?? null,
    };
  };

  return preview;
}
