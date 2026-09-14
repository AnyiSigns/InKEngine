/**
 * sessions.delete 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/sessions.ts
 * 迁入，语义零改）。
 */

import type { Storage } from '@ink-ts/engine';
import { HostSessionStore } from '../../../../domains/sessions/faces/logic/index.js';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { requireThread } from '../../../_shared/sessions.js';

export default function createSessionsDelete(deps: HostBridgeDeps): BridgeHandler {
  const store = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  const deleteSession: BridgeHandler = async (raw): Promise<unknown> => {
    const thread_id = requireThread(raw, 'sessions.delete');
    await store.remove(thread_id);
    return { thread_id, deleted: true };
  };

  return deleteSession;
}
