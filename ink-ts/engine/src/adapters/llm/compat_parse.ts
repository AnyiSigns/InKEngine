/**
 * OpenAI 兼容响应解析（openai_compat.py 拆分：SSE 帧 + 非流式补全）。
 *
 * 覆盖：DeepSeek 系 reasoning_content/reasoning 增量透传为 reasoning_token、
 * 工具调用按 index 增量、usage 帧合并、[DONE]/坏帧容错跳过、error 帧按
 * 状态码提示分类抛 LLMError。SSE 帧解码/错误 detail/状态码提示等公共原语
 * 收敛于 sse_common.ts（三协议复用）；本模块只保留 compat 的事件分派与
 * choices 增量形态转换。解析层纯函数、零 IO（流式逐行喂入）。
 */
import { LLMChunk } from '../../kernel/llm/base.js';
import { ToolCall, ToolCallDelta, type Json } from '../../kernel/llm/messages.js';
import { LLMFormatError, classify_llm_error } from '../../kernel/llm/errors.js';
import {
  error_parts,
  get_str,
  is_record,
  sse_data_json,
  status_hint,
} from './sse_common.js';

/** 兼容端点常见但非标准的推理字段（DeepSeek/DashScope qwq 等）。 */
export const _REASONING_FIELDS = ['reasoning_content', 'reasoning'] as const;

type Dict = Record<string, unknown>;

function as_json_object(v: unknown): Record<string, Json> | null {
  return is_record(v) ? (v as Record<string, Json>) : null;
}

/** 从错误帧载荷抛分类异常（error message/detail 归一在 sse_common）。 */
function raise_frame_error(error: unknown): never {
  const parts = error_parts(error);
  throw classify_llm_error(status_hint(parts.code), parts.detail);
}

/** 解析一条 SSE data 帧（[DONE] 忽略；usage 帧/同帧 usage 合并；error 帧抛错）。 */
export function parse_sse_line(line: string): LLMChunk | null {
  const obj = sse_data_json(line);
  if (!is_record(obj)) return null;
  if ('error' in obj) {
    raise_frame_error(obj['error']);
  }
  const usage_raw = obj['usage'];
  const usage = as_json_object(usage_raw);
  const choices = obj['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    // 纯 usage 帧（include_usage 末帧）；无 usage 无 choices 属非法帧
    if (usage !== null) return new LLMChunk({ usage });
    throw new LLMFormatError('', `响应缺 choices: ${JSON.stringify(obj).slice(0, 200)}`);
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
  if (!is_record(choice_raw)) return null;
  const delta = is_record(choice_raw['delta']) ? (choice_raw['delta'] as Dict) : {};
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
    if (!is_record(item)) continue;
    const fn = is_record(item['function']) ? (item['function'] as Dict) : null;
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
  if (!is_record(obj)) throw new LLMFormatError('', '响应非对象');
  const choices = obj['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LLMFormatError('', `响应缺 choices: ${text.slice(0, 200)}`);
  }
  const choice = is_record(choices[0]) ? (choices[0] as Dict) : {};
  const message_raw = choice['message'];
  if (!is_record(message_raw)) throw new LLMFormatError('', 'choices[0].message 缺失');
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
    if (!is_record(item)) continue;
    if (!is_record(item['function'])) continue;
    const fn = item['function'] as Dict;
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
