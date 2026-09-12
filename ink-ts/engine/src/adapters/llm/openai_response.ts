/**
 * OpenAI Responses API 适配器（/responses 端点，SSE 事件自写解析）。
 *
 * 覆盖 OpenAI 新一代 Responses 协议（与 chat/completions 的 openai_compat
 * 并列的常见 API 协议）：请求体以 ``input`` 数组承载消息（含 function_call /
 * function_call_output 工具回环项）、tools 用 {type: "function"} 声明、流式
 * 事件按 type 分发（response.output_text.delta 文本增量 /
 * response.output_item.done 工具调用定型 / response.completed 终态 /
 * response.usage 用量帧）。解析与请求转换逻辑拆入 _responses_parse.ts /
 * _responses_payload.ts（单文件 ≤350 行纪律）；本文件聚焦 AsyncLLM 装配、
 * 重试与传输接线（./fetch_transport.ts 三协议共享 seam）。
 *
 * 行为约定（与 openai_compat / anthropic 对齐）：
 * - 传输异常/HTTP 状态码统一经 classify_llm_error 分类抛 LLMError；
 * - 200 但零内容帧的空流抛 LLMEmptyStreamError（可重试瞬时故障）；
 * - 取消语义：消费方中断时响应流在退出路径关闭上游（aiter_lines finally
 *   cancel）；已产出内容后的失败不重试（重试会重复已消费帧）。
 * - 重试唯一权威：默认单次尝试，瞬时故障重试归链级 RetryPolicy
 *   （ModelChain，kernel/llm/fallback）；独立直用可注入策略，骨架见
 *   ./retry_once.ts。
 */

import { AsyncLLM, REASONING_EFFORTS } from '../../kernel/llm/base.js';
import type { LLMChunk, LLMConfig, LLMParams, LLMResult } from '../../kernel/llm/base.js';
import {
  LLMEmptyStreamError,
  LLMFormatError,
} from '../../kernel/llm/errors.js';
import { RetryPolicy } from '../../kernel/llm/fallback.js';
import type { Message } from '../../kernel/llm/messages.js';
import type { ToolSpec } from '../../kernel/llm/tools.js';

import { RESPONSES_CORE_PAYLOAD_KEYS, response_tools, to_input_items } from './_responses_payload.js';
import { assert_images_supported } from './image_gate.js';
import {
  _parse_sse_line,
  new_responses_state,
  parse_response_body,
} from './_responses_parse.js';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS, raise_for_status, request_timeout_ms } from './sse_common.js';
import { to_llm_error, with_retry, with_stream_retry, type Sleeper } from './retry_once.js';
import {
  fetch_transport,
  type LlmPostRequest,
  type LlmTransport,
} from './fetch_transport.js';

/** 请求默认超时（秒；共享常量再导出保历史调用面，见 sse_common）。 */
export const DEFAULT_REQUEST_TIMEOUT = DEFAULT_REQUEST_TIMEOUT_SECONDS;

/** OpenAI Responses API 适配器（chat 补全新协议，流式/非流式）。 */
export class OpenAIResponsesLLM extends AsyncLLM {
  readonly adapter = 'openai_responses';

  private readonly _transport: LlmTransport | null;
  private readonly _retry: RetryPolicy | null;
  private readonly _sleep: Sleeper | null;
  private _default_transport: LlmTransport | null = null;

  constructor(
    config: LLMConfig,
    options: {
      transport?: LlmTransport | null;
      retry?: RetryPolicy | null;
      sleep?: Sleeper | null;
    } = {},
  ) {
    super(config);
    this._transport = options.transport ?? null; // 测试注入；null = 生产默认 fetch
    this._retry = options.retry ?? null;
    this._sleep = options.sleep ?? null;
  }

  // ------------------------------------------------------------------
  // 请求装配
  // ------------------------------------------------------------------
  private get _endpoint(): string {
    return this.config.base_url.replace(/\/+$/, '') + '/responses';
  }

