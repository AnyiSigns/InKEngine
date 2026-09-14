/**
 * capability.tier.set 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/
 * capability.ts 迁入，语义零改）。工具档位登记面（passthrough 白名单值
 * allow/review；无执行语义，能力 get 原样回显）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, CapabilityStore, HostBridgeDeps } from '@ink-ts/host';
import { TIER_WHITELIST, ephemeralCapabilityStore, isRecord } from '../../../_shared/capability.js';

export default function createCapabilityTierSet(deps: HostBridgeDeps): BridgeHandler {
  const store: CapabilityStore = deps.capability ?? ephemeralCapabilityStore(deps);

  /** 工具档位登记面（passthrough 白名单值 allow/review；无执行语义，
   *  能力 get 原样回显，供设置面存档/展示）。 */
  const tierSet: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { tier_overrides?: unknown } | null;
    if (params === null || typeof params !== 'object') {
      throw new BridgeError('capability.tier.set 需 params.tier_overrides', 'invalid_params');
    }
    const overrides = params.tier_overrides;
    if (!isRecord(overrides)) {
      throw new BridgeError('capability.tier.set tier_overrides 须为记录对象', 'invalid_params');
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (name === '') {
        throw new BridgeError('capability.tier.set 工具名不能为空', 'invalid_params');
      }
      if (!(TIER_WHITELIST as readonly string[]).includes(value as string)) {
        throw new BridgeError(
          `capability.tier.set 非法档位值: ${String(value)}（白名单: ${TIER_WHITELIST.join(', ')}）`,
          'invalid_params',
        );
      }
    }
    const record = store.put({ tier_overrides: { ...overrides } });
    return { tier_overrides: record['tier_overrides'] };
  };

  return tierSet;
}
