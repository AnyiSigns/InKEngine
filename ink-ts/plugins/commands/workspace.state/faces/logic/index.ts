/**
 * workspace.state 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/workspace.ts
 * 迁入，语义零改）。工作区授权根/挂载清单查询。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { storeFor, view } from '../../../_shared/workspace.js';

export default function createWorkspaceState(deps: HostBridgeDeps): BridgeHandler {
  const store = storeFor(deps);
  return () => view(store.state());
}
