/**
 * sessions.rename 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/sessions.ts
 * 迁入，语义零改）。
 */

import type { Storage } from '@ink-ts/engine';
import { BridgeError, HostSessionStore } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { sessionToView } from '../../../_shared/records.js';
import { sessionOrThrow } from '../../../_shared/sessions.js';

export default function createSessionsRename(deps: HostBridgeDeps): BridgeHandler {
  const store = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  const rename: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { thread_id?: unknown; title?: unknown } | null;
    if (
      typeof params !== 'object'
      || params === null
      || typeof params.thread_id !== 'string'
      || params.thread_id === ''
    ) {
      throw new BridgeError('sessions.rename 需 params.thread_id', 'invalid_params');
    }
    if (typeof params.title !== 'string' || params.title.trim() === '') {
      throw new BridgeError('sessions.rename 需 params.title（非空字符串）', 'invalid_params');
    }
    const record = sessionOrThrow(await store.rename(params.thread_id, params.title), params.thread_id);
    return sessionToView(record);
  };

  return rename;
}
