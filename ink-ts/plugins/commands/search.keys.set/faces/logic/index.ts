/**
 * search.keys.set 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/search.ts
 * 迁入，语义零改）。web_search 密钥写入（进程内存态，不落盘）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { storeOf } from '../../../_shared/search.js';

export default function createSearchKeysSet(deps: HostBridgeDeps): BridgeHandler {
  const setKeys: BridgeHandler = (raw): { ok: true; count: number } => {
    const store = storeOf(deps);
    const params = raw as { keys?: unknown; provider?: unknown; api_key?: unknown } | null;
    if (typeof params !== 'object' || params === null) {
      throw new BridgeError('search.keys.set 需 params 对象', 'invalid_params');
    }
    const keys = params.keys;
    if (typeof keys === 'object' && keys !== null && !Array.isArray(keys)) {
      for (const [provider, apiKey] of Object.entries(keys as Record<string, unknown>)) {
        if (typeof apiKey !== 'string') {
          throw new BridgeError(`search.keys.set keys.${provider} 须为字符串`, 'invalid_params');
        }
        store.set(provider, apiKey);
      }
    } else if (typeof params.provider === 'string' && typeof params.api_key === 'string') {
      store.set(params.provider, params.api_key);
    } else {
      throw new BridgeError(
        'search.keys.set 需 keys 映射或 {provider, api_key}',
        'invalid_params',
      );
    }
    return { ok: true, count: store.count() };
  };

  return setKeys;
}
