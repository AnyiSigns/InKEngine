/**
 * execution.resume 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/execution.ts
 * 迁入，语义零改）。审批挂起续跑（决议注入 → checkpoint 恢复）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { asResumeParams, project_result, requireService } from '../../../_shared/execution.js';

export default function createExecutionResume(deps: HostBridgeDeps): BridgeHandler {
  const resume: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asResumeParams(raw);
    const service = requireService(deps);
    let result;
    try {
      result = await service.resumeExecution(params.run_id, params.checkpoint_id, params.decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('无挂起卡') || message.includes('恢复锚点') || message.includes('不属于执行')) {
        throw new BridgeError(message, 'no_pending_approval');
      }
      throw new BridgeError(`续跑失败: ${message}`, 'execution_error');
    }
    return project_result(result);
  };

  return resume;
}
