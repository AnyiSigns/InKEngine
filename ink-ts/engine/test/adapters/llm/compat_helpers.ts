/**
 * OpenAI 兼容适配器单测共享装置（Python test_llm_openai_compat.py 惯用法移植）：
 * 注入假传输端（fake transport）+ SSE 帧构造 + 请求快照。零真实网络。
 *
 * 命名带 compat_ 前缀：与同目录其他适配器（anthropic/openai_responses）的
 * helpers.ts 隔离，避免并行会话共享文件名互相覆盖。
 */
import { LLMConfig } from '../../../src/core/llm/base.js';
import type {
  LLMTransport,
  TransportRequest,
  TransportResponse,
} from '../../../src/adapters/llm/transport.js';
import { OpenAICompatibleLLM } from '../../../src/adapters/llm/openai_compat.js';
import { RetryPolicy } from '../../../src/adapters/llm/retry.js';

export type CompatHandler = (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;

export interface CompatSeen {
  calls: number;
  request: TransportRequest | null;
}

/** LLMConfig 构造参数形态（配置覆盖：temperature/max_tokens/extra 等）。 */
export type ConfigOverrides = {
  api_key?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
  request_timeout?: number | null;
  extra?: Record<string, unknown> | null;
};

/** 假传输端：捕获请求 + 计数 + 回放 handler 结果（镜像 httpx.MockTransport）。 */
export class FakeCompatTransport implements LLMTransport {
  readonly seen: CompatSeen = { calls: 0, request: null };
  private readonly _handler: CompatHandler;

  constructor(handler: CompatHandler) {
    this._handler = handler;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    this.seen.calls += 1;
    // 头键统一小写（HTTP 语义大小写不敏感；对齐 httpx headers 归一形态）
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = value;
    }
    this.seen.request = { ...req, headers };
    return this._handler(req);
  }
}

/** 假响应：body 整存；lines 按整帧产出（每条自带换行，模拟 SSE 帧）。 */
export class FakeLLMResponse implements TransportResponse {
  readonly status: number;
  readonly headers: Record<string, string>;

  private readonly _body: string;

  constructor(
    status: number,
    body: string,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ) {
    this.status = status;
    this._body = body;
    this.headers = headers;
  }

  async text(): Promise<string> {
    return this._body;
  }

  async *lines(): AsyncIterable<string> {
    const frames = this._body.split('\n\n');
    for (const frame of frames) {
      if (frame.length > 0) yield `${frame}\n`;
    }
  }

  async close(): Promise<void> {
    // 假响应无底层连接，close 空实现（幂等）
  }
}

export const JSON_HEADERS = { 'content-type': 'application/json' };

/** 单条 SSE data 帧文本（data: <json> + 空行，等价 Python sse_frame bytes）。 */
export function sse_frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** SSE delta 帧对象：{choices:[{index:0, delta, finish_reason?}]}。 */
export function sse_delta(
  delta: Record<string, unknown>,
  finish_reason: string | null = null,
): Record<string, unknown> {
  const choice: Record<string, unknown> = { index: 0, delta };
  if (finish_reason !== null) choice['finish_reason'] = finish_reason;
  return { choices: [choice] };
}

export function ok_json(payload: unknown): FakeLLMResponse {
  return new FakeLLMResponse(200, JSON.stringify(payload), JSON_HEADERS);
}

export function error_json(status: number, payload: unknown): FakeLLMResponse {
  return new FakeLLMResponse(status, JSON.stringify(payload), JSON_HEADERS);
}

/** 纯文本响应（非 JSON body / 非流式场景）。 */
export function text_response(status: number, body: string): FakeLLMResponse {
  return new FakeLLMResponse(status, body, { 'content-type': 'text/html' });
}

/** 模拟 SSE 流式响应（整帧序列，零帧 = 空流）。 */
export function stream_response(frames: string[]): FakeLLMResponse {
  return new FakeLLMResponse(200, frames.join(''), JSON_HEADERS);
}

/** 构造注入假传输端的 OpenAICompatibleLLM；seen 记录末次请求与调用次数。 */
export function make_adapter(
  handler: CompatHandler,
  overrides: ConfigOverrides = {},
  retry?: RetryPolicy | null,
): { llm: OpenAICompatibleLLM; seen: CompatSeen } {
  const transport = new FakeCompatTransport(handler);
  const config = new LLMConfig({
    adapter: 'openai_compat',
    model_id: 'test-model',
    base_url: 'https://example.com/v1/',
    api_key: 'sk-test',
    ...overrides,
  });
  return { llm: new OpenAICompatibleLLM(config, { transport, retry }), seen: transport.seen };
}

/** 读取 seen 记录到的请求 body（JSON）。 */
export function body_of(seen: CompatSeen): Record<string, unknown> {
  return JSON.parse(seen.request?.body ?? 'null') as Record<string, unknown>;
}

/** 捕获 promise 结果：成功返回 null，失败返回异常（断言分类/消息用）。 */
export async function capture<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (exc) {
    return exc;
  }
}
