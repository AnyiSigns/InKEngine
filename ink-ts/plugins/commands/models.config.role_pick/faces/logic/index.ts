/**
 * models.config.role_pick 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/models.ts
 * 迁入，语义零改）。角色槽指派（agent/router；模型须在已添加清单内，samePick 幂等）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import {
  ROLE_SLOT_PICK_KEY,
  asBridgeError,
  asProvider,
  isRecord,
  providerModelIds,
  refreshEngine,
  requireModelConfig,
  requireObject,
  requirePick,
  requireRole,
  samePick,
} from '../../../_shared/models.js';
import type { ProviderPick } from '@ink-ts/host';

export default function createModelsConfigRolePick(deps: HostBridgeDeps): BridgeHandler {
  const rolePick: BridgeHandler = async (raw): Promise<unknown> => {
    const params = requireObject(raw);
    const role = requireRole(params);
    const pick = requirePick(params, `models.config.role_pick(${role})`);
    const handles = requireModelConfig(deps);
    const live = deps.host.config.model_config;
    const providers = Array.isArray(live['providers'])
      ? (live['providers'] as unknown[])
          .map(asProvider)
          .filter((p): p is NonNullable<ReturnType<typeof asProvider>> => p !== null)
      : [];
    const provider = providers.find((p) => p.provider_id === pick.provider_id);
    if (provider === undefined || !providerModelIds(provider).includes(pick.model_id)) {
      throw new BridgeError(
        `模型不在已添加清单: ${pick.provider_id}/${pick.model_id}`,
        'model_not_found',
      );
    }
    const pickKey = ROLE_SLOT_PICK_KEY[role]!;
    const current = isRecord(live[pickKey]) ? (live[pickKey] as unknown as ProviderPick) : null;
    if (samePick(current, pick)) {
      return { role, pick, saved: true, state: deps.host.model_config_state() };
    }
    let applied: Record<string, unknown>;
    try {
      applied = await handles.apply({
        providers: providers as never[],
        [pickKey]: pick,
      });
    } catch (error) {
      throw asBridgeError(error, `角色槽指派失败(${role})`);
    }
    void applied;
    try {
      await handles.persist();
    } catch (error) {
      throw asBridgeError(error, `角色槽指派落盘失败(${role})`);
    }
    await refreshEngine(deps);
    return { role, pick, saved: true, state: deps.host.model_config_state() };
  };

  return rolePick;
}
