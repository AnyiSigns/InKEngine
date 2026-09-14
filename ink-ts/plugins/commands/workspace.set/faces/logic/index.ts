/**
 * workspace.set 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/workspace.ts
 * 迁入，语义零改）。工作区授权根设置（绝对路径 + 存在性校验）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { asBridgeError, pathParam, storeFor, view } from '../../../_shared/workspace.js';

export default function createWorkspaceSet(deps: HostBridgeDeps): BridgeHandler {
  const store = storeFor(deps);
  return (params) => {
    const path = pathParam(params, 'path');
    try {
      return view(store.setRoot(path));
    } catch (err) {
      throw asBridgeError(err);
    }
  };
}
