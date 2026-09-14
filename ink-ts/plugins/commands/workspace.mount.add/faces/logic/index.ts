/**
 * workspace.mount.add 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/
 * workspace.ts 迁入，语义零改）。工作区挂载清单追加。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { asBridgeError, pathParam, storeFor, view } from '../../../_shared/workspace.js';

export default function createWorkspaceMountAdd(deps: HostBridgeDeps): BridgeHandler {
  const store = storeFor(deps);
  return (params) => {
    const path = pathParam(params, 'path');
    try {
      return view(store.addMount(path));
    } catch (err) {
      throw asBridgeError(err);
    }
  };
}
