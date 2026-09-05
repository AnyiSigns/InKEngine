/**
 * OpenAI 兼容适配器（流式 SSE 解析自写，零第三方 SDK 依赖）——Python
 * core/llm/openai_compat.py 的 TS 移植。
 *
 * 覆盖 OpenAI/DeepSeek/Zhipu/Moonshot/Ollama 等全部 OpenAI 兼容端点
 * （含 DashScope compatible-mode 端点，改 base_url 即可用）；DeepSeek
 * 系模型的 reasoning_content 增量透传为 reasoning_token。
 *
 * 行为约定：
 * - 传输异常/HTTP 状态码统一经 classify_llm_error 分类抛 LLMError；
 * - 200 但零数据帧的空流抛 LLMEmptyStreamError（可重试瞬时故障）；
 * - 取消语义：消费方中断时，响应流在退出路径显式 close——上游请求终止，
 *   不悬挂连接；
 * - 坏 SSE 帧容错跳过（不中断整个流）；
 * - 重试唯一权威：默认单次尝试，瞬时故障重试归链级 RetryPolicy（ModelChain）；
 *   独立直用适配器可注入 retry 策略（构造参数）按需开重试。
 *
 * HTTP 经可注入传输缝（LLMTransport，本地类型）：测试注入假传输端；
 * 生产默认 = 全局 fetch（tsconfig 含 fetch 类型），见 ./transport.ts。
 */
import {
  AsyncLLM,
  LLMChunk,
  LLMConfig,
  LLMParams,
  LLMResult,
} from '../../core/llm/base.js';
import type { Message } from '../../core/llm/messages.js';
import type { ToolSpec } from '../../core/llm/tools.js';
import {
  LLMEmptyStreamError,
  LLMError,
  classify_llm_error,
  is_transient_llm_error,
} from '../../core/llm/errors.js';
import {
  build_payload,
  openai_chat_completions_endpoint,
  request_headers,
} from './compat_payload.js';
import { error_detail_from_body, parse_chat_completion, parse_sse_line } from './compat_parse.js';
import { RetryPolicy, retry_backoff } from './retry.js';
import {
  create_fetch_transport,
  type LLMTransport,
  type TransportResponse,
} from './transport.js';

export const DEFAULT_REQUEST_TIMEOUT = 120.0;

/** 幂等关闭响应（失败不抛——连接可能已被上游关闭）。 */
async function close_response(response: TransportResponse): Promise<void> {
  try {
    await response.close();
  } catch {
    // 幂等容错：关闭/取消失败不阻断主流程
  }
}

export class OpenAICompatibleLLM extends AsyncLLM {
  override readonly adapter = 'openai_compatible';

  private readonly _transport: LLMTransport | null;
  private _client: LLMTransport | null;
  private readonly _retry: RetryPolicy | null;

  constructor(
    config: LLMConfig,
    opts: { transport?: LLMTransport | null; retry?: RetryPolicy | null } = {},
  ) {
    super(config);
    this._transport = opts.transport ?? null;
    this._client = null;
    this._retry = opts.retry ?? null;
  }

  private get _endpoint(): string {
    return openai_chat_completions_endpoint(this.config.base_url);
  }

  private _get_client(): LLMTransport {
    // 惰性构建：注入传输优先；None = 生产默认 fetch 传输
    if (this._client === null) {
      this._client = this._transport ?? create_fetch_transport();
    }
    return this._client;
  }

  /** 释放当前传输（幂等；关闭后再调用会重建——生命周期由宿主管理）。 */
  override async aclose(): Promise<void> {
    const client = this._client;
    this._client = null;
    if (client !== null && typeof client.close === 'function') {
      try {
        await client.close();
      } catch {
        // 幂等容错：释放失败不阻断
      }
    }
  }

  private _headers(): Record<string, string> {
    return request_headers(this.config.api_key);
  }

  private _timeout_ms(): number {
    return (this.config.request_timeout ?? DEFAULT_REQUEST_TIMEOUT) * 1000;
  }

  private async _post(payload: Record<string, unknown>): Promise<TransportResponse> {
    const client = this._get_client();
    return client.request({
      url: this._endpoint,
      headers: this._headers(),
      body: JSON.stringify(payload),
      timeout_ms: this._timeout_ms(),
    });
  }

  /** 传输异常包装：非 LLMError 一律分类（失败安全：未知异常兜底包装）。 */
  private static _wrap_transport_error(exc: unknown): LLMError {
    if (exc instanceof LLMError) return exc;
    if (exc instanceof Error) return classify_llm_error(null, null, exc);
    return classify_llm_error(null, String(exc), null);
  }

  private async _raise_for_status(response: TransportResponse): Promise<void> {
    if (response.status < 400) return;
    let body = '';
    try {
      body = await response.text();
    } catch {
      // 读错误体失败不阻断：状态码本身足以分类
    }
    throw classify_llm_error(response.status, error_detail_from_body(body));
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
    const attempts = this._retry !== null ? this._retry.attempts : 1;
    let response: TransportResponse | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        response = await this._post(payload);
        await this._raise_for_status(response);
        break;
      } catch (exc) {
        const error = OpenAICompatibleLLM._wrap_transport_error(exc);
        if (is_transient_llm_error(error) && attempt + 1 < attempts && this._retry !== null) {
          await retry_backoff(this._retry, attempt);
          continue;
        }
        throw error;
      }
    }
    const parsed = parse_chat_completion(await (response as TransportResponse).text());
    return new LLMResult({
      content: parsed.content,
      reasoning: parsed.reasoning,
      tool_calls: parsed.tool_calls,
      finish_reason: parsed.finish_reason,
      usage: parsed.usage,
    });
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
    const attempts = this._retry !== null ? this._retry.attempts : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let emitted = false;
      try {
        const response = await this._post(payload);
        try {
          await this._raise_for_status(response);
          for await (const line of response.lines()) {
            const chunk = parse_sse_line(line);
            if (chunk === null) continue;
            emitted = true;
            yield chunk;
          }
          if (!emitted) {
            throw new LLMEmptyStreamError('', `${this._endpoint} 流为空`);
          }
        } finally {
          // 正常退出/异常/消费方取消均关闭上游连接
          await close_response(response);
        }
        return;
      } catch (exc) {
        const error = OpenAICompatibleLLM._wrap_transport_error(exc);
        if (emitted) {
          // 已产出内容后的中断：重试会重复已消费帧，直接上抛不重试
          throw error;
        }
        if (is_transient_llm_error(error) && attempt + 1 < attempts && this._retry !== null) {
          await retry_backoff(this._retry, attempt);
          continue;
        }
        throw error;
      }
    }
  }
}

/** openai_compat 兼容别名（协议注册名），与 Python 命名对齐。 */
export { OpenAICompatibleLLM as OpenAICompatLLM };
