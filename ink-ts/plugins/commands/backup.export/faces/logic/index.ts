/**
 * backup.export 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/backup.ts 迁入，
 * 语义零改）。data_dir 整包 zip 导出（dest 缺省 data_dir/backups/export-<ts>.zip）。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { BridgeError, exportDataDir } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { dataDirOrThrow } from '../../../_shared/backup.js';

export default function createBackupExport(deps: HostBridgeDeps): BridgeHandler {
  /** 导出：data_dir 整包 zip（dest 缺省 data_dir/backups/export-<ts>.zip）。 */
  const exportHandler: BridgeHandler = async (raw): Promise<unknown> => {
    const dataDir = dataDirOrThrow(deps);
    const params = raw as { dest?: unknown } | null;
    let dest: string;
    if (
      params !== null
      && typeof params === 'object'
      && typeof params.dest === 'string'
      && params.dest !== ''
    ) {
      dest = params.dest;
    } else {
      const backupsDir = join(dataDir, 'backups');
      mkdirSync(backupsDir, { recursive: true });
      dest = join(backupsDir, `export-${Math.floor(Date.now() / 1000)}.zip`);
    }
    try {
      const outcome = await exportDataDir(dataDir, dest);
      return {
        file: outcome.file,
        entries: outcome.manifest.entries,
        size: outcome.size,
        created_at: outcome.manifest.created_at,
      };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        `backup.export 失败: ${error instanceof Error ? error.message : String(error)}`,
        'backup_failed',
      );
    }
  };

  return exportHandler;
}
