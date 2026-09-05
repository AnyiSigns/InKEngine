/**
 * OpenAI Responses 协议响应解析（openai_response.py 静态方法拆出）。
 *
 * 事件帧（SSE）与非流式响应体共用同一语义源（_finish_from_event_type /
 * _content_text / arguments 归一），独立成模块便于 ainvoke/astream 与
 * 直接单测复用。行为约定（与 openai_compat / anthropic 对齐）：
 * - 坏 SSE 帧/未知事件类型容错跳过（不中断整个流）；
 * - SSE error 帧经 _status_hint + classify_llm_error 分类抛 LLMError；
 * - 非流式缺 output / 非对象响应抛 LLMFormatError。
 */

import { ToolCall, ToolCallDelta, type Json } from '../../core/llm/messages.js';
import { LLMChunk, LLMResult } from '../../core/llm/base.js';
import { LLMFormatError, classify_llm_error } from '../../core/llm/errors.js';

/** 记录守卫：非 null 普通对象（排数组）。 */
function _is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从上游 error code 猜测 HTTP 状态码（与 openai_compat 同优先级序）。 */
export function _status_hint(code: unknown): number | null {
  if (typeof code !== 'string') return null;
  const lowered = code.toLowerCase();
  if (
    ['invalid_request', 'invalid_parameter', 'context_length', 'max_output_tokens', 'bad_request'].some(
      (marker) => lowered.includes(marker),
    )
  ) {
    return 400;
  }
  if (['rate', 'quota', 'limit', 'throttl'].some((marker) => lowered.includes(marker))) {
    return 429;
  }
  if (lowered.includes('not_found')) return 404;
  if (['auth', 'api_key', 'apikey'].some((marker) => lowered.includes(marker))) return 401;
  if (['timeout', 'timed'].some((marker) => lowered.includes(marker))) return 408;
  return null;
}

/** 从 HTTP 错误响应体提取 detail（error.message / error 字符串 / null）。 */
export function _error_detail(body_text: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(body_text);
  } catch {
    return null;
  }
  const error = _is_record(obj) ? obj['error'] : null;
  if (_is_record(error)) {
    const message = error['message'];
    return typeof message === 'string' ? message : JSON.stringify(error);
  }
  if (typeof error === 'string') return error;
  return null;
}

/** Responses content 字段 → 文本（消息内容为内容段数组或字符串）。 */
export function _content_text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!_is_record(item)) continue;
      const type = item['type'];
      const text = item['text'];
      if (
        (type === 'output_text' || type === 'input_text' || type === 'text') &&
        typeof text === 'string'
      ) {
        parts.push(text);
      }
    }
    return parts.join('');
  }
  return '';
}

/** arguments 归一：对象/数组形态 → JSON 字符串（其余原样返回）。 */
export function _arguments_to_string(arguments_: unknown): unknown {
  if (Array.isArray(arguments_) || _is_record(arguments_)) {
    return JSON.stringify(arguments_);
  }
  return arguments_;
}

/** 终态事件 → finish_reason（completed/incomplete/failed → 去前缀）。 */
export function _finish_from_event_type(event_type: string): string | null {
  if (
    event_type === 'response.completed' ||
    event_type === 'response.incomplete' ||
    event_type === 'response.failed'
  ) {
    return event_type.slice('response.'.length);
  }
  return null;
}

/** 单流解析状态：function_call 完成事件的工具调用 index 自增（跨调用分桶）。 */
export interface ResponsesParseState {
  next_function_index: number;
}

/** 新流解析状态（每次 astream 请求/重试前新建，index 从 0 起）。 */
export function new_responses_state(): ResponsesParseState {
  return { next_function_index: 0 };
}

