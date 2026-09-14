/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/backup.ts 共享辅助原样迁入（S3 命令逻辑下沉，
 * 语义零改）：backup.export/preview/restore 三命令共用。
 */

import { BridgeError, type HostBridgeDeps } from '@ink-ts/host';

/** backup.restore 固定确认标记（危险操作 fail-closed：无标记即拒绝）。 */
export const BACKUP_RESTORE_MARKER = 'backup-restore';

/** data_dir 存在性守卫（backup 命令需宿主 data_dir；缺 = runtime_unavailable）。 */
export function dataDirOrThrow(deps: HostBridgeDeps): string {
  if (deps.data_dir === undefined || deps.data_dir === '') {
    throw new BridgeError('backup 命令需宿主 data_dir（createHost 配置）', 'runtime_unavailable');
  }
  return deps.data_dir;
}

/** 路径参数（preview/restore 共用；非空字符串校验）。 */
export function requirePath(raw: unknown, method: string): string {
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
