/**
 * OpenAI 兼容适配器（流式 SSE 解析自写，零第三方 SDK 依赖）——Python
 * kernel/llm/openai_compat.py 的 TS 移植。
 *
 * 覆盖 OpenAI/DeepSeek/Zhipu/Moonshot/Ollama 等全部 OpenAI 兼容端点
 * （含 DashScope compatible-mode 端点，改 base_url 即可用）；DeepSeek
 * 系模型的 reasoning_content 增量透传为 reasoning_token。
 *
 * 行为约定：
 * - 传输异常/HTTP 状态码统一经 classify_llm_error 分类抛 LLMError；
 * - 200 但零数据帧的空流抛 LLMEmptyStreamError（可重试瞬时故障）；
 * - 取消语义：消费方中断时响应流在退出路径关闭上游——请求终止，
 *   不悬挂连接（aiter_lines finally cancel）；
 * - 坏 SSE 帧容错跳过（不中断整个流）；
 * - 重试唯一权威：默认单次尝试，瞬时故障重试归链级 RetryPolicy
 *   （ModelChain，kernel/llm/fallback）；独立直用适配器可注入 retry 策略
 *   （构造参数）按需开重试，退避/骨架共享见 ./retry_once.ts。
 *
 * HTTP 经可注入传输缝（LlmTransport，见 ./fetch_transport.ts）：测试注入
 * 假传输端；生产默认 = 全局 fetch（tsconfig 含 fetch 类型）。
 */
import {
  AsyncLLM,
  LLMChunk,
  LLMConfig,
  LLMParams,
  LLMResult,
} from '../../dock/ports/llm.js';
import type { Message } from '../../model/llm/messages.js';
import type { ToolSpec } from '../../model/llm/tools.js';
import { LLMEmptyStreamError } from '../../model/llm/errors.js';
import { RetryPolicy } from '../../loop/llm/fallback.js';
import {
  build_payload,
  openai_chat_completions_endpoint,
  request_headers,
} from './compat_payload.js';
import { parse_chat_completion, parse_sse_line } from './compat_parse.js';
import { DEFAULT_REQUEST_TIMEOUT_SECONDS, raise_for_status, request_timeout_ms } from './sse_common.js';
import { with_retry, with_stream_retry, to_llm_error, type Sleeper } from './retry_once.js';
import {
  fetch_transport,
  type LlmResponse,
  type LlmTransport,
} from './fetch_transport.js';

/** 请求默认超时（秒；共享常量再导出保历史调用面，见 sse_common）。 */
export const DEFAULT_REQUEST_TIMEOUT = DEFAULT_REQUEST_TIMEOUT_SECONDS;

export class OpenAICompatibleLLM extends AsyncLLM {
  override readonly adapter = 'openai_compatible';

  private readonly _transport: LlmTransport | null;
  private _default_transport: LlmTransport | null = null;
  private readonly _retry: RetryPolicy | null;
  private readonly _sleep: Sleeper | null;

  constructor(
    config: LLMConfig,
    opts: {
      transport?: LlmTransport | null;
      retry?: RetryPolicy | null;
      sleep?: Sleeper | null;
    } = {},
  ) {
    super(config);
    this._transport = opts.transport ?? null;
    this._retry = opts.retry ?? null;
    this._sleep = opts.sleep ?? null;
  }

  private get _endpoint(): string {
    return openai_chat_completions_endpoint(this.config.base_url);
  }

  private _get_client(): LlmTransport {
    // 惰性构建：注入传输优先；None = 生产默认 fetch 传输
    if (this._transport !== null) return this._transport;
    if (this._default_transport === null) {
      this._default_transport = fetch_transport();
    }
    return this._default_transport;
  }

  /** 释放默认传输（幂等；关闭后再调用会重建——生命周期由宿主管理）。 */
  override async aclose(): Promise<void> {
    this._default_transport = null;
  }

  private _headers(): Record<string, string> {
    return request_headers(this.config.api_key);
  }

  private _timeout_ms(): number {
    return request_timeout_ms(this.config.request_timeout);
  }

  private async _post(payload: Record<string, unknown>): Promise<LlmResponse> {
    return this._get_client().post(this._endpoint, {
      headers: this._headers(),
      json: payload,
      timeout_ms: this._timeout_ms(),
    });
  }

  // ------------------------------------------------------------------
  // AsyncLLM 接口
  // ------------------------------------------------------------------
  override async ainvoke(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): Promise<LLMResult> {
    const { tools = null, params = null } = opts;
    const payload = build_payload(this.config, messages, tools, params, false);
    return await with_retry(
      this._retry,
      async () => {
        try {
          const response = await this._post(payload);
          await raise_for_status(response);
          const parsed = parse_chat_completion(await response.body_text());
          return new LLMResult({
            content: parsed.content,
            reasoning: parsed.reasoning,
            tool_calls: parsed.tool_calls,
            finish_reason: parsed.finish_reason,
            usage: parsed.usage,
          });
        } catch (exc) {
          throw to_llm_error(exc);
        }
      },
      { sleep: this._sleep ?? undefined },
    );
  }

  override async *astream(
    messages: readonly Message[],
    opts: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null } = {},
  ): AsyncGenerator<LLMChunk> {
    const { tools = null, params = null } = opts;
    const payload = build_payload(this.config, messages, tools, params, true);
    // 流式用量计量：默认请求 include_usage；extra_body 显式声明则尊重调用方
    if (payload['stream_options'] === undefined) {
      payload['stream_options'] = { include_usage: true };
    }
    yield* with_stream_retry(
      this._retry,
      () => this._stream_once(payload),
      { sleep: this._sleep ?? undefined },
    );
  }

  private async *_stream_once(payload: Record<string, unknown>): AsyncGenerator<LLMChunk> {
    let produced = false;
    try {
      const response = await this._post(payload);
      try {
        await raise_for_status(response);
        for await (const line of response.aiter_lines()) {
          const chunk = parse_sse_line(line);
          if (chunk === null) continue;
          produced = true;
          yield chunk;
        }
        // 整流零产出（无 data 帧 / 全注释帧）才算空流：已产内容正常收尾
        if (!produced) throw new LLMEmptyStreamError('', `${this._endpoint} 流为空`);
      } finally {
        // 正常退出/异常/消费方取消均由 aiter_lines 退出路径关闭上游连接
      }
    } catch (exc) {
      throw to_llm_error(exc);
    }
  }
}

/** Python 命名对齐别名（openai_compat.py 的类名 OpenAICompatLLM）；registry
 *  引用 OpenAICompatibleLLM，此别名供直接 import 该模块的历史调用方使用。 */
export { OpenAICompatibleLLM as OpenAICompatLLM };
