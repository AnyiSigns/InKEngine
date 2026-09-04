/**
 * 消息附件与工具调用数据形态（Attachment / ToolCallDelta / ToolCall）。
 *
 * 从 messages.ts 拆出以遵守单文件 ≤350 行纪律；本身仅承载数据形态与
 * 序列化/反序列化逻辑，构造期校验仍走 errors.ts 的 LLMConfigError/
 * LLMFormatError，保持零控制台/零 IO 的纯函数形态。
 */

import { LLMConfigError, LLMFormatError } from './errors.js';
import { ATTACHMENT_KINDS, ATTACHMENT_SEGMENT_TYPES } from './_types.js';

/** JSON 兼容值（核心数据形态，零领域类型）。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * 多模态附件元数据（附加在 user 消息上的附件段）。
 *
 * kind 枚举化防魔法字符串（image/video/document）；OpenAI 兼容请求只原生
 * 定义 image_url 段，video/document 按 <kind>_url 收敛（与 Qwen/GLM 等多模态
 * 端点惯例一致），适配器按后端支持裁剪（附件由宿主显式声明，声明方负责后端兼容性）。
 */
export class Attachment {
  readonly kind: string;
  readonly url: string | null;
  readonly path: string | null;
  readonly mime_type: string | null;
  readonly alt: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration: number | null;
  readonly name: string | null;

  constructor(init: {
    kind?: string;
    url?: string | null;
    path?: string | null;
    mime_type?: string | null;
    alt?: string | null;
    width?: number | null;
    height?: number | null;
    duration?: number | null;
    name?: string | null;
  } = {}) {
    const kind = init.kind ?? 'image';
    if (!ATTACHMENT_KINDS.has(kind)) {
      throw new LLMConfigError(`非法附件类型: ${JSON.stringify(kind)}`);
    }
    if (!init.url && !init.path) {
      throw new LLMConfigError('附件必须携带 url 或 path（引用缺失无法发送）');
    }
    this.kind = kind;
    this.url = init.url ?? null;
    this.path = init.path ?? null;
    this.mime_type = init.mime_type ?? null;
    this.alt = init.alt ?? null;
    this.width = init.width ?? null;
    this.height = init.height ?? null;
    this.duration = init.duration ?? null;
    this.name = init.name ?? null;
  }

  /** 引用值：url 优先，缺省回落 path（本地端点场景）。 */
  get ref(): string {
    return this.url || this.path || '';
  }

  /** 序列化为 OpenAI 兼容多模态内容段。 */
  to_openai_segment(): { type: string; [key: string]: Json } {
    const segment = ATTACHMENT_SEGMENT_TYPES[this.kind]!;
    const result: { type: string; [key: string]: Json } = { type: segment };
    result[segment] = { url: this.ref };
    return result;
  }

  to_dict(): Record<string, Json> {
    return {
      kind: this.kind,
      url: this.url,
      path: this.path,
      mime_type: this.mime_type,
      alt: this.alt,
      width: this.width,
      height: this.height,
      duration: this.duration,
      name: this.name,
    };
  }

  static from_dict(data: Record<string, Json>): Attachment {
    const fields = ['kind', 'url', 'path', 'mime_type', 'alt', 'width', 'height', 'duration', 'name'] as const;
    const init: Record<string, Json> = {};
    for (const f of fields) init[f] = data[f] ?? null;
    return new Attachment(init as never);
  }
}

/** 工具调用增量帧（按 index 归属一次调用，流式累积用）。 */
export class ToolCallDelta {
  readonly index: number;
  readonly id: string | null;
  readonly name: string | null;
  readonly arguments_delta: string | null;

  constructor(init: {
    index: number;
    id?: string | null;
    name?: string | null;
    arguments_delta?: string | null;
  }) {
    this.index = init.index;
    this.id = init.id ?? null;
    this.name = init.name ?? null;
    this.arguments_delta = init.arguments_delta ?? null;
  }

  to_dict(): Record<string, Json> {
    return {
      index: this.index,
      id: this.id,
      name: this.name,
      arguments_delta: this.arguments_delta,
    };
  }

  static from_dict(data: Record<string, Json>): ToolCallDelta {
    return new ToolCallDelta({
      index: data['index'] as number,
      id: (data['id'] as string | null) ?? null,
      name: (data['name'] as string | null) ?? null,
      arguments_delta: (data['arguments_delta'] as string | null) ?? null,
    });
  }
}

/** 一次工具调用（增量累积过程中可变——accumulate_tool_calls 就地补全）。 */
export class ToolCall {
  id: string;
  name: string;
  arguments: string;

  constructor(init: { id: string; name: string; arguments?: string }) {
    this.id = init.id;
    this.name = init.name;
    this.arguments = init.arguments ?? '';
  }

  /** 容错解析 arguments JSON（未完成/非法时返回空 dict，不抛错）。 */
  get parsed_arguments(): Record<string, Json> {
    return this.parse_arguments();
  }

  /**
   * 解析 arguments JSON。
   *
   * 容错（默认）：未完成/非法返回空 dict——流式累积中的截断碎片是常态，
   * 容忍解析不抛错；调用方在**执行前**须用 strict=true 校验完整参数。
   * strict=true：非法/非对象 JSON 抛 LLMFormatError，调用方显式拒绝。
   */
  parse_arguments(strict: boolean = false): Record<string, Json> {
    if (!this.arguments.trim()) {
      if (strict) throw new LLMFormatError('工具调用参数为空或未完成');
      return {};
    }
    let value: unknown;
    try {
      value = JSON.parse(this.arguments);
    } catch {
      if (strict) throw new LLMFormatError('工具调用参数非法（非完整 JSON）');
      return {};
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      if (strict) throw new LLMFormatError('工具调用参数须为 JSON 对象');
      return {};
    }
    return value as Record<string, Json>;
  }

  to_dict(): Record<string, Json> {
    return { id: this.id, name: this.name, arguments: this.arguments };
  }

  static from_dict(data: Record<string, Json>): ToolCall {
    return new ToolCall({
      id: data['id'] as string,
      name: data['name'] as string,
      arguments: (data['arguments'] as string | undefined) ?? '',
    });
  }
}