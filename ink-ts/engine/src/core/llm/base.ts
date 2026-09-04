/**
 * 统一 LLM 接口（AsyncLLM）与数据模型（Python llm/base.py 移植，1:1）。
 *
 * 接口形态：AsyncLLM.astream(messages, tools?, params?) → AsyncIterable<LLMChunk>。
 * LLMChunk 增量语义（{token?, tool_calls_delta?, reasoning_token?} + finish_reason/
 * usage——增量演进加字段不破坏）；ainvoke 为非流式补全（压缩/审计/任意非流式
 * 路径）。厂商差异全部收敛到 adapters 层适配器内部（流式 SSE 解析、工具增量、
 * reasoning 透传），上层只消费统一增量模型。
 *
 * core 纯契约：本文件零 IO、零依赖，仅承载配置/参数/增量数据形态与累积函数；
 * 适配器（engine/src/adapters/llm/*）实现 AsyncLLM 并注册，装配方按配置注入。
 */

import { LLMConfigError } from './errors.js';
import type { Json } from './_shapes.js';
import type { ToolCall, ToolCallDelta } from './_shapes.js';
import { accumulate_tool_calls } from './messages.js';
import type { Message } from './messages.js';
import type { ToolSpec } from './tools.js';

/** from_dict 白名单键（模型配置形态）；未知键收进 extra 透传不破坏。 */
const _CONFIG_KEYS = [
  'adapter',
  'base_url',
  'api_key',
  'model_id',
  'temperature',
  'max_tokens',
  'request_timeout',
] as const;

/** 推理档位取值（None = 不注入，跟随模型/厂商默认；off/low/medium/high =
 *  显式档）。适配器按 LLMConfig.extra.reasoning_style 决定协议映射：
 *  effort → reasoning_effort / reasoning.effort（OpenAI 标准族）
 *  boolean → enable_thinking 开关（通义 qwen3 等）
 *  budget → thinking budget（Anthropic/Gemini）
 *  none → 无开关（如 deepseek reasoner，固定推理，档位不注入） */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const;

/** 单个模型接入配置（主模型与备用模型共用同一形态）。api_key/extra 不入
 *  repr/序列化——凭据明文不得进日志与异常消息。 */
export class LLMConfig {
  readonly adapter: string;
  readonly model_id: string;
  readonly base_url: string;
  readonly api_key: string | null;
  readonly temperature: number | null;
  readonly max_tokens: number | null;
  readonly request_timeout: number | null;
  readonly extra: Record<string, unknown> | null;

  constructor(init: {
    adapter: string;
    model_id: string;
    base_url: string;
    api_key?: string | null;
    temperature?: number | null;
    max_tokens?: number | null;
    request_timeout?: number | null;
    extra?: Record<string, unknown> | null;
  }) {
    this.adapter = init.adapter;
    this.model_id = init.model_id;
    this.base_url = init.base_url;
    this.api_key = init.api_key ?? null;
    this.temperature = init.temperature ?? null;
    this.max_tokens = init.max_tokens ?? null;
    this.request_timeout = init.request_timeout ?? null;
    this.extra = init.extra ?? null;
    const scheme = this.base_url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1] ?? '';
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(
        `LLMConfig.base_url 必须使用 http/https 协议（非法 scheme=${JSON.stringify(scheme)}）`,
      );
    }
    Object.freeze(this);
  }

  /** 从配置字典构建（模型配置形态兼容，未知键收进 extra）。 */
  static from_dict(data: Record<string, unknown>): LLMConfig {
    for (const key of ['adapter', 'model_id', 'base_url'] as const) {
      if (!data[key]) {
        throw new LLMConfigError(`LLM 配置缺少必填字段: ${key}`);
      }
    }
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!(_CONFIG_KEYS as readonly string[]).includes(key)) {
        extra[key] = value;
      }
    }
    return new LLMConfig({
      adapter: String(data['adapter']),
      model_id: String(data['model_id']),
      base_url: String(data['base_url']),
      api_key: data['api_key'] === undefined || data['api_key'] === null ? null : String(data['api_key']),
      temperature: data['temperature'] === undefined || data['temperature'] === null ? null : Number(data['temperature']),
      max_tokens: data['max_tokens'] === undefined || data['max_tokens'] === null ? null : Number(data['max_tokens']),
      request_timeout:
        data['request_timeout'] === undefined || data['request_timeout'] === null
          ? null
          : Number(data['request_timeout']),
      extra: Object.keys(extra).length > 0 ? extra : null,
    });
  }
}

/** 单次调用的参数覆盖（null 字段回落到配置默认）。enable_thinking 独立字段
 *  避免调用方反复拼 extra_body；reasoning_effort 档位由适配器按厂商协议映射。 */
export class LLMParams {
  readonly temperature: number | null;
  readonly max_tokens: number | null;
  readonly extra_body: Record<string, unknown> | null;
  readonly enable_thinking: boolean | null;
  readonly reasoning_effort: string | null;

  constructor(init: {
    temperature?: number | null;
    max_tokens?: number | null;
    extra_body?: Record<string, unknown> | null;
    enable_thinking?: boolean | null;
    reasoning_effort?: string | null;
  } = {}) {
    this.temperature = init.temperature ?? null;
    this.max_tokens = init.max_tokens ?? null;
    this.extra_body = init.extra_body ?? null;
    this.enable_thinking = init.enable_thinking ?? null;
    this.reasoning_effort = init.reasoning_effort ?? null;
    Object.freeze(this);
  }
}

/** 流式增量帧：内容/推理/工具调用均为增量，累积由上层负责。 */
export class LLMChunk {
  readonly token: string | null;
  readonly reasoning_token: string | null;
  readonly tool_calls_delta: readonly ToolCallDelta[] | null;
  readonly finish_reason: string | null;
  readonly usage: Record<string, Json> | null;

  constructor(init: {
    token?: string | null;
    reasoning_token?: string | null;
    tool_calls_delta?: readonly ToolCallDelta[] | null;
    finish_reason?: string | null;
    usage?: Record<string, Json> | null;
  } = {}) {
    this.token = init.token ?? null;
    this.reasoning_token = init.reasoning_token ?? null;
    this.tool_calls_delta = init.tool_calls_delta ?? null;
    this.finish_reason = init.finish_reason ?? null;
    this.usage = init.usage ?? null;
    Object.freeze(this);
  }

  /** 全空帧（无任何信息字段）——适配器应跳过不产出。 */
  get is_empty(): boolean {
    return !(
      this.token ||
      this.reasoning_token ||
      this.tool_calls_delta ||
      this.finish_reason ||
      this.usage
    );
  }
}

/** 一次 LLM 调用的最终结果（非流式调用 / 流式累积产物）。 */
export class LLMResult {
  content: string;
  reasoning: string | null;
  tool_calls: ToolCall[] | null;
  finish_reason: string | null;
  usage: Record<string, Json> | null;

  constructor(init: {
    content?: string;
    reasoning?: string | null;
    tool_calls?: ToolCall[] | null;
    finish_reason?: string | null;
    usage?: Record<string, Json> | null;
  } = {}) {
    this.content = init.content ?? '';
    this.reasoning = init.reasoning ?? null;
    this.tool_calls = init.tool_calls ?? null;
    this.finish_reason = init.finish_reason ?? null;
    this.usage = init.usage ?? null;
  }
}

/** 统一 LLM 接口：厂商适配器实现本类并注册到适配器注册表（adapters 层）。
 *  失败一律抛 LLMError 子类（errors.ts 分类）；流式中断以宿主取消信号透传。 */
export abstract class AsyncLLM {
  abstract readonly adapter: string;
  readonly config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /** 非流式补全，返回最终结果。 */
  abstract ainvoke(
    messages: readonly Message[],
    opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
  ): Promise<LLMResult>;

  /** 流式补全，产出增量帧（内容/推理/工具调用/终止原因）。 */
  abstract astream(
    messages: readonly Message[],
    opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
  ): AsyncIterable<LLMChunk>;

  /** 释放适配器持有的长生命周期资源（如 HTTP 连接池），无资源时为空实现。 */
  async aclose(): Promise<void> {}
}

/** 把流式增量累积为 LLMResult（内容/推理拼接、工具调用按 index 合并）。 */
export async function collect_result(stream: AsyncIterable<LLMChunk>): Promise<LLMResult> {
  const content_parts: string[] = [];
  const reasoning_parts: string[] = [];
  const deltas: ToolCallDelta[] = [];
  let finish_reason: string | null = null;
  let usage: Record<string, Json> | null = null;
  for await (const chunk of stream) {
    if (chunk.token) content_parts.push(chunk.token);
    if (chunk.reasoning_token) reasoning_parts.push(chunk.reasoning_token);
    if (chunk.tool_calls_delta) deltas.push(...chunk.tool_calls_delta);
    if (chunk.finish_reason) finish_reason = chunk.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }
  const tool_calls = accumulate_tool_calls(deltas);
  return new LLMResult({
    content: content_parts.join(''),
    reasoning: reasoning_parts.join('') || null,
    tool_calls: tool_calls.length > 0 ? tool_calls : null,
    finish_reason,
    usage,
  });
}
