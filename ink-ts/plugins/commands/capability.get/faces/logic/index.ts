/**
 * capability.get 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/capability.ts
 * 迁入，语义零改）。能力记录只读 + 缺省字段注入（auto 出厂空集；缺省只在响应注入、
 * 不落盘固化）。
 */

import type { CapabilityStore } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { ephemeralCapabilityStore, withDefaults } from '../../../_shared/capability.js';

export default function createCapabilityGet(deps: HostBridgeDeps): BridgeHandler {
  const store: CapabilityStore = deps.capability ?? ephemeralCapabilityStore(deps);

  const get: BridgeHandler = (): unknown => withDefaults({ ...store.get() });

  return get;
}
