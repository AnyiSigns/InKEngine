/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/execution.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * execution.run/resume/inject/branch 四命令共享参数校验/投影/可取消 run 基座。
 */

import { isApprovalPose } from '@ink-ts/engine';
import type { ExecutionResult, RunRecord } from '@ink-ts/engine';

import { BridgeError, type BridgeHandler, type HostBridgeDeps } from '@ink-ts/host';

export interface ExecutionRunParams {
  task: string;
  trigger?: string | null;
  entry_scope?: string | null;
  entry_temp_scope?: Record<string, unknown> | null;
  run_id?: string | null;
  pose?: string | null;
}

export function asRunParams(raw: unknown): ExecutionRunParams {
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
export function project_run(record: RunRecord): Record<string, unknown> {
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
export function project_result(result: ExecutionResult): Record<string, unknown> {
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
export function asResumeParams(raw: unknown): { run_id: string; checkpoint_id: number; decision: unknown } {
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

/** 分支分叉参数校验（source_run_id + checkpoint_id + 可选 run_id/pose）。 */
export function asBranchParams(raw: unknown): {
  source_run_id: string;
  checkpoint_id: number;
  run_id?: string | null;
  pose?: string | null;
} {
  const params = raw as {
    source_run_id?: unknown;
    checkpoint_id?: unknown;
    run_id?: unknown;
    pose?: unknown;
  } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.source_run_id !== 'string'
    || params.source_run_id === ''
  ) {
    throw new BridgeError('execution.branch 需 params.source_run_id（源 run 字符串）', 'invalid_params');
  }
  if (
    typeof params.checkpoint_id !== 'number'
    || !Number.isInteger(params.checkpoint_id)
    || params.checkpoint_id < 1
  ) {
    throw new BridgeError('execution.branch 需 params.checkpoint_id（正整数）', 'invalid_params');
  }
  if (params.run_id !== undefined && params.run_id !== null && typeof params.run_id !== 'string') {
    throw new BridgeError('execution.branch run_id 须为字符串', 'invalid_params');
  }
  if (params.pose !== undefined && params.pose !== null && !isApprovalPose(params.pose)) {
    throw new BridgeError('execution.branch pose 须为 auto/review/deny', 'invalid_params');
  }
  return {
    source_run_id: params.source_run_id,
    checkpoint_id: params.checkpoint_id,
    run_id: params.run_id as string | null,
    pose: params.pose as string | null,
  };
}

/** 服务缺位守卫（execution 四命令共用；工厂内建）。 */
export function requireService(deps: HostBridgeDeps) {
  if (deps.execution === undefined || deps.execution === null) {
    throw new BridgeError('执行运行时未装配（宿主 execution service 缺位）', 'execution_unavailable');
  }
  return deps.execution;
}

/** 可取消 run 任务句柄（RunTaskHandle seam；abort_current_run 依据）。 */
export class ExecutionAbortedError extends Error {
  constructor() {
    super('execution aborted');
    this.name = 'ExecutionAbortedError';
  }
}

/** 可取消 run 包装（execution.run 共用；cancel = 中止投递）。 */
export function trackedRun(inner: Promise<unknown>, controller: AbortController) {
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
