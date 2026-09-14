/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/recovery.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * recovery.checkpoints/rollback/reset/settings_reset 四命令共享校验/审计留痕。
 */

import type { Storage } from '@ink-ts/engine';
import { SET_AUDIT_COLLECTION } from '@ink-ts/engine';

import { BridgeError } from '@ink-ts/host';

/** recovery.reset 的固定确认标记（危险操作 fail-closed：无标记即拒绝）。 */
export const FACTORY_RESET_MARKER = 'factory-reset';

/** recovery.settings_reset 的固定确认标记（B6 恢复设置默认逃生）。 */
export const SETTINGS_RESET_MARKER = 'settings-default';

export function requireThread(raw: unknown, method: string): { thread_id: string; checkpoint_id: number | null } {
  const params = raw as { thread_id?: unknown; checkpoint_id?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError(`${method} 需 params.thread_id`, 'invalid_params');
  }
  const cid = params.checkpoint_id;
  const checkpoint_id =
    cid === undefined || cid === null
      ? null
      : Number.isInteger(cid)
        ? (cid as number)
        : null;
  if (cid !== undefined && cid !== null && checkpoint_id === null) {
    throw new BridgeError(`${method} checkpoint_id 须为整数`, 'invalid_params');
  }
  return { thread_id: params.thread_id, checkpoint_id };
}

/** 重置审计留痕（append-only set_audit；写入失败不阻断重置语义）。 */
export async function writeResetAudit(
  storage: { allow_mechanism(collection: string): { enter(): void; exit(): void } },
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const scope = storage.allow_mechanism(SET_AUDIT_COLLECTION);
    scope.enter();
    try {
      await (storage as unknown as Storage).put_record(
        SET_AUDIT_COLLECTION,
        `op-${Math.random().toString(36).slice(2, 12)}`,
        data,
      );
    } finally {
      scope.exit();
    }
  } catch {
    // 审计失败不阻断重置（重置已按上述语义完成）
  }
}
