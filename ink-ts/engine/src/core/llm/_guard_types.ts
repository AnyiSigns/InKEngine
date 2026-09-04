/**
 * guard 包装器依赖的 AsyncLLM seam 结构形态（Python llm/base.py 的包装侧视图）。
 *
 * guard 是纯机制包装（压缩/用量跟踪/current_node_context），不涉厂商传输——
 * 实时传输/适配器注册/collect_result 等整体移植属 llm base 批次（base.ts），
 * 落地后本文件导出随之收敛为 base.ts 的 re-export；在此之前以本最小结构契约
 * 支撑 guard.ts 与宿主注入的 inner（鸭子协议，结构满足即可）。
 */

import type { ToolCall, ToolCallDelta } from './_shapes.js';
import type { Message } from './messages.js';
import type { ToolSpec } from './tools.js';

/** token 用量帧（服务端 usage / result.usage / 流式末帧 usage；引擎不解释细节，透传记账）。 */
export type Usage = Record<string, unknown> | null | undefined;

/** 模型接入配置（guard 占位仅用 adapter/model_id/base_url 三字段）。 */
export interface LLMConfig {
  adapter: string;
  model_id: string;
  base_url: string;
}

/** 单次调用的参数覆盖容器（guard 只透传不改写；None 字段回落配置默认）。 */
export interface LLMParams {
  temperature?: number | null;
  max_tokens?: number | null;
  extra_body?: Record<string, unknown> | null;
  enable_thinking?: boolean | null;
  reasoning_effort?: string | null;
}

/** 包装调用入参（tools/params，均关键字可选——透传给 inner）。 */
export interface InvokeOptions {
  tools?: readonly ToolSpec[] | null;
  params?: LLMParams | null;
}

/** 流式增量帧：内容/推理/工具调用均为增量，累积由上层负责。 */
export interface LLMChunk {
  token?: string | null;
  reasoning_token?: string | null;
  tool_calls_delta?: ToolCallDelta[] | null;
  finish_reason?: string | null;
  /** 流式末帧 token 用量（服务端带 include_usage 时携带）。 */
  usage?: Usage;
}

/** 一次 LLM 调用的最终结果（非流式调用 / 流式累积产物）。 */
export interface LLMResult {
  content: string;
  reasoning?: string | null;
  tool_calls?: ToolCall[] | null;
  finish_reason?: string | null;
  usage?: Usage;
}

/**
 * 统一 LLM 结构契约：厂商适配器与包装器（guard）共用同一形态。
 *
 * 包装器按 Python guard.py 语义继承 AsyncLLM 基类（adapter/config + 抽象
 * ainvoke/astream/aclose）；TS 侧以结构类型表达——内层由宿主注入，只要满足
 * 本契约即可被包装。
 */
export interface AsyncLLM {
  readonly adapter: string;
  readonly config: LLMConfig;
  ainvoke(messages: readonly Message[], opts?: InvokeOptions): Promise<LLMResult>;
  astream(messages: readonly Message[], opts?: InvokeOptions): AsyncIterable<LLMChunk>;
  aclose(): Promise<void>;
}
