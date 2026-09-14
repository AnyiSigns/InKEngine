/**
 * models.config.reload 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/models.ts
 * 迁入，语义零改）。从 data_dir/config.json 重读 → apply → 引擎重建（外部/冷启态
 * 再装配语义，运行中生效）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { asBridgeError, refreshEngine, requireModelConfig } from '../../../_shared/models.js';

export default function createModelsConfigReload(deps: HostBridgeDeps): BridgeHandler {
  const reload: BridgeHandler = async (): Promise<unknown> => {
    const handles = requireModelConfig(deps);
    let applied: Record<string, unknown>;
    try {
      applied = await handles.reload();
    } catch (error) {
      throw asBridgeError(error, '模型配置重载失败');
    }
    await refreshEngine(deps);
    return { reloaded: true, model_config: applied };
  };

  return reload;
}
