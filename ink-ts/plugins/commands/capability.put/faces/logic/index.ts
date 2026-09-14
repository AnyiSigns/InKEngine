/**
 * capability.put 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/capability.ts
 * 迁入，语义零改）。整体存储但按单字段并入（读既有 → 并入 → 校验 → 落盘）；字段
 * 白名单校验失败不落盘。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, CapabilityStore, HostBridgeDeps } from '@ink-ts/host';
import { ephemeralCapabilityStore, isRecord, validatePatch } from '../../../_shared/capability.js';

export default function createCapabilityPut(deps: HostBridgeDeps): BridgeHandler {
  const store: CapabilityStore = deps.capability ?? ephemeralCapabilityStore(deps);

  const put: BridgeHandler = async (raw): Promise<unknown> => {
    if (!isRecord(raw)) {
      throw new BridgeError('capability.put 需 params 记录对象', 'invalid_params');
    }
    const patch = Object.fromEntries(
      Object.entries(raw).filter(([, value]) => value !== undefined && value !== null),
    );
    validatePatch(patch);
    return store.put(patch);
  };

  return put;
}
