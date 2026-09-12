/**
 * Anthropic Messages API 适配器（streaming SSE 自解析，零第三方 SDK）。
 *
 * Python `kernel/llm/anthropic.py` 移植（1:1 语义）。实现 AsyncLLM 契约：
 * astream 分帧、tool schema passthrough（Anthropic tool_use 块表达）、错误经
 * classify_llm_error 分类、厂商缓存参数（cache_control）、extended thinking
 * 档位映射。协议全名 anthropic_messages（anthropic 为兼容别名）。
 *
 * 行为约定（与 openai_compat 对齐）：
 * - 传输异常/HTTP 状态码统一经 classify_llm_error 分类抛 LLMError；
 * - 200 但零数据帧的空流抛 LLMEmptyStreamError（可重试瞬时故障）；
 * - 取消语义：消费方提前退出时 aiter_lines() 生成器 finally 显式 cancel
 *   reader，不悬挂连接（fetch 传输实现自带）；
 * - 坏 SSE 帧容错跳过（不中断整个流）。
 *
 * 重试纪律与 openai_compat/openai_responses 对齐：适配器默认单次尝试——
 * 瞬时故障（429/5xx/超时/网络/空流等）重试归链层 RetryPolicy；独立直用
 * 场景经构造参数注入 RetryPolicy（指数退避，计时经注入 sleeper 假时钟）
 * 显式开重试，骨架见 ./retry_once.ts（三适配器共享）。
 */

import {
  AsyncLLM,
  LLMChunk,
  LLMConfig,
  LLMResult,
  type LLMParams,
} from '../../dock/ports/llm.js';
import {
  LLMEmptyStreamError,
  LLMFormatError,
} from '../../model/llm/errors.js';
import { RetryPolicy } from '../../loop/llm/fallback.js';
import { Message, ToolCall, type Json } from '../../model/llm/messages.js';
import type { ToolSpec } from '../../model/llm/tools.js';
import { build_anthropic_payload } from './anthropic_payload.js';
import { AnthropicStreamParser, STOP_REASON_MAP } from './anthropic_sse.js';
import { raise_for_status, request_timeout_ms } from './sse_common.js';
import { to_llm_error, with_retry, with_stream_retry, type Sleeper } from './retry_once.js';
import { fetch_transport, type LlmTransport } from './fetch_transport.js';

const _ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicLLM extends AsyncLLM {
  readonly adapter = 'anthropic_messages';

  private readonly _transport: LlmTransport;
  private readonly _retry: RetryPolicy | null;
  private readonly _sleep: Sleeper | null;

  constructor(
    config: LLMConfig,
    options: {
      transport?: LlmTransport | null;
      retry?: RetryPolicy | null;
      sleep?: Sleeper | null;
    } = {},
  ) {
    super(config);
    // 测试注入 fake 传输；缺省全局 fetch 传输（openai 适配器共用同一 seam）。
    // 重试默认单次（null=关闭）；独立直用可注入 RetryPolicy（与 openai_compat
    // 同形态），瞬时故障重试归链层/显式注入策略，杜绝「适配器 × 链」叠加。
    this._transport = options.transport ?? fetch_transport();
    this._retry = options.retry ?? null;
    this._sleep = options.sleep ?? null;
  }

  // ------------------------------------------------------------------
  // 请求构造
  // ------------------------------------------------------------------
  get _endpoint(): string {
    return this.config.base_url.replace(/\/+$/, '') + '/messages';
  }

  _headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': _ANTHROPIC_VERSION,
    };
    if (this.config.api_key) headers['x-api-key'] = this.config.api_key;
    return headers;
  }

  _timeout_ms(): number {
    return request_timeout_ms(this.config.request_timeout);
  }

  // ------------------------------------------------------------------
  // 响应解析
  // ------------------------------------------------------------------

  /** 非流式响应 → LLMResult（content 块拼串、tool_use 块收集、usage 归一）。 */
  _parse_response(text: string): LLMResult {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch (exc) {
      throw new LLMFormatError('', `非 JSON 响应: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new LLMFormatError('', '响应非对象');
    }
    const content = (obj as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) {
      throw new LLMFormatError('', `响应缺 content: ${String(obj).slice(0, 200)}`);
    }
    const textParts: string[] = [];
    const calls: ToolCall[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null || Array.isArray(block)) continue;
      const rec = block as Record<string, unknown>;
      const btype = rec['type'];
      if (btype === 'text') {
        textParts.push(typeof rec['text'] === 'string' ? rec['text'] : '');
      } else if (btype === 'tool_use') {
        calls.push(
          new ToolCall({
            id: String(rec['id'] ?? ''),
            name: String(rec['name'] ?? ''),
            arguments: JSON.stringify(rec['input'] ?? {}),
          }),
        );
      }
    }
    const stop = (obj as Record<string, unknown>)['stop_reason'];
    const finish = typeof stop === 'string' ? (STOP_REASON_MAP[stop] ?? stop) : null;
    const usage = (obj as Record<string, unknown>)['usage'];
    let usageOut: Record<string, Json> | null = null;
    if (typeof usage === 'object' && usage !== null && !Array.isArray(usage)) {
      const u = usage as Record<string, unknown>;
      usageOut = {
        prompt_tokens: (u['input_tokens'] as Json | null | undefined) ?? null,
        completion_tokens: (u['output_tokens'] as Json | null | undefined) ?? null,
      };
    }
    return new LLMResult({
      content: textParts.join(''),
      tool_calls: calls.length > 0 ? calls : null,
      finish_reason: finish,
      usage: usageOut,
    });
  }

  // ------------------------------------------------------------------
  // AsyncLLM 接口
  // ------------------------------------------------------------------
  async ainvoke(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): Promise<LLMResult> {
    return await with_retry(
      this._retry,
      async () => {
        const payload = build_anthropic_payload(
          this.config,
          messages,
          opts.tools ?? null,
          opts.params ?? null,
          false,
        );
        try {
          const response = await this._transport.post(this._endpoint, {
            headers: this._headers(),
            json: payload,
            timeout_ms: this._timeout_ms(),
          });
          await raise_for_status(response);
          const body = await response.body_text();
          return this._parse_response(body);
        } catch (exc) {
          throw to_llm_error(exc);
        }
      },
      { sleep: this._sleep ?? undefined },
    );
  }

  async *astream(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): AsyncIterable<LLMChunk> {
    yield* with_stream_retry(
      this._retry,
      () => this._stream_once(messages, opts.tools ?? null, opts.params ?? null),
      { sleep: this._sleep ?? undefined },
    );
  }

  private async *_stream_once(
    messages: readonly Message[],
    tools: readonly ToolSpec[] | null,
    params: LLMParams | null,
  ): AsyncGenerator<LLMChunk> {
    const payload = build_anthropic_payload(this.config, messages, tools, params, true);
    const parser = new AnthropicStreamParser();
    let produced = false;
    try {
      const response = await this._transport.post(this._endpoint, {
        headers: this._headers(),
        json: payload,
        timeout_ms: this._timeout_ms(),
      });
      try {
        await raise_for_status(response);
        for await (const line of response.aiter_lines()) {
          const chunk = parser.parse_sse_line(line);
          if (chunk === null) continue;
          produced = true;
          yield chunk;
        }
        // 整流零产出（无 data 帧）才算空流：已产内容正常收尾
        if (!produced) throw new LLMEmptyStreamError('', `${this._endpoint} 流为空`);
      } finally {
        // 正常退出/异常/消费方取消均由 aiter_lines 退出路径关闭上游连接
      }
    } catch (exc) {
      throw to_llm_error(exc);
    }
  }
}
