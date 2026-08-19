/**
 * SSE 事件运行时断言（协议 v2）。
 *
 * 与后端 domains/agent/event_protocol.py 的构造契约对齐：对关键事件做字段级
 * 运行时校验（失败仅 console.warn，不中断流式处理），提前暴露前后端契约漂移。
 * 事件类型已由 SSEEvent 联合类型声明（编译期契约），此处为运行时兜底断言。
 */
import type { SSEEvent } from '@/shared/api/types';

function warn(event: string, detail: string): void {
  if (import.meta.env.PROD) return;
  if (typeof console !== 'undefined') {
    console.warn(`[sseGuards] ${event} 契约异常: ${detail}`);
  }
}

/** 展示事件必须携带 step_id/round_id（协议 v2 精确更新契约）。 */
export function assertStepEvent(event: SSEEvent): void {
  if (!event.step_id) warn(event.type, '缺少 step_id');
  if (!event.round_id) warn(event.type, '缺少 round_id');
}

/** review_card：node_id / node_label / output_preview / reason 必填，tokens/elapsed_ms 与后端契约一致 */
export function assertReviewCard(event: SSEEvent): void {
  assertStepEvent(event);
  if (!event.node_id) warn('review_card', '缺少 node_id');
  if (!event.node_label) warn('review_card', '缺少 node_label');
  if (typeof event.output_preview !== 'string') warn('review_card', 'output_preview 非字符串');
  if (!event.reason) warn('review_card', '缺少 reason');
  if (event.review_type !== undefined &&
      event.review_type !== 'gate' && event.review_type !== 'audit' &&
      event.review_type !== 'candidate' && event.review_type !== 'body') {
    warn('review_card', `review_type 非法: ${String(event.review_type)}`);
  }
  if (event.tokens !== undefined && typeof event.tokens !== 'number') warn('review_card', 'tokens 非数字');
  if (event.elapsed_ms !== undefined && typeof event.elapsed_ms !== 'number') warn('review_card', 'elapsed_ms 非数字');
}

/** tool_end：tool_call_id / success 契约 */
export function assertToolEnd(event: SSEEvent): void {
  assertStepEvent(event);
  if (event.tool_call_id !== undefined && typeof event.tool_call_id !== 'string') warn('tool_end', 'tool_call_id 非字符串');
  if (event.success !== undefined && typeof event.success !== 'boolean') warn('tool_end', 'success 非布尔');
}

/** node_end：node_id / tokens 契约 */
export function assertNodeEnd(event: SSEEvent): void {
  assertStepEvent(event);
  if (!event.node_id) warn('node_end', '缺少 node_id');
  if (event.tokens !== undefined && typeof event.tokens !== 'number') warn('node_end', 'tokens 非数字');
}