/** 把一个 Responses SSE 事件解析为 LLMChunk（无信息事件返回 null 跳过）。 */
export function _chunk_from_event(
  obj: Record<string, unknown>,
  state: ResponsesParseState | null = null,
): LLMChunk | null {
  const event_type = obj['type'];
  if (typeof event_type !== 'string') return null;
  // 文本增量
  if (event_type === 'response.output_text.delta') {
    const delta = obj['delta'];
    return new LLMChunk({ token: typeof delta === 'string' ? delta : null });
  }
  // 工具调用定型（done 事件携带完整 function_call 项；同一响应流的多个
  // function_call 各自独立成工具调用，index 按完成事件次序自增分桶——
  // 硬编码 index=0 会把连续多次调用合并成单个 ToolCall 且参数拼成坏 JSON）
  if (event_type === 'response.output_item.done') {
    const item = obj['item'];
    if (_is_record(item) && item['type'] === 'function_call') {
      const arguments_ = _arguments_to_string(item['arguments']);
      const name = item['name'];
      const call_id = item['call_id'];
      const index = state === null ? 0 : state.next_function_index;
      if (state !== null) state.next_function_index += 1;
      return new LLMChunk({
        tool_calls_delta: [
          new ToolCallDelta({
            index,
            id: typeof call_id === 'string' ? call_id : null,
            name: typeof name === 'string' ? name : null,
            arguments_delta: typeof arguments_ === 'string' ? arguments_ : null,
          }),
        ],
      });
    }
    return null;
  }
  // 终态 / 用量帧（同帧可携带两者；两者皆无 = 无信息事件跳过）
  const finish = _finish_from_event_type(event_type);
  const usage = obj['usage'];
  if (finish !== null || (usage !== null && _is_record(usage))) {
    return new LLMChunk({
      finish_reason: finish,
      usage: _is_record(usage) ? (usage as Record<string, Json>) : null,
    });
  }
  return null;
}

/** 解析单条 SSE data 帧（[DONE] 忽略；error 帧抛分类后 LLMError）。 */
export function _parse_sse_line(
  line: string,
  state: ResponsesParseState | null = null,
): LLMChunk | null {
  const text = line.trim();
  if (!text.startsWith('data:')) return null;
  const data = text.slice('data:'.length).trim();
  if (!data || data === '[DONE]') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null; // 坏帧容错跳过
  }
  if (!_is_record(obj)) return null;
  if ('error' in obj) {
    const error = obj['error'];
    let detail: string | null = null;
    let code: unknown = null;
    if (_is_record(error)) {
      const message = error['message'];
      detail = typeof message === 'string' ? message : JSON.stringify(error);
      code = error['code'];
    } else {
      detail = String(error);
    }
    throw classify_llm_error(_status_hint(code), detail);
  }
  return _chunk_from_event(obj, state);
}

/** 非流式响应体 → LLMResult（output 数组展开内容/工具调用/终态/用量）。 */
export function parse_response_body(raw: unknown): LLMResult {
  if (!_is_record(raw)) throw new LLMFormatError('', '响应非对象');
  const output = raw['output'];
  if (!Array.isArray(output)) {
    throw new LLMFormatError('', `响应缺 output: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  const content_parts: string[] = [];
  const tool_calls: ToolCall[] = [];
  for (const item of output) {
    if (!_is_record(item)) continue;
    const item_type = item['type'];
    if (item_type === 'message') {
      content_parts.push(_content_text(item['content']));
    } else if (item_type === 'function_call') {
      const arguments_ = _arguments_to_string(item['arguments']);
      const name = item['name'];
      const call_id = item['call_id'];
      if (typeof name === 'string' && typeof arguments_ === 'string') {
        tool_calls.push(new ToolCall({ id: String(call_id ?? ''), name, arguments: arguments_ }));
      }
    }
  }
  const finish_reason = raw['finish_reason'];
  const usage = raw['usage'];
  return new LLMResult({
    content: content_parts.join(''),
    tool_calls: tool_calls.length > 0 ? tool_calls : null,
    finish_reason: typeof finish_reason === 'string' ? finish_reason : null,
    usage: _is_record(usage) ? (usage as Record<string, Json>) : null,
  });
}
