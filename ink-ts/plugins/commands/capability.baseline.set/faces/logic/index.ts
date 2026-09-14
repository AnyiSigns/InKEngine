/**
 * capability.baseline.set 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/
 * capability.ts 迁入，语义零改）。常驻工具基线整集替换（白名单校验 = 引擎
 * set_baseline_names 结构化拒绝未知名；成功同步镜像 capability.json 存档）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, CapabilityStore, HostBridgeDeps } from '@ink-ts/host';
import { BASELINE_KEY, ephemeralCapabilityStore, runtimeOrThrow } from '../../../_shared/capability.js';

export default function createCapabilityBaselineSet(deps: HostBridgeDeps): BridgeHandler {
  const store: CapabilityStore = deps.capability ?? ephemeralCapabilityStore(deps);

  /** 常驻工具基线整集替换（白名单校验 = 引擎 set_baseline_names 结构化
   *  拒绝未知名；成功同步镜像 capability.json 存档）。 */
  const baselineSet: BridgeHandler = async (raw): Promise<unknown> => {
    runtimeOrThrow(deps);
    const params = raw as { tools?: unknown } | null;
    if (params === null || typeof params !== 'object' || !Array.isArray(params.tools)) {
      throw new BridgeError('capability.baseline.set 需 params.tools（字符串清单）', 'invalid_params');
    }
    const names = params.tools as unknown[];
    if (names.some((name) => typeof name !== 'string')) {
      throw new BridgeError('capability.baseline.set tools 须为字符串清单', 'invalid_params');
    }
    let applied: string[];
    try {
      applied = await deps.runtime.set_baseline_names(names as string[]);
    } catch (error) {
      // 引擎白名单校验（未注册工具名）失败显式回传，不落镜像
      throw new BridgeError(
        `capability.baseline.set 被拒: ${error instanceof Error ? error.message : String(error)}`,
        'invalid_params',
      );
    }
    store.put({ [BASELINE_KEY]: [...applied] });
    return { tools: [...applied] };
  };

  return baselineSet;
}
