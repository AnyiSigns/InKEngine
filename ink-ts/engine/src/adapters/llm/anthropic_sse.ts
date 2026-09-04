/**
 * Anthropic Messages SSE 事件流解析（anthropic.py 流式分帧语义 1:1 移植；
 * 模块 anthropic 专属命名防与 openai 拆分冲突）。
 *
 * 从单条 `data:` 帧解析为统一增量 LLMChunk，携带跨帧解析状态
 * （message_start 暂存输入用量，message_delta 合并输出用量/终止原因）。
 *
 * 事件分类约定（与 python 对齐）：
 * - 坏 SSE 帧（非 JSON）容错跳过，不中断整个流；
 * - error 事件经 classify_llm_error 抛语义化 LLMError（type → 状态码提示）；
 * - message_start / content_block_stop / message_stop / ping → 无增量返回 null。
 */

import { classify_llm_error } from '../../core/llm/errors.js';
import { LLMChunk } from '../../core/llm/base.js';
import { ToolCallDelta } from '../../core/llm/_shapes.js';

/** Anthropic stop_reason → 统一 finish_reason（不命中则原样透传）。 */
export const STOP_REASON_MAP: Readonly<Record<string, string>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
};

/** Anthropic 上游错误 type → HTTP 状态码（分类提示，无则 null）。 */
export const ERROR_TYPE_STATUS: Readonly<Record<string, number>> = {
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  rate_limit_error: 429,
  invalid_request_error: 400,
  request_too_large: 400,
  api_error: 500,
  overloaded_error: 503,
  service_unavailable: 503,
  timeout: 408,
};

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function as_record(value: unknown): Record<string, unknown> {
  return is_record(value) ? value : {};
}

/** 从 Anthropic 错误 type 猜测 HTTP 状态码（分类提示；非串返回 null）。 */
export function error_status_hint(code: unknown): number | null {
  if (typeof code !== 'string') return null;
  const status = ERROR_TYPE_STATUS[code];
  return status === undefined ? null : status;
}

/**
 * 跨帧流解析状态：message_start 的输入用量暂存至此，
 * 供 message_delta 合并出 {prompt_tokens, completion_tokens}。
 */
export class AnthropicStreamParser {
  private _prompt_tokens: number | null = null;

  /** 重置跨帧状态（每次流式请求/重试前调用）。 */
  reset(): void {
    this._prompt_tokens = null;
  }

  /** 解析单条 SSE data 帧为 LLMChunk（坏帧/null 事件返回 null）。 */
  parse_sse_line(line: string): LLMChunk | null {
    const text = line.trim();
    if (!text.startsWith('data:')) return null;
    const data = text.slice('data:'.length).trim();
    if (!data || data === '[DONE]') return null;
    let obj: unknown;
    try {
      obj = JSON.parse(data);
    } catch {
      return null;
    }
    if (!is_record(obj)) return null;
    const etype = obj['type'];
    if (etype === 'error') {
      const errRaw = obj['error'];
      const err = is_record(errRaw) ? errRaw : null;
      const message =
        err !== null && typeof err['message'] === 'string'
          ? err['message']
          : typeof errRaw === 'string'
            ? errRaw
            : null;
      const code = err !== null ? err['type'] : null;
      throw classify_llm_error(error_status_hint(code), message);
    }
    if (etype === 'message_start') {
      const msg = as_record(obj['message']);
      const usage = as_record(msg['usage']);
      if (typeof usage['input_tokens'] === 'number') {
        this._prompt_tokens = usage['input_tokens'];
      }
      return null;
    }
    if (etype === 'content_block_start') {
      const block = as_record(obj['content_block']);
      if (block['type'] === 'tool_use') {
        const index = typeof obj['index'] === 'number' ? obj['index'] : 0;
        return new LLMChunk({
          tool_calls_delta: [
            new ToolCallDelta({
              index,
              id: typeof block['id'] === 'string' ? block['id'] : null,
              name: typeof block['name'] === 'string' ? block['name'] : null,
            }),
          ],
        });
      }
      return null;
    }
    if (etype === 'content_block_delta') {
      const delta = as_record(obj['delta']);
      const dtype = delta['type'];
      const index = typeof obj['index'] === 'number' ? obj['index'] : 0;
      if (dtype === 'text_delta') {
        const token = typeof delta['text'] === 'string' ? delta['text'] : null;
        return new LLMChunk({ token: token || null });
      }
      if (dtype === 'input_json_delta') {
        const partial = typeof delta['partial_json'] === 'string' ? delta['partial_json'] : null;
        return new LLMChunk({
          tool_calls_delta: [new ToolCallDelta({ index, arguments_delta: partial })],
        });
      }
      return null;
    }
    if (etype === 'message_delta') {
      const md = as_record(obj['delta']);
      const stop = md['stop_reason'];
      const finish = typeof stop === 'string' ? (STOP_REASON_MAP[stop] ?? stop) : null;
      const rawUsage = obj['usage'];
      const u = as_record(rawUsage);
      const hasUsage = is_record(rawUsage) || this._prompt_tokens !== null;
      let prompt_tokens: number | null = null;
      if (this._prompt_tokens !== null) {
        prompt_tokens = this._prompt_tokens;
      } else if (typeof u['input_tokens'] === 'number') {
        prompt_tokens = u['input_tokens'];
      }
      const completion_tokens = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : null;
      const usageOut = hasUsage ? { prompt_tokens, completion_tokens } : null;
      if (finish === null && usageOut === null) return null;
      return new LLMChunk({ finish_reason: finish, usage: usageOut });
    }
    // message_start 输入暂存已处理；其余（ping/content_block_stop/message_stop）无增量
    return null;
  }
}
