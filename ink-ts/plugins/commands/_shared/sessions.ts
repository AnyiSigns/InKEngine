/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/sessions.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * sessions.create/rename/delete/refresh/tree/messages 六命令共享校验/簿记守卫。
 */

import { BridgeError } from '@ink-ts/host';
import type { HostSessionRecord } from '@ink-ts/host';

export function requireThread(raw: unknown, method: string): string {
  const params = raw as { thread_id?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError(`${method} 需 params.thread_id`, 'invalid_params');
  }
  return params.thread_id;
}

export function sessionOrThrow(record: HostSessionRecord | null, thread_id: string): HostSessionRecord {
  if (record === null) {
    throw new BridgeError(`会话不存在: ${thread_id}`, 'session_not_found');
  }
  return record;
}
