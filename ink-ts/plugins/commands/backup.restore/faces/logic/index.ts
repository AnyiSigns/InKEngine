/**
 * backup.restore 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/backup.ts 迁入，
 * 语义零改）。恢复替换（confirm 标记必须精确；确认后先持命令闸，编排由
 * deps.restore 完成——停 runtime → 原目录快照 → 目录替换 → 重新装配）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import type { BackupRestoreRequest } from '@ink-ts/host';
// backup 域值随域插件（S4 域组2）
import { readBackupFile } from '../../../../domains/backup/faces/logic/index.js';
import { BACKUP_RESTORE_MARKER, dataDirOrThrow, requirePath } from '../../../_shared/backup.js';

export default function createBackupRestore(deps: HostBridgeDeps): BridgeHandler {
  /**
   * 恢复替换（confirm 标记必须精确；确认后先持命令闸，编排由 deps.restore
   * 完成——停 runtime → 原目录快照 → 目录替换 → 重新装配）。
   */
  const restore: BridgeHandler = async (raw): Promise<unknown> => {
    dataDirOrThrow(deps);
    const params = raw as { path?: unknown; confirm?: unknown } | null;
    if (typeof params !== 'object' || params === null) {
      throw new BridgeError('backup.restore 需 params（含 path + confirm）', 'invalid_params');
    }
    if (params.confirm !== BACKUP_RESTORE_MARKER) {
      throw new BridgeError(
        `backup.restore 需 confirm='${BACKUP_RESTORE_MARKER}'（危险操作标记缺失）`,
        'invalid_params',
      );
    }
    const path = requirePath(raw, 'backup.restore');
    if (deps.restore === undefined) {
      throw new BridgeError('backup.restore 编排未装配（createHost 注入）', 'runtime_unavailable');
    }
    const gate = deps.gate ?? null;
    if (gate !== null) gate.begin('backup.restore');
    try {
      let parsed;
      try {
        parsed = await readBackupFile(path);
      } catch (error) {
        throw new BridgeError(
          `backup.restore 解析失败: ${error instanceof Error ? error.message : String(error)}`,
          'invalid_backup',
        );
      }
      const request: BackupRestoreRequest = {
        path,
        entries: parsed.entries,
        total: parsed.total,
        created_at: parsed.manifest?.created_at ?? null,
      };
      let outcome;
      try {
        outcome = await deps.restore(request);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError(
          `backup.restore 失败: ${error instanceof Error ? error.message : String(error)}`,
          'backup_failed',
        );
      }
      const hasDb = parsed.entries.some((entry) => /\.sqlite/i.test(entry.path));
      return {
        restored_entries: outcome.restored_entries,
        failed: outcome.failed,
        total_size: request.total,
        has_db: hasDb,
        created_at: parsed.manifest?.created_at ?? null,
        snapshot: outcome.snapshot,
        restore_from: path,
        rollback_note: outcome.rollback_note ?? null,
      };
    } finally {
      if (gate !== null) gate.end();
    }
  };

  return restore;
}
