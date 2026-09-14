/**
 * sessions.refresh 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/sessions.ts
 * 迁入，语义零改）。
 */

import type { Storage } from '@ink-ts/engine';
import { HostSessionStore } from '../../../../domains/sessions/faces/logic/index.js';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { sessionToView } from '../../../_shared/records.js';
import { requireThread, sessionOrThrow } from '../../../_shared/sessions.js';

export default function createSessionsRefresh(deps: HostBridgeDeps): BridgeHandler {
  const store = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  const refresh: BridgeHandler = async (raw): Promise<unknown> => {
    const thread_id = requireThread(raw, 'sessions.refresh');
    const record = sessionOrThrow(await store.refresh(thread_id), thread_id);
    return sessionToView(record);
  };

  return refresh;
}
