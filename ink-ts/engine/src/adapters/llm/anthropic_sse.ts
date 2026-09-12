/**
 * Anthropic Messages SSE 事件流解析（anthropic.py 流式分帧语义 1:1 移植；
 * 模块 anthropic 专属命名防与 openai 拆分冲突）。
 *
 * 从单条 `data:` 帧解析为统一增量 LLMChunk，携带跨帧解析状态
 * （message_start 暂存输入用量，message_delta 合并输出用量/终止原因）。
 * SSE 帧解码/错误 detail/状态码提示收敛于 sse_common.ts（三协议复用，
 * anthropic 的 error type 枚举词已并入共享状态码词汇表）。
 *
 * 事件分类约定（与 python 对齐）：
 * - 坏 SSE 帧（非 JSON）容错跳过，不中断整个流；
 * - error 事件经 classify_llm_error 抛语义化 LLMError（type → 状态码提示）；
 * - message_start / content_block_stop / message_stop / ping → 无增量返回 null。
 */

import { classify_llm_error } from '../../model/llm/errors.js';
import { LLMChunk } from '../../dock/ports/llm.js';
import { ToolCallDelta } from '../../model/llm/messages.js';
import { error_parts, is_record, sse_data_json, status_hint } from './sse_common.js';

/** Anthropic stop_reason → 统一 finish_reason（不命中则原样透传）。 */
export const STOP_REASON_MAP: Readonly<Record<string, string>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
};

function as_record(value: unknown): Record<string, unknown> {
  return is_record(value) ? value : {};
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
    const obj = sse_data_json(line);
    if (!is_record(obj)) return null;
    const etype = obj['type'];
    if (etype === 'error') {
      const parts = error_parts(obj['error']);
      throw classify_llm_error(status_hint(parts.code), parts.detail);
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
