/**
 * backup.restore 运行时编排（单一宿主命令的「停 → 换 → 装配 → 报告」骨架）。
 *
 * 恢复 = 危险整目录替换：Windows 下覆盖已打开 sqlite 的 rename 会 EPERM，
 * 故替换前必须先由调用方 halt 当前 runtime（中止在途 run + 关停引擎/存储
 * 写通道/检索域）。本模块负责替换侧编排：原目录整包快照（可回退）→
 * applyRestore 目录替换 → reboot 重装配。失败回落可诊断态：
 * - 替换失败：目录未动或已由 applyRestore 内部按快照回滚 → reboot 原目录；
 * - 替换后装配失败：备份数据不可用 → 从快照回滚原目录并 reboot 原数据。
 * 快照始终保留在 data_dir/snapshots，任何失败路径都不破坏现有数据。
 */

import { join } from 'node:path';

import type {
  BackupRestoreOutcome,
  BackupRestoreRequest,
  HostRestoreFn,
} from '../bridge/_types.js';
import {
  BackupError,
  applyRestore,
  readBackupFile,
  snapshotDataDir,
} from './snapshot.js';

/** restore 编排依赖（createHost 注入：data_dir + halt + reboot）。 */
export interface RestoreRuntimeDeps {
  data_dir: string;
  /** 停当前 runtime（中止在途 run + 引擎/存储/检索域收口）。 */
  halt(): Promise<void>;
  /** 重装配 host（重读 data_dir 持久件 + 新 runtime boot + 切活引用）。 */
  reboot(): Promise<void>;
}

/** 把快照 zip 内容回灌当前目录（回滚到恢复前状态）。 */
async function rollbackDir(dataDir: string, snapshot: string): Promise<void> {
  const parsed = await readBackupFile(snapshot);
  await applyRestore(dataDir, parsed.entries, { rollback_snapshot: null });
}

/** 归一恢复错误（附快照路径，可诊断可回退）。 */
function restoreError(prefix: string, error: unknown, snapshot: string): BackupError {
  const detail = error instanceof Error ? error.message : String(error);
  const note = detail.includes(snapshot) ? '' : `（当前目录快照保留在: ${snapshot}）`;
  return new BackupError(`${prefix}${note}${detail === '' ? '' : `: ${detail}`}`, 'restore_failed');
}

/** 创建 restore 编排执行体（调用方先 halt；执行完由调用方负责报告）。 */
export function createRestoreRunner(deps: RestoreRuntimeDeps): HostRestoreFn {
  const dataDir = deps.data_dir;

  /** 替换失败兜底：确保目录回到运行态（原目录未动/已回滚）。 */
  async function recoverAfterSwapFailed(snapshot: string, cause: unknown): Promise<never> {
    try {
      await deps.reboot();
    } catch (rebootError) {
      try {
        await rollbackDir(dataDir, snapshot);
        await deps.reboot();
      } catch (rollbackError) {
        throw restoreError(
          'backup.restore 替换失败且恢复运行态失败',
          `${cause instanceof Error ? cause.message : String(cause)}；reboot 失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          snapshot,
        );
      }
    }
    throw restoreError('backup.restore 目录替换失败', cause, snapshot);
  }

  /** 替换后装配失败兜底：从快照回滚原目录并重建（数据不破坏）。 */
  async function recoverAfterBootFailed(snapshot: string, cause: unknown): Promise<never> {
    let rollbackError: unknown = null;
    try {
      await rollbackDir(dataDir, snapshot);
      await deps.reboot();
    } catch (error) {
      rollbackError = error;
    }
    const causeText = cause instanceof Error ? cause.message : String(cause);
    if (rollbackError !== null) {
      throw restoreError(
        'backup.restore 数据装配失败且回滚失败',
        `${causeText}；回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        snapshot,
      );
    }
    throw new BackupError(
      `backup.restore 恢复数据无法装配，已回滚到恢复前状态（快照保留在: ${snapshot}）: ${causeText}`,
      'restore_failed',
    );
  }

  return async (request: BackupRestoreRequest): Promise<BackupRestoreOutcome> => {
    await deps.halt();
    let snapshot: string;
    try {
      snapshot = await snapshotDataDir(dataDir);
    } catch (error) {
      throw restoreError(
        `backup.restore 原目录快照失败（快照目录: ${join(dataDir, 'snapshots')}）`,
        error,
        join(dataDir, 'snapshots'),
      );
    }
    let applied: { restored: string[]; failed: string[] };
    try {
      applied = await applyRestore(dataDir, [...request.entries], {
        rollback_snapshot: snapshot,
      });
    } catch (error) {
      return await recoverAfterSwapFailed(snapshot, error);
    }
    try {
      await deps.reboot();
    } catch (error) {
      return await recoverAfterBootFailed(snapshot, error);
    }
    return {
      restored_entries: applied.restored.length,
      failed: applied.failed.length,
      total_size: request.total,
      snapshot,
    };
  };
}
