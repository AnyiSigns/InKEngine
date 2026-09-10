import type { ExecutionCommand } from './commands.generated.js';
export { EXECUTION_COMMANDS, type ExecutionCommand } from './commands.generated.js';
/**
 * execution 命令面（execution.run）——执行运行时（作用域/通道）会话入口。
 *
 * 与 rounds 域并行的执行主线：rounds.send = run 级组装回合（既有语义零改动的
 * 常驻产品路），execution.run = 设计稿执行模型（作用域转场循环 + 汇聚点唯一
 * 产物）的宿主入口——薄驱动不复制机制：参数校验 + 审批姿态透传 + 结果投影
 * （run 树/事件带/汇聚点产物），装载与转场在 engine execution_runtime。
 * 无组织装配（execution service 未接线）= 显式拒绝 fail-closed。
 */

import { isApprovalPose } from '@ink-ts/engine';
import type { ExecutionResult, RunRecord } from '@ink-ts/engine';

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

interface ExecutionRunParams {
  task: string;
  trigger?: string | null;
  entry_scope?: string | null;
  entry_temp_scope?: Record<string, unknown> | null;
  run_id?: string | null;
  pose?: string | null;
}

function asParams(raw: unknown): ExecutionRunParams {
  const params = raw as ExecutionRunParams | null;
  if (typeof params !== 'object' || params === null || typeof params.task !== 'string') {
    throw new BridgeError('execution.run 需 params.task（字符串）', 'invalid_params');
  }
  if (params.task.trim() === '') {
    throw new BridgeError('execution.run task 不能为空', 'invalid_params');
  }
  for (const key of ['trigger', 'entry_scope', 'run_id'] as const) {
    const value = params[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new BridgeError(`execution.run ${key} 须为字符串`, 'invalid_params');
    }
  }
  if (
    params.entry_temp_scope !== undefined
    && params.entry_temp_scope !== null
    && (typeof params.entry_temp_scope !== 'object' || Array.isArray(params.entry_temp_scope))
  ) {
    throw new BridgeError('execution.run entry_temp_scope 须为对象（临时作用域定义）', 'invalid_params');
  }
  if (params.entry_scope !== undefined && params.entry_scope !== null
    && params.entry_temp_scope !== undefined && params.entry_temp_scope !== null) {
    throw new BridgeError(
      'execution.run entry_scope 与 entry_temp_scope 二选一（目录作用域 vs 现场定义）',
      'invalid_params',
    );
  }
  if (params.pose !== undefined && params.pose !== null && !isApprovalPose(params.pose)) {
    throw new BridgeError('execution.run pose 须为 auto/review/deny', 'invalid_params');
  }
  return params;
}

/** run 记录投影（执行树可观测面：轨迹 hop 形态 + 成本 + 终态）。 */
function project_run(record: RunRecord): Record<string, unknown> {
  return {
    run_id: record.run_id,
    parent_run_id: record.parent_run_id,
    entry_scope: record.entry_scope,
    outcome: record.outcome,
    hops: record.hops.map((hop) => ({
      from: hop.from,
      to: hop.to,
      shape: hop.shape,
      commit: hop.commit,
      ...(hop.count !== undefined ? { count: hop.count } : {}),
    })),
    cost: record.cost,
    error: record.error,
  };
}

export function buildExecutionCommands(
  deps: HostBridgeDeps,
): Readonly<Record<ExecutionCommand, BridgeHandler>> {
  const run: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asParams(raw);
    const service = deps.execution;
    if (service === undefined || service === null) {
      throw new BridgeError('执行运行时未装配（宿主 execution service 缺位）', 'execution_unavailable');
    }
    if (deps.runtime.storage === null) {
      throw new BridgeError('运行时存储未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
    }
    let result: ExecutionResult;
    try {
      result = await service.runExecution(
        {
          task: params.task,
          ...(params.trigger !== undefined && params.trigger !== null ? { trigger: params.trigger } : {}),
          ...(params.entry_scope !== undefined && params.entry_scope !== null
            ? { entry_scope: params.entry_scope } : {}),
          ...(params.entry_temp_scope !== undefined && params.entry_temp_scope !== null
            ? { entry_temp_scope: params.entry_temp_scope } : {}),
          ...(params.run_id !== undefined && params.run_id !== null ? { run_id: params.run_id } : {}),
        },
        { pose: params.pose ?? null },
      );
    } catch (error) {
      // 装载/装配面异常（turn 执行器缺位等）显式化；执行循环内失败走
      // result.blocked/root.outcome=failure 路径，不入此处
      throw new BridgeError(
        `执行失败: ${error instanceof Error ? error.message : String(error)}`,
        'execution_error',
      );
    }
    return {
      run_id: result.root.run_id,
      blocked: result.blocked,
      block_reason: result.block_reason,
      outcome: result.root.outcome,
      final_product: result.final_product,
      degraded_summaries: result.degraded_summaries,
      runs: result.runs.map(project_run),
      events: result.events,
      trails: result.trails.map((trail) => ({
        run_id: trail.run_id,
        entry_scope: trail.entry_scope,
        outcome: trail.outcome,
        hops: trail.hops.length,
      })),
    };
  };

  return { 'execution.run': run };
}
