/**
 * OpenAI 兼容响应解析（openai_compat.py 拆分：SSE 帧 + 非流式补全 + 错误文本）。
 *
 * 覆盖：DeepSeek 系 reasoning_content/reasoning 增量透传为 reasoning_token、
 * 工具调用按 index 增量、usage 帧合并、[DONE]/坏帧容错跳过、error 帧按
 * _status_hint(code) 分类抛 LLMError。解析层纯函数、零 IO（流式逐行喂入）。
 */
import { LLMChunk } from '../../core/llm/base.js';
import { ToolCall, ToolCallDelta, type Json } from '../../core/llm/_shapes.js';
import { LLMFormatError, classify_llm_error } from '../../core/llm/errors.js';

/** 兼容端点常见但非标准的推理字段（DeepSeek/DashScope qwq 等）。 */
export const _REASONING_FIELDS = ['reasoning_content', 'reasoning'] as const;

type Dict = Record<string, unknown>;

function is_dict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function get_str(dict: Dict, key: string): string | null {
  const value = dict[key];
  return typeof value === 'string' ? value : null;
}

function as_json_object(v: unknown): Record<string, Json> | null {
  return is_dict(v) ? (v as Record<string, Json>) : null;
}

/** 从上游错误 code 猜测 HTTP 状态码（分类提示，无则 None）。分支序同 Python。 */
export function _status_hint(code: unknown): number | null {
  if (typeof code !== 'string') return null;
  const lowered = code.toLowerCase();
  if (
    ['invalid_request', 'invalid_parameter', 'invalid_params', 'context_length',
      'context_overflow', 'max_tokens', 'length', 'bad_request', 'request_error',
    ].some((marker) => lowered.includes(marker))
  ) {
    return 400;
  }
  if (['rate', 'quota', 'limit', 'throttl'].some((marker) => lowered.includes(marker))) {
    return 429;
  }
  if (lowered.includes('not_found') || (lowered.includes('not') && lowered.includes('exist'))) {
    return 404;
  }
  if (
    ['auth', 'api_key', 'apikey', 'key invalid', 'invalid key',
      'invalid_key', 'key_invalid'].some((marker) => lowered.includes(marker))
  ) {
    return 401;
  }
  if (['timeout', 'timed'].some((marker) => lowered.includes(marker))) {
    return 408;
  }
  return null;
}

/** 从错误响应体提取 error message（JSON 解析失败/无 error 段返回 None）。 */
export function error_detail_from_body(body: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  if (!is_dict(obj)) return null;
  const error = obj['error'];
  if (is_dict(error)) return get_str(error, 'message') ?? JSON.stringify(error);
  if (typeof error === 'string') return error;
  return null;
}

/** 解析一条 SSE data 帧（[DONE] 忽略；usage 帧/同帧 usage 合并；error 帧抛错）。 */
export function parse_sse_line(line: string): LLMChunk | null {
  const text = line.trim();
  if (!text.startsWith('data:')) return null;
  const data = text.slice('data:'.length).trim();
  if (!data || data === '[DONE]') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null; // 坏帧容错跳过，不中断整个流
  }
  if (!is_dict(obj)) return null;
  if ('error' in obj) {
    const error = obj['error'];
    const detail = is_dict(error) ? (get_str(error, 'message') ?? JSON.stringify(error)) : typeof error === 'string' ? error : String(error);
    const code = is_dict(error) ? error['code'] : null;
    throw classify_llm_error(_status_hint(code), detail);
  }
  const usage_raw = obj['usage'];
  const usage = as_json_object(usage_raw);
  const choices = obj['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    // 纯 usage 帧（include_usage 末帧）；无 usage 无 choices 属非法帧
    if (usage !== null) return new LLMChunk({ usage });
    throw new LLMFormatError('', `响应缺 choices: ${data.slice(0, 200)}`);
  }
  const chunk = chunk_from_choice(choices[0]);
  if (chunk === null || chunk.is_empty) {
    return usage !== null ? new LLMChunk({ usage }) : null;
  }
  if (usage !== null) {
    // 同帧携带 choices+usage：合并产出，不丢内容
    return new LLMChunk({
      token: chunk.token,
      reasoning_token: chunk.reasoning_token,
      tool_calls_delta: chunk.tool_calls_delta,
      finish_reason: chunk.finish_reason,
      usage,
    });
  }
  return chunk;
}

