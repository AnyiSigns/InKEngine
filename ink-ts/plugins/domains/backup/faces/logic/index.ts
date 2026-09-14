/**
 * backup 域插件（S4 域组2 从 hosts/lib/src/backup 迁入，语义零改）。
 *
 * 域面 = data_dir 快照域（导出/预览/恢复两阶段安全路径）+ store-only zip
 * 编解码 + restore 运行时编排（停 → 换 → 装配 → 报告）。值随插件（域逻辑
 * 唯一实现位）；装配契约类型（BackupRestoreOutcome/BackupRestoreRequest/
 * HostRestoreFn）留宿 @ink-ts/host。默认导出 = 域服务工厂（S0 装载契约）：
 * 返回 createRestoreRunner 等域面值，createHost 经插件模块直接取用。
 */

export {
  BackupError,
  applyRestore,
  collectDirFiles,
  exportDataDir,
  readBackupFile,
  snapshotDataDir,
} from './snapshot.js';
export type { BackupManifest, DirFile } from './snapshot.js';
export { crc32, packStoreZip, unpackStoreZip, listStoreZip } from './zip_codec.js';
export type { ZipEntryInput, ZipEntryOutput } from './zip_codec.js';
export { createRestoreRunner } from './restore_runtime.js';
export type { RestoreRuntimeDeps } from './restore_runtime.js';

import { createRestoreRunner } from './restore_runtime.js';
import type { HostRestoreFn } from '@ink-ts/host';
import type { RestoreRuntimeDeps } from './restore_runtime.js';

/** backup 域服务面（createHost 经插件取用的工厂面）。 */
export interface BackupDomainFace {
  createRestoreRunner(deps: RestoreRuntimeDeps): HostRestoreFn;
}

/** S4 域服务工厂（S0 装载契约）：backup 域无持久注入态，返回编排工厂面。 */
export default function createBackupDomain(): BackupDomainFace {
  return { createRestoreRunner };
}
