/**
 * models.config.put 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/models.ts
 * 迁入，语义零改）。{ config: <角色槽/备用链端点形状> } → 校验 + apply（关停 _llm
 * 并合并写回 host config）→ 原子落盘 → 引擎重建（下轮回合按新槽重解析）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { asBridgeError, isRecord, refreshEngine, requireModelConfig, requireObject } from '../../../_shared/models.js';

export default function createModelsConfigPut(deps: HostBridgeDeps): BridgeHandler {
  const put: BridgeHandler = async (raw): Promise<unknown> => {
    const params = requireObject(raw);
    if (!isRecord(params['config'])) {
      throw new BridgeError('models.config.put 需 { config: {...} }', 'invalid_params');
    }
    const handles = requireModelConfig(deps);
    let applied: Record<string, unknown>;
    try {
      applied = await handles.apply(params['config']);
    } catch (error) {
      throw asBridgeError(error, '模型配置校验失败');
    }
    try {
      await handles.persist();
    } catch (error) {
      throw asBridgeError(error, '模型配置落盘失败');
    }
    await refreshEngine(deps);
    return { saved: true, model_config: applied };
  };

  return put;
}
