/**
 * RoundSteps 工具卡方法（round_steps.py 工具卡部分移植）。
 *
 * 工具卡 start/end 同 tool_call_id 复用 + 同前缀回退计数——与节点卡/卡片
 * 子机制同构拆出，便于主文件按子机制拆分。`tool_pending` 在主类内联实现
 * 以避免与 tools.ts 循环依赖（仅 reviewCard 单一调用点）。
 */

import type { JsonRecord } from '../json.js';
import type { StepRecord } from './round_steps_types.js';

/** 工具卡方法所需的最小状态（与 cards/reply/nodes 子机制 ctx 同构）。 */
export interface ToolCtx {
  readonly steps: StepRecord[];
  readonly closeReply: () => void;
  readonly nextCount: (kind: string) => string;
  readonly lastByType: (step_type: string) => StepRecord | null;
  readonly append: (step_type: string, step_id: string, payload: JsonRecord) => string;
  readonly lastStep: () => StepRecord | null;
}

/**
 * 工具卡开始。同 tool_call_id 复用既有卡并复位 running（审批 resume 重发
 * 同一工具调用时不产生重复卡）。
 */
export function toolStart(ctx: ToolCtx, category: string, tool_call_id: string): string {
  ctx.closeReply();
  if (tool_call_id) {
    const existing = ctx.lastByType('tool');
    if (existing && existing.payload['tool_call_id'] === tool_call_id) {
      existing.payload = {
        ...existing.payload,
        category,
        status: 'running',
        success: null,
      };
      return existing.step_id;
    }
    const stepId = `tool:${tool_call_id}`;
    return ctx.append(
      'tool',
      stepId,
      { category, tool_call_id, status: 'running' },
    );
  }
  const stepId = `tool:${ctx.nextCount('tool')}`;
  return ctx.append('tool', stepId, { category, tool_call_id, status: 'running' });
}

/**
 * 工具卡收尾。返回命中的 step_id（供事件层配对更新），未命中返回 ""。
 */
export function toolEnd(ctx: ToolCtx, tool_call_id: string, success: boolean): string {
  const status: string = success ? 'done' : 'error';
  if (tool_call_id) {
    for (let i = ctx.steps.length - 1; i >= 0; i--) {
      const step = ctx.steps[i]!;
      if (step.type === 'tool' && step.payload['tool_call_id'] === tool_call_id) {
        step.payload = { ...step.payload, status, success };
        return step.step_id;
      }
    }
    return '';
  }
  // 无 tool_call_id：只认末步工具卡（无从配对更早的卡）
  const last = ctx.lastStep();
  if (last !== null && last.type === 'tool') {
    last.payload = { ...last.payload, status, success };
    return last.step_id;
  }
  return '';
}