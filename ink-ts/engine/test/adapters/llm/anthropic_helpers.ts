/**
 * Anthropic 适配器单测共享装置（Python test_llm_adapters.py 惯用法移植）：
 * fake 传输注入（post seam）+ SSE 帧构造 + 请求快照。零真实网络。
 */

import { AnthropicLLM } from '../../../src/adapters/llm/anthropic.js';
import { RetryPolicy } from '../../../src/adapters/llm/retry.js';
import { LLMConfig } from '../../../src/core/llm/base.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';
import type {
  LlmPostRequest,
  LlmResponse,
  LlmTransport,
} from '../../../src/adapters/llm/anthropic_transport.js';

export type AnthropicHandler = (req: LlmPostRequest) => LlmResponse;

export interface AnthropicSeen {
  calls: number;
  url: string | null;
  request: LlmPostRequest | null;
}

/** LLMConfig 构造参数形态（避免 import 未导出的构造 init 类型）。 */
export type ConfigOverrides = {
  adapter?: string;
  base_url?: string;
  model_id?: string;
  api_key?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
  request_timeout?: number | null;
  extra?: Record<string, unknown> | null;
};

/** fake 传输响应（body 整存，aiter_lines 按 \n 切分模拟 httpx aiter_lines）。 */
export class FakeLlmResponse implements LlmResponse {
  readonly status: number;
  private readonly _body: string;

  constructor(status: number, body: string) {
    this.status = status;
    this._body = body;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this._body);
  }

  async body_text(): Promise<string> {
    return this._body;
  }

  async *aiter_lines(): AsyncIterable<string> {
    for (const line of this._body.split('\n')) {
      yield line;
    }
  }
}

export const JSON_HEADERS = { 'content-type': 'application/json' };

/** 单条 SSE data 帧文本。 */
export function sse_frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export const DONE_FRAME = 'data: [DONE]\n\n';
export const PING_FRAME = ': ping\n\n';

export function ok_json(payload: unknown): FakeLlmResponse {
  return new FakeLlmResponse(200, JSON.stringify(payload));
}

export function error_json(status: number, payload: unknown): FakeLlmResponse {
  return new FakeLlmResponse(status, JSON.stringify(payload));
}

export function stream_response(frames: string[]): FakeLlmResponse {
  return new FakeLlmResponse(200, frames.join(''));
}

/** 构造注入 fake transport 的 AnthropicLLM；seen 记录末次请求与调用次数。 */
export function make_anthropic(
  handler: AnthropicHandler,
  overrides: ConfigOverrides = {},
  retry?: RetryPolicy | null,
): { llm: AnthropicLLM; seen: AnthropicSeen } {
  const seen: AnthropicSeen = { calls: 0, url: null, request: null };
  const transport: LlmTransport = {
    async post(url: string, req: LlmPostRequest): Promise<LlmResponse> {
      seen.calls += 1;
      seen.url = url;
      seen.request = req;
      return handler(req);
    },
  };
  const config = new LLMConfig({
    adapter: 'stub',
    model_id: 'test-model',
    base_url: 'https://example.com/v1',
    api_key: 'sk-test',
    ...overrides,
  });
  return { llm: new AnthropicLLM(config, { transport, retry }), seen };
}

/** 读取 seen 记录到的请求 body（json）。 */
export function body_of(seen: AnthropicSeen): Record<string, unknown> {
  return (seen.request?.json ?? {}) as Record<string, unknown>;
}

export const WEATHER_TOOL = new ToolSpec({
  name: 'get_weather',
  description: '查询天气',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
});
