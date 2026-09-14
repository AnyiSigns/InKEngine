/**
 * sessions.create 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/sessions.ts
 * 迁入，语义零改）。薄簿记写经 HostSessionStore（rounds 收尾亦走同一服务）。
 */

import type { Storage } from '@ink-ts/engine';
import { BridgeError, HostSessionStore } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { sessionToView } from '../../../_shared/records.js';

export default function createSessionsCreate(deps: HostBridgeDeps): BridgeHandler {
  const store = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  const create: BridgeHandler = async (raw): Promise<unknown> => {
    // params 缺省/显式 null 均视为「未指定 thread_id」（web 无参调用 create
    // 时线上 params 为 undefined，直接判空必须用可选链——不能只判 null）。
    const params = raw as { thread_id?: unknown } | null | undefined;
    const thread_id =
      params !== null && params !== undefined
      && typeof params.thread_id === 'string'
      && params.thread_id !== ''
        ? params.thread_id
        : undefined;
    const record = await store.create(thread_id);
    return sessionToView(record);
  };

  return create;
}
