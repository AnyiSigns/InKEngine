/**
 * backup 命令面（export/preview/restore）——host 原生 data_dir 快照。
 *
 * zip 导出/预览清单/恢复替换经 host/src/backup 域（store-zip 编解码 +
 * 目录树打包/解包）；restore 为危险操作：须 confirm 精确等于固定标记
 * 'backup-restore'（fail-closed），恢复前先把当前 data_dir 整包快照到
 * data_dir/snapshots（可回退）。数据目录经 resolved 配置注入 deps.data_dir
 * （未注入 = 域不可用显式报错）。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import {
  applyRestore,
  exportDataDir,
  readBackupFile,
  snapshotDataDir,
} from '../backup/snapshot.js';

/** backup.restore 固定确认标记（危险操作 fail-closed：无标记即拒绝）。 */
export const BACKUP_RESTORE_MARKER = 'backup-restore';

function dataDirOrThrow(deps: HostBridgeDeps): string {
  if (deps.data_dir === undefined || deps.data_dir === '') {
    throw new BridgeError('backup 命令需宿主 data_dir（createHost 配置）', 'runtime_unavailable');
  }
  return deps.data_dir;
}

/** 路径参数（preview/restore 共用；非空字符串校验）。 */
function requirePath(raw: unknown, method: string): string {
  const params = raw as { path?: unknown } | null;
  if (
    params === null
    || typeof params !== 'object'
    || typeof params.path !== 'string'
    || params.path === ''
  ) {
    throw new BridgeError(`${method} 需 params.path（备份文件路径）`, 'invalid_params');
  }
  return params.path;
}

export function buildBackupHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
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

  /** 恢复替换（confirm 标记必须精确；恢复前留当前目录快照）。 */
  const restore: BridgeHandler = async (raw): Promise<unknown> => {
    const dataDir = dataDirOrThrow(deps);
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
    let parsed;
    try {
      parsed = await readBackupFile(path);
    } catch (error) {
      throw new BridgeError(
        `backup.restore 解析失败: ${error instanceof Error ? error.message : String(error)}`,
        'invalid_backup',
      );
    }
    let snapshot: string;
    try {
      snapshot = await snapshotDataDir(dataDir);
    } catch (error) {
      throw new BridgeError(
        `backup.restore 原目录快照失败（快照目录: ${join(dataDir, 'snapshots')}）: ${error instanceof Error ? error.message : String(error)}`,
        'backup_failed',
      );
    }
    try {
      const outcome = await applyRestore(dataDir, parsed.entries, {
        rollback_snapshot: snapshot,
      });
      const hasDb = parsed.entries.some((entry) => /\.sqlite/i.test(entry.path));
      return {
        restored_entries: outcome.restored.length,
        failed: outcome.failed.length,
        total_size: parsed.total,
        has_db: hasDb,
        created_at: parsed.manifest?.created_at ?? null,
        snapshot,
        restore_from: path,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const snapshotNote = detail.includes('快照保留在') || detail.includes('快照')
        ? ''
        : `（快照保留在: ${snapshot}）`;
      throw new BridgeError(`backup.restore 失败: ${detail}${snapshotNote}`, 'backup_failed');
    }
  };

  return new Map<string, BridgeHandler>([
    ['backup.export', exportHandler],
    ['backup.preview', preview],
    ['backup.restore', restore],
  ]);
}
