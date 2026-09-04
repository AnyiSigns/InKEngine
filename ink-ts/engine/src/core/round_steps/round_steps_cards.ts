/**
 * RoundSteps 卡片（思考/规划）流式累积原语（round_steps.py thinking/plan 部分
 * 移植）。
 *
 * `_endStreamingCard` 为类内部公共原语（思考/规划收尾共用），剥离为纯函数
 * 便于 RoundSteps 主文件按子机制拆分——同 Python 私有方法语义。
 */

import type { JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import type { StepRecord } from './round_steps_types.js';

/** RoundSteps 卡片累积所需的最小状态（函数式子机制便于拆分主类）。 */
export interface CardCtx {
  readonly steps: StepRecord[];
  readonly closeReply: () => void;
  readonly nextCount: (kind: string) => string;
  readonly append: (step_type: string, step_id: string, payload: JsonRecord) => string;
  readonly popLast: () => StepRecord | null;
}

/** 思考卡开始（按 thinking 计数器新建，关闭当前回复段）。 */
export function thinkingStart(ctx: CardCtx): string {
  ctx.closeReply();
  return ctx.append(
    'thinking',
    `think:${ctx.nextCount('thinking')}`,
    { status: 'running', content: '' },
  );
}

/** 思考 token 流式追加（仅当末步是思考卡时生效）。 */
export function thinkingToken(ctx: CardCtx, token: string): void {
  const last = ctx.steps.length > 0 ? ctx.steps[ctx.steps.length - 1]! : null;
  if (last !== null && last.type === 'thinking') {
    const cur = isRecord(last.payload) ? last.payload : {};
    const prevContent = cur['content'];
    const next = (typeof prevContent === 'string' ? prevContent : '') + token;
    last.payload = { ...cur, content: next };
  }
}

/** 思考卡收尾（空思考仍返回原 step_id 供前端移除空卡）。 */
export function thinkingEnd(ctx: CardCtx): string {
  return endStreamingCard(ctx, 'thinking');
}

/** 规划卡开始（按 plan 计数器新建，关闭当前回复段）。 */
export function planStart(ctx: CardCtx): string {
  ctx.closeReply();
  return ctx.append(
    'plan',
    `plan:${ctx.nextCount('plan')}`,
    { status: 'running', content: '' },
  );
}

/** 规划 token 流式追加（仅当末步是规划卡时生效）。 */
export function planToken(ctx: CardCtx, token: string): void {
  const last = ctx.steps.length > 0 ? ctx.steps[ctx.steps.length - 1]! : null;
  if (last !== null && last.type === 'plan') {
    const cur = isRecord(last.payload) ? last.payload : {};
    const prevContent = cur['content'];
    const next = (typeof prevContent === 'string' ? prevContent : '') + token;
    last.payload = { ...cur, content: next };
  }
}

/** 规划卡收尾（空规划仍返回原 step_id 供前端移除空卡）。 */
export function planEnd(ctx: CardCtx): string {
  return endStreamingCard(ctx, 'plan');
}

/**
 * 流式文本卡（思考/规划）收尾：内容非空置 completed，空卡丢弃。
 *
 * 空卡不残留（与前端空卡自动移除一致，回放不渲染空卡）；仅当末步就是
 * 该类卡时生效——中途插入其它步骤即视为已收尾，返回 ""。
 */
function endStreamingCard(ctx: CardCtx, step_type: string): string {
  if (ctx.steps.length === 0) return '';
  const last = ctx.steps[ctx.steps.length - 1]!;
  if (last.type !== step_type) return '';
  const stepId = last.step_id;
  const contentRaw = last.payload['content'];
  const content = typeof contentRaw === 'string' ? contentRaw : '';
  if (!content.trim()) {
    ctx.popLast();
    return stepId;
  }
  last.payload = { ...last.payload, status: 'completed' };
  return stepId;
}