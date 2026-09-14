/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/search.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * search.keys.set/get 两命令共享密钥域守卫。
 */

import { BridgeError } from '@ink-ts/host';
import type { HostBridgeDeps, SearchKeysStore } from '@ink-ts/host';

export function storeOf(deps: HostBridgeDeps): SearchKeysStore {
  if (deps.searchKeys === undefined) {
    throw new BridgeError('检索密钥域未装配（host 未接线 search）', 'search_unavailable');
  }
  return deps.searchKeys;
}
