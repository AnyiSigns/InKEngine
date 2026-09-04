/**
 * RoundSteps 组装阶段方法（round_steps.py assembly 部分移植）。
 *
 * 组装阶段（assembly_started → assembly_done）固定折叠为一条「assembly」
 * 步骤——同 id 复用、收尾定型 done + 耗时（毫秒，墙钟回拨不写负耗时）。
 */

import type { JsonRecord } from '../json.js';
import type { StepRecord } from './round_steps_types.js';

/** 组装阶段方法所需的最小状态。 */
export interface AssemblyCtx {
  readonly index: Map<string, StepRecord>;
  readonly append: (step_type: string, step_id: string, payload: JsonRecord) => string;
  readonly update: (step_id: string, patch: JsonRecord) => void;
}

/**
 * 组装阶段开始（固定 assembly 步；重复进入同 id 复用）。
 *
 * 组装时间线事件（assembly_started → assembly_done）在回合中至多折叠为
 * 一条「组装」步骤——承载组装阶段墙钟（耗时在收尾时定型）。
 */
export function assemblyStart(ctx: AssemblyCtx, started_at: number): string {
  const stepId = 'assembly';
  return ctx.append(stepId, stepId, { status: 'running', started_at });
}

/**
 * 组装阶段收尾（定型 done + 耗时；缺 start = 幂等空操作）。
 *
 * 结束时间早于起点（墙钟回拨/乱序）→ 不写负耗时，仍定型 done。
 */
export function assemblyEnd(ctx: AssemblyCtx, ended_at: number): string {
  const stepId = 'assembly';
  const record = ctx.index.get(stepId);
  if (record === undefined) return '';
  const startedRaw = record.payload['started_at'];
  let elapsed: number | null = null;
  if (
    (typeof startedRaw === 'number' || typeof startedRaw === 'bigint') &&
    ended_at > Number(startedRaw)
  ) {
    elapsed = Math.round((ended_at - Number(startedRaw)) * 1000);
  }
  const patch: JsonRecord = { status: 'done' };
  if (elapsed !== null) patch['elapsed_ms'] = elapsed;
  ctx.update(stepId, patch);
  return stepId;
}