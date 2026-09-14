/**
 * models.config.get 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/models.ts
 * 迁入，语义零改）。掩码态 + 角色槽已配置态（明文不出进程）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

export default function createModelsConfigGet(deps: HostBridgeDeps): BridgeHandler {
  const get: BridgeHandler = () => deps.host.model_config_state();
  return get;
}
