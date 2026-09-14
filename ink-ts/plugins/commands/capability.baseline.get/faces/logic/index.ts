/**
 * capability.baseline.get 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/
 * capability.ts 迁入，语义零改）。常驻工具基线读取（引擎运行时单源 = 注入面同源数据）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { runtimeOrThrow } from '../../../_shared/capability.js';

export default function createCapabilityBaselineGet(deps: HostBridgeDeps): BridgeHandler {
  /** 常驻工具基线读取（引擎运行时单源 = 注入面同源数据）。 */
  const baselineGet: BridgeHandler = (): unknown => {
    runtimeOrThrow(deps);
    return { tools: deps.runtime.baseline_names };
  };

  return baselineGet;
}
