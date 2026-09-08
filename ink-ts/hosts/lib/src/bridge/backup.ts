/**
 * backup 命令面（export/preview/restore）——host 原生 data_dir 快照。
 *
 * zip 导出/预览清单/恢复替换经 hosts/lib/src/backup 域（store-zip 编解码 +
 * 目录树打包/解包）。restore 为危险操作：须 confirm 精确等于固定标记
 * 'backup-restore'（fail-closed）。产品级 restore = 单一宿主命令，但内部
 * 编排（停 runtime → 原目录快照 → 目录替换 → 重新装配 → 报告）由
 * createHost 注入的 deps.restore 执行（先停引擎/在途 run/存储写通道，换库
 * 后才重装，规避 Windows 整目录替换覆盖已打开 sqlite 的 rename EPERM）；
 * 本层只在确认标记后持命令闸（deps.gate），执行期间并发 bridge 请求被拒。
 */

import type { BackupCommand } from './commands.generated.js';
export { BACKUP_COMMANDS, type BackupCommand } from './commands.generated.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { BridgeError, type BridgeHandler } from './_types.js';
import type { BackupRestoreRequest, HostBridgeDeps } from './_types.js';
import {
  exportDataDir,
  readBackupFile,
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

/** backup 命令声明（方法名真源 = plugins/commands → commands.generated.ts 派生；装配由 index 聚合生成物元组）。 */
export function buildBackupCommands(deps: HostBridgeDeps): Readonly<Record<BackupCommand, BridgeHandler>> {
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

  return {
    'backup.export': exportHandler,
    'backup.preview': preview,
    'backup.restore': restore,
  };
}
