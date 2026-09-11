import type { ExecutionCommand } from './commands.generated.js';
export { EXECUTION_COMMANDS, type ExecutionCommand } from './commands.generated.js';
/**
 * execution 命令面（execution.run / execution.resume / execution.inject）——
 * 执行运行时（作用域/通道）会话入口 + 挂起续跑 + 运行中注入。
 *
 * 与 rounds 域并行的执行主线：rounds.send = run 级组装回合（既有语义零改动的
 * 常驻产品路），execution.run = 设计稿执行模型（作用域转场循环 + 汇聚点唯一
 * 产物）的宿主入口——薄驱动不复制机制：参数校验 + 审批姿态透传 + 结果投影
 * （run 树/事件带/汇聚点产物 + pending 挂起态），装载与转场在 engine
 * execution_runtime。execution.resume = 审批挂起续跑（决议注入 → checkpoint
 * 恢复）；execution.inject = §7.3 运行中用户发话注入（排队至下一 main 轮）。
 * 中止改用走既有 abort（本域 run 登记为在途可取消任务，rounds.abort 投递后
 * 桥调用立即拒绝 + 引擎后台自然收尾）。无组织装配（execution service 未接线）
 * = 显式拒绝 fail-closed。
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

function asRunParams(raw: unknown): ExecutionRunParams {
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

/** 执行结果投影（含 pending 挂起态面；execution.run/resume 共用）。 */
function project_result(result: ExecutionResult): Record<string, unknown> {
  return {
    run_id: result.root.run_id,
    blocked: result.blocked,
    block_reason: result.block_reason,
    outcome: result.root.outcome,
    final_product: result.final_product,
    degraded_summaries: result.degraded_summaries,
    pending_approval: result.pending_approval,
    pending: result.pending_interrupt === null
      ? null
      : {
          key: result.pending_interrupt.key,
          payload: result.pending_interrupt.payload,
          checkpoint_id: result.resume_checkpoint_id,
          run_id: result.root.run_id,
        },
    runs: result.runs.map(project_run),
    events: result.events,
    trails: result.trails.map((trail) => ({
      run_id: trail.run_id,
      entry_scope: trail.entry_scope,
      outcome: trail.outcome,
      hops: trail.hops.length,
    })),
  };
}

/** 挂起恢复参数校验（run_id + checkpoint_id + 决议形态）。 */
function asResumeParams(raw: unknown): { run_id: string; checkpoint_id: number; decision: unknown } {
  const params = raw as { run_id?: unknown; checkpoint_id?: unknown; decision?: unknown } | null;
  if (typeof params !== 'object' || params === null || typeof params.run_id !== 'string' || params.run_id === '') {
    throw new BridgeError('execution.resume 需 params.run_id（字符串）', 'invalid_params');
  }
  if (typeof params.checkpoint_id !== 'number' || !Number.isInteger(params.checkpoint_id) || params.checkpoint_id < 1) {
    throw new BridgeError('execution.resume 需 params.checkpoint_id（正整数）', 'invalid_params');
  }
  if (params.decision === undefined || params.decision === null) {
    throw new BridgeError('execution.resume 需 params.decision（accept/reject/terminate 或含 decision 对象）', 'invalid_params');
  }
  return { run_id: params.run_id, checkpoint_id: params.checkpoint_id, decision: params.decision };
}

export function buildExecutionCommands(
  deps: HostBridgeDeps,
): Readonly<Record<ExecutionCommand, BridgeHandler>> {
  /** 服务缺位守卫（execution 三命令共用）。 */
  function requireService() {
    if (deps.execution === undefined || deps.execution === null) {
      throw new BridgeError('执行运行时未装配（宿主 execution service 缺位）', 'execution_unavailable');
    }
    return deps.execution;
  }

  /** 可取消 run 任务句柄（RunTaskHandle seam；abort_current_run 依据）。 */
  class ExecutionAbortedError extends Error {
    constructor() {
      super('execution aborted');
      this.name = 'ExecutionAbortedError';
    }
  }

  function trackedRun(inner: Promise<unknown>, controller: AbortController) {
    let settled = false;
    const tracked = new Promise<unknown>((resolve, reject) => {
      inner.then(
        (value) => {
          settled = true;
          resolve(value);
        },
        (error) => {
          settled = true;
          reject(error);
        },
      );
      controller.signal.addEventListener(
        'abort',
        () => {
          if (settled) return;
          reject(new ExecutionAbortedError());
        },
        { once: true },
      );
    });
    return {
      done: () => settled,
      cancel: () => controller.abort(),
      then: (onfulfilled: ((value: unknown) => unknown) | null | undefined, onrejected: ((reason: unknown) => unknown) | null | undefined) =>
        tracked.then(
          onfulfilled as (value: unknown) => unknown,
          onrejected as (reason: unknown) => unknown,
        ),
      promise: tracked,
    };
  }

  const run: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asRunParams(raw);
    const service = requireService();
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

  const resume: BridgeHandler = async (raw): Promise<unknown> => {
    const params = asResumeParams(raw);
    const service = requireService();
    let result: ExecutionResult;
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

  const inject: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { run_id?: unknown; text?: unknown } | null;
    if (typeof params !== 'object' || params === null || typeof params.run_id !== 'string' || params.run_id === '') {
      throw new BridgeError('execution.inject 需 params.run_id（字符串）', 'invalid_params');
    }
    if (typeof params.text !== 'string' || params.text.trim() === '') {
      throw new BridgeError('execution.inject 需 params.text（非空字符串）', 'invalid_params');
    }
    const service = requireService();
    service.injectUserInput(params.run_id, params.text);
    return { run_id: params.run_id, queued: true };
  };

  return { 'execution.run': run, 'execution.resume': resume, 'execution.inject': inject };
}
