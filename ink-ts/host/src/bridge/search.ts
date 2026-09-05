/**
 * search 命令面（web_search 密钥存取）——宿主内存态，不落盘。
 *
 * 密钥存于进程内 SearchKeysStore（运行时内存），只回显掩码；web_search
 * 执行体同一 store 取明文（不进信封/审计）。方法：
 * - search.keys.set  { keys?: Record<provider, apiKey> } 或
 *                    { provider, api_key } → 写入内存；
 * - search.keys.get  {} → { keys: 掩码映射, count }（无明文外泄）。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import type { SearchKeysStore } from '../search/keys.js';

function storeOf(deps: HostBridgeDeps): SearchKeysStore {
  if (deps.searchKeys === undefined) {
    throw new BridgeError('检索密钥域未装配（host 未接线 search）', 'search_unavailable');
  }
  return deps.searchKeys;
}

export function buildSearchHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
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

  const getKeys: BridgeHandler = (): { keys: Record<string, string>; count: number } => {
    const store = storeOf(deps);
    return { keys: store.masked(), count: store.count() };
  };

  return new Map<string, BridgeHandler>([
    ['search.keys.set', setKeys],
    ['search.keys.get', getKeys],
  ]);
}