  private _headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.api_key) headers['Authorization'] = `Bearer ${this.config.api_key}`;
    return headers;
  }

  private _request(json: unknown): LlmPostRequest {
    return {
      headers: this._headers(),
      json,
      timeout_ms: request_timeout_ms(this.config.request_timeout),
    };
  }

  private _get_transport(): LlmTransport {
    if (this._transport !== null) return this._transport;
    if (this._default_transport === null) {
      this._default_transport = fetch_transport(); // 惰性长生命周期（无显式关闭资源）
    }
    return this._default_transport;
  }

  private _payload(
    messages: readonly Message[],
    tools: readonly ToolSpec[] | null,
    params: LLMParams | null,
    stream: boolean,
  ): Record<string, unknown> {
    // 多模态图像门禁（fail-closed）：档案未声明图像输入的模型携图即显式拒绝
    assert_images_supported(this.config, messages);
    const payload: Record<string, unknown> = {
      model: this.config.model_id,
      input: to_input_items(messages),
      stream,
    };
    if (tools && tools.length > 0) {
      payload['tools'] = response_tools(tools);
    }
    const temperature =
      params && params.temperature !== null ? params.temperature : this.config.temperature;
    if (temperature !== null) payload['temperature'] = temperature;
    const max_tokens =
      params && params.max_tokens !== null ? params.max_tokens : this.config.max_tokens;
    if (max_tokens !== null) payload['max_output_tokens'] = max_tokens;
    if (params && params.extra_body) {
      for (const [key, value] of Object.entries(params.extra_body)) {
        if (!RESPONSES_CORE_PAYLOAD_KEYS.includes(key)) payload[key] = value; // 核心键防覆盖
      }
    }
    // 推理链开关 / 推理档位：Responses 协议经 reasoning.effort 群体现。
    // 显式档位优先于 enable_thinking 布尔；off → 不携带（模型默认路径）。
    if (params && params.reasoning_effort !== null) {
      const effort = params.reasoning_effort;
      if ((REASONING_EFFORTS as readonly string[]).includes(effort) && effort !== 'off') {
        payload['reasoning'] = { effort };
      }
    } else if (params && params.enable_thinking === true) {
      payload['reasoning'] = { effort: 'medium' };
    }
    return payload;
  }

  // ------------------------------------------------------------------
  // AsyncLLM 接口
  // ------------------------------------------------------------------
  async ainvoke(
    messages: readonly Message[],
    options: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): Promise<LLMResult> {
    const { tools = null, params = null } = options;
    const transport = this._get_transport();
    return await with_retry(
      this._retry,
      async () => {
        const request = this._request(this._payload(messages, tools, params, false));
        try {
          const response = await transport.post(this._endpoint, request);
          await raise_for_status(response);
          let obj: unknown;
          try {
            obj = await response.json();
          } catch (exc) {
            const msg = exc instanceof Error ? exc.message : String(exc);
            throw new LLMFormatError('', `非 JSON 响应: ${msg}`);
          }
          return parse_response_body(obj);
        } catch (exc) {
          throw to_llm_error(exc);
        }
      },
      { sleep: this._sleep ?? undefined },
    );
  }

  async *astream(
    messages: readonly Message[],
    options: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): AsyncGenerator<LLMChunk> {
    const { tools = null, params = null } = options;
    yield* with_stream_retry(
      this._retry,
      () => this._stream_once(messages, tools, params),
      { sleep: this._sleep ?? undefined },
    );
  }

  private async *_stream_once(
    messages: readonly Message[],
    tools: readonly ToolSpec[] | null,
    params: LLMParams | null,
  ): AsyncGenerator<LLMChunk> {
    const transport = this._get_transport();
    const request = this._request(this._payload(messages, tools, params, true));
    let produced = false;
    try {
      const response = await transport.post(this._endpoint, request);
      try {
        await raise_for_status(response);
        // 单流内 function_call 按完成事件次序自增 index（跨调用独立成桶）
        const tool_index = new_responses_state();
        for await (const line of response.aiter_lines()) {
          const chunk = _parse_sse_line(line, tool_index);
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
