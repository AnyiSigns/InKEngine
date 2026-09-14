/**
 * search.keys.get 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/search.ts
 * 迁入，语义零改）。web_search 密钥只回显掩码（无明文外泄）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { storeOf } from '../../../_shared/search.js';

export default function createSearchKeysGet(deps: HostBridgeDeps): BridgeHandler {
  const getKeys: BridgeHandler = (): { keys: Record<string, string>; count: number } => {
    const store = storeOf(deps);
    return { keys: store.masked(), count: store.count() };
  };

  return getKeys;
}
