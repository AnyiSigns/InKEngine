/**
 * RoundSteps 杂项子机制（round_steps.py user/memory/reviewCard/suggestions/error
 * 部分移植）。
 *
 * 简单一步式步骤：按类计数（user 固定串；memory_hit/review_card/suggestions/error
 * 占同前缀计数器）；user 幂等——已存在则不重复记录（回合边界判定）。
 *
 * reviewCard 携带 tool_call_id 时连带把对应工具卡置 pending——该收尾工作走
 * 主类的 toolPending 方法（与原 Python `_last_by_type` 反向查找同构）。
 */

import type { Json, JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import type { StepRecord } from './round_steps_types.js';
import { MEMORY_ATTACH_KINDS } from './round_steps_types.js';

/** 杂项方法所需的最小状态。 */
export interface MiscCtx {
  readonly steps: StepRecord[];
  readonly nextCount: (kind: string) => string;
  readonly append: (step_type: string, step_id: string, payload: JsonRecord) => string;
  readonly lastByType: (step_type: string) => StepRecord | null;
  readonly closeReply: () => void;
  readonly toolPending: (tool_call_id: string) => string;
}

/** 回合边界用户消息步骤（幂等：已存在则不重复记录）。 */
export function user(ctx: MiscCtx, content: string): string {
  const existing = ctx.lastByType('user');
  if (existing !== null) return existing.step_id;
  ctx.closeReply();
  return ctx.append('user', 'user', { content });
}

/**
 * 记忆命中：挂到最近一张规划/思考卡，否则独立 memory 步骤。
 *
 * 同 id 命中幂等（重复注入不重复挂载），返回承载步骤的 step_id。
 */
export function memoryHit(ctx: MiscCtx, hits: readonly unknown[]): string {
  let attach: StepRecord | null = null;
  for (let i = ctx.steps.length - 1; i >= 0; i--) {
    const step = ctx.steps[i]!;
    if (MEMORY_ATTACH_KINDS.includes(step.type)) {
      attach = step;
      break;
    }
  }
  if (attach === null) {
    return ctx.append(
      'memory_hit',
      `memory:${ctx.nextCount('memory_hit')}`,
      { hits: hits as Json[], attach_step_id: '' },
    );
  }
  const prevRaw = attach.payload['memories'];
  const memories: unknown[] = Array.isArray(prevRaw) ? [...prevRaw] : [];
  const knownIds = new Set<unknown>();
  for (const m of memories) {
    if (isRecord(m)) knownIds.add(m['id']);
  }
  for (const hit of hits) {
    if (!isRecord(hit)) continue;
    const id = hit['id'];
    if (!knownIds.has(id)) {
      memories.push(hit);
      knownIds.add(id);
    }
  }
  attach.payload = { ...attach.payload, memories: memories as Json[] };
  return attach.step_id;
}

/**
 * 审批卡步骤。payload 携带 tool_call_id 时连带把该工具卡置 pending。
 */
export function reviewCard(ctx: MiscCtx, payload: JsonRecord): string {
  ctx.closeReply();
  const stepId = ctx.append(
    'review_card',
    `card:${ctx.nextCount('review_card')}`,
    { payload },
  );
  const tcid = payload['tool_call_id'];
  if (typeof tcid === 'string' && tcid.length > 0) {
    ctx.toolPending(tcid);
  }
  return stepId;
}

/** 建议步骤（按 suggestions 计数器新建）。 */
export function suggestions(ctx: MiscCtx, items: readonly unknown[]): string {
  return ctx.append(
      'suggestions',
      `suggestions:${ctx.nextCount('suggestions')}`,
      { items: items as Json[] },
    );
}

/** 错误步骤（按 error 计数器新建）。 */
export function error(ctx: MiscCtx, content: string): string {
  return ctx.append(
    'error',
    `error:${ctx.nextCount('error')}`,
    { content },
  );
}