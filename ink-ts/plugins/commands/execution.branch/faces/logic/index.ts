/**
 * execution.branch 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/execution.ts
 * 迁入，语义零改）。从既有执行 checkpoint 状态分叉新 run_id（决策留痕）——原 run
 * 不受影响，回执新 run 树。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { asBranchParams, project_result, requireService } from '../../../_shared/execution.js';

export default function createExecutionBranch(deps: HostBridgeDeps): BridgeHandler {
  const branch: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asBranchParams(raw);
    const service = requireService(deps);
    if (deps.runtime.storage === null) {
      throw new BridgeError('运行时存储未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
    }
    let result;
    try {
      result = await service.branchExecution(params.source_run_id, params.checkpoint_id, {
        run_id: params.run_id ?? `run:${service.nextSequence()}`,
        pose: params.pose ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 引擎侧锚点缺失/跨 run 锚点 = blocked 回执（与 execution.resume 同口径）；
      // 此处仅包装装配/执行面异常
      throw new BridgeError(`分支失败: ${message}`, 'execution_error');
    }
    return project_result(result);
  };

  return branch;
}
