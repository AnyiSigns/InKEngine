/**
 * execution.run 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/execution.ts
 * 迁入，语义零改）。执行运行时（作用域/通道）会话入口：参数校验 + 审批姿态透传 +
 * 结果投影；装载与转场在引擎 execution_runtime。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import type { ExecutionResult } from '@ink-ts/engine';
import {
  ExecutionAbortedError,
  asRunParams,
  project_result,
  requireService,
  trackedRun,
} from '../../../_shared/execution.js';

export default function createExecutionRun(deps: HostBridgeDeps): BridgeHandler {
  const run: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asRunParams(raw);
    const service = requireService(deps);
    if (deps.runtime.storage === null) {
      throw new BridgeError('运行时存储未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
    }
    const runId = params.run_id ?? `run:${service.nextSequence()}`;
    let result: ExecutionResult;
    const controller = new AbortController();
    const ticket = deps.runtime.begin_run();
    // 中止改用（既有 abort 投递）：仅运行中被中止时置位——finally 的收尾
    // abort 是清理动作，不得给后续同 run_id 执行留下陈旧中止标记
    let abortedDuringRun = false;
    try {
      const task = trackedRun(
        service.runExecution(
          {
            task: params.task,
            ...(params.trigger !== undefined && params.trigger !== null ? { trigger: params.trigger } : {}),
            ...(params.entry_scope !== undefined && params.entry_scope !== null
              ? { entry_scope: params.entry_scope } : {}),
            ...(params.entry_temp_scope !== undefined && params.entry_temp_scope !== null
              ? { entry_temp_scope: params.entry_temp_scope } : {}),
            run_id: runId,
          },
          { pose: params.pose ?? null, hang: true },
        ),
        controller,
      );
      deps.runtime.register_active_run_task(task as never);
      controller.signal.addEventListener(
        'abort',
        () => {
          abortedDuringRun = true;
        },
        { once: true },
      );
      result = (await task.promise) as ExecutionResult;
    } catch (error) {
      if (error instanceof ExecutionAbortedError) {
        if (abortedDuringRun) service.markAborted(runId);
        throw new BridgeError(
          '执行已中止（rounds.abort 已投递；引擎后台自然收尾）',
          'execution_aborted',
        );
      }
      // 装载/装配面异常（turn 执行器缺位等）显式化；执行循环内失败走
      // result.blocked/root.outcome=failure 路径，不入此处
      throw new BridgeError(
        `执行失败: ${error instanceof Error ? error.message : String(error)}`,
        'execution_error',
      );
    } finally {
      controller.abort();
      deps.runtime.end_run(ticket);
    }
    return project_result(result);
  };

  return run;
}