/** 把一个 SSE choice 帧解析为 LLMChunk（无信息内容返回 None 跳过）。 */
export function chunk_from_choice(choice_raw: unknown): LLMChunk | null {
  if (!is_dict(choice_raw)) return null;
  const delta = is_dict(choice_raw['delta']) ? (choice_raw['delta'] as Dict) : {};
  let reasoning: string | null = null;
  for (const key of _REASONING_FIELDS) {
    const value = get_str(delta, key);
    if (value !== null) {
      reasoning = value;
      break;
    }
  }
  const tool_calls = parse_delta_tool_calls(delta['tool_calls']);
  const finish = get_str(choice_raw, 'finish_reason');
  return new LLMChunk({
    token: get_str(delta, 'content') || null,
    reasoning_token: reasoning,
    tool_calls_delta: tool_calls,
    finish_reason: finish,
  });
}

function parse_delta_tool_calls(raw_calls: unknown): ToolCallDelta[] | null {
  if (!Array.isArray(raw_calls)) return null;
  const deltas: ToolCallDelta[] = [];
  for (const item of raw_calls) {
    if (!is_dict(item)) continue;
    const function_raw = item['function'];
    const fn = is_dict(function_raw) ? (function_raw as Dict) : null;
    deltas.push(
      new ToolCallDelta({
        index: typeof item['index'] === 'number' ? (item['index'] as number) : 0,
        id: get_str(item, 'id'),
        name: fn !== null ? get_str(fn, 'name') : null,
        arguments_delta: fn !== null ? get_str(fn, 'arguments') : null,
      }),
    );
  }
  return deltas.length > 0 ? deltas : null;
}

/** 非流式补全响应体解析（choices[0].message + usage），非法形态抛 LLMFormatError。 */
export function parse_chat_completion(text: string): {
  content: string;
  reasoning: string | null;
  tool_calls: ToolCall[] | null;
  finish_reason: string | null;
  usage: Record<string, Json> | null;
} {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (exc) {
    throw new LLMFormatError('', `非 JSON 响应: ${String(exc)}`);
  }
  if (!is_dict(obj)) throw new LLMFormatError('', '响应非对象');
  const choices = obj['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LLMFormatError('', `响应缺 choices: ${text.slice(0, 200)}`);
  }
  const choice = is_dict(choices[0]) ? (choices[0] as Dict) : {};
  const message_raw = choice['message'];
  if (!is_dict(message_raw)) throw new LLMFormatError('', 'choices[0].message 缺失');
  const message = message_raw as Dict;
  const content_value = message['content'];
  const content = typeof content_value === 'string' ? content_value : '';
  let reasoning: string | null = null;
  for (const key of _REASONING_FIELDS) {
    const value = get_str(message, key);
    if (value !== null) {
      reasoning = value;
      break;
    }
  }
  const tool_calls = parse_message_tool_calls(message['tool_calls']);
  const finish = get_str(choice, 'finish_reason');
  return {
    content,
    reasoning,
    tool_calls,
    finish_reason: finish,
    usage: as_json_object(obj['usage']),
  };
}

function parse_message_tool_calls(raw_calls: unknown): ToolCall[] | null {
  if (!Array.isArray(raw_calls)) return null;
  const calls: ToolCall[] = [];
  for (const item of raw_calls) {
    if (!is_dict(item)) continue;
    const function_raw = item['function'];
    if (!is_dict(function_raw)) continue;
    const fn = function_raw as Dict;
    calls.push(
      new ToolCall({
        id: typeof item['id'] === 'string' ? (item['id'] as string) : '',
        name: typeof fn['name'] === 'string' ? (fn['name'] as string) : '',
        arguments: typeof fn['arguments'] === 'string' ? (fn['arguments'] as string) : '',
      }),
    );
  }
  return calls.length > 0 ? calls : null;
}
