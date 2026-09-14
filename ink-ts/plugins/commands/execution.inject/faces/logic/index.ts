/**
 * execution.inject 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/execution.ts
 * 迁入，语义零改）。§7.3 运行中用户发话注入（排队至下一 main 轮）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { requireService } from '../../../_shared/execution.js';

export default function createExecutionInject(deps: HostBridgeDeps): BridgeHandler {
  const inject: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { run_id?: unknown; text?: unknown } | null;
    if (typeof params !== 'object' || params === null || typeof params.run_id !== 'string' || params.run_id === '') {
      throw new BridgeError('execution.inject 需 params.run_id（字符串）', 'invalid_params');
    }
    if (typeof params.text !== 'string' || params.text.trim() === '') {
      throw new BridgeError('execution.inject 需 params.text（非空字符串）', 'invalid_params');
    }
    const service = requireService(deps);
    service.injectUserInput(params.run_id, params.text);
    return { run_id: params.run_id, queued: true };
  };

  return inject;
}
