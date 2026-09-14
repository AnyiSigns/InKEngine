/**
 * workspace.mount.remove 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/
 * workspace.ts 迁入，语义零改）。工作区挂载清单移除。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { pathParam, storeFor, view } from '../../../_shared/workspace.js';

export default function createWorkspaceMountRemove(deps: HostBridgeDeps): BridgeHandler {
  const store = storeFor(deps);
  return (params) => view(store.removeMount(pathParam(params, 'path')));
}
