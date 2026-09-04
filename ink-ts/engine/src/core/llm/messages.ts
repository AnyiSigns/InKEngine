/**
 * 聊天消息与工具调用增量累积（Message + 工厂函数 + accumulate_tool_calls + message_role）。
 *
 * 数据形态类 Attachment / ToolCall / ToolCallDelta 拆入 _shapes.ts 以遵守单文件
 * 行数上限；本模块聚焦 Message 主对象、角色工厂、序列化与角色归一。
 *
 * message_role 作为消息形态角色归一的总入口（覆盖 dict/鸭子类型/类名兜底），
 * 供上下文投影、窗口裁剪等原语复用。
 */

import { LLMConfigError } from './errors.js';
import {
  Attachment,
  ToolCall,
  ToolCallDelta,
  type Json,
} from './_shapes.js';
import { ROLES, ROLE_ALIASES } from './_types.js';

export { Attachment, ToolCall, ToolCallDelta, type Json } from './_shapes.js';

/** uuid 注入面：缺省固定 hex，保证纯函数可复现。 */
export interface UuidOptions {
  /** 十六进制 uuid 源；未注入时按确定值 0...0 × 32 位。 */
  uuid?: () => string;
}

const DEFAULT_UUID = (): string => '00000000000000000000000000000000';

/** 聊天消息（system/user/assistant/tool 四角色）。 */
export class Message {
  readonly role: string;
  readonly content: string;
  readonly tool_call_id: string | null;
  readonly tool_calls: ToolCall[] | null;
  readonly reasoning: string | null;
  readonly id: string;
  readonly attachments: readonly Attachment[];
  readonly name: string | null;

  constructor(
    role: string,
    content: string = '',
    tool_call_id: string | null = null,
    tool_calls: ToolCall[] | null = null,
    reasoning: string | null = null,
    id: string | null = null,
    attachments: readonly Attachment[] = [],
    name: string | null = null,
    options: UuidOptions = {},
  ) {
    if (!ROLES.has(role)) {
      throw new LLMConfigError(`非法消息角色: ${JSON.stringify(role)}`);
    }
    if (role === 'tool' && !tool_call_id) {
      throw new LLMConfigError('tool 角色消息必须携带 tool_call_id');
    }
    const normAttachments: Attachment[] = [];
    for (const a of attachments) {
      normAttachments.push(a instanceof Attachment ? a : Attachment.from_dict(a as Record<string, Json>));
    }
    const normToolCalls: ToolCall[] | null = tool_calls
      ? tool_calls.map((tc) => (tc instanceof ToolCall ? tc : new ToolCall(tc as { id: string; name: string })))
      : null;
    this.role = role;
    this.content = content;
    this.tool_call_id = tool_call_id;
    this.tool_calls = normToolCalls;
    this.reasoning = reasoning;
    this.id = id ?? (options.uuid ?? DEFAULT_UUID)();
    this.attachments = normAttachments;
    this.name = name;
  }

  /** 序列化为 OpenAI 兼容请求负载（user 多模态附件展开为内容段数组）。 */
  to_openai_dict(): Record<string, Json> {
    if (this.role === 'tool') {
      return { role: 'tool', content: this.content, tool_call_id: this.tool_call_id };
    }
    if (this.role === 'user' && this.attachments.length > 0) {
      const content: { type: string; [key: string]: Json }[] = [];
      if (this.content) content.push({ type: 'text', text: this.content });
      for (const a of this.attachments) content.push(a.to_openai_segment());
      const payload: Record<string, Json> = { role: 'user', content };
      if (this.name) payload['name'] = this.name;
      return payload;
    }
    const payload: Record<string, Json> = { role: this.role, content: this.content };
    if (this.name && (this.role === 'user' || this.role === 'assistant')) {
      payload['name'] = this.name;
    }
    if (this.role === 'assistant' && this.tool_calls) {
      payload['tool_calls'] = this.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return payload;
  }

  to_dict(): Record<string, Json> {
    return {
      role: this.role,
      content: this.content,
      tool_call_id: this.tool_call_id,
      tool_calls: this.tool_calls ? this.tool_calls.map((tc) => tc.to_dict()) : null,
      reasoning: this.reasoning,
      id: this.id,
      attachments: this.attachments.length > 0 ? this.attachments.map((a) => a.to_dict()) : null,
      name: this.name,
    };
  }

  static from_dict(data: Record<string, Json>): Message {
    const tcRaw = data['tool_calls'];
    const attRaw = data['attachments'];
    const tool_calls: ToolCall[] | null = Array.isArray(tcRaw)
      ? tcRaw.map((tc) => ToolCall.from_dict(tc as Record<string, Json>))
      : null;
    const attachments: Attachment[] = Array.isArray(attRaw)
      ? attRaw.map((a) => Attachment.from_dict(a as Record<string, Json>))
      : [];
    return new Message(
      data['role'] as string,
      (data['content'] as string | undefined) ?? '',
      (data['tool_call_id'] as string | null | undefined) ?? null,
      tool_calls,
      (data['reasoning'] as string | null | undefined) ?? null,
      (data['id'] as string | null | undefined) ?? null,
      attachments,
      (data['name'] as string | null | undefined) ?? null,
    );
  }
}

export function system(text: string, options: UuidOptions = {}): Message {
  return new Message('system', text, null, null, null, null, [], null, options);
}

export function user(
  text: string,
  options: { attachments?: readonly Attachment[]; name?: string | null; uuid?: () => string } = {},
): Message {
  const { attachments, name, uuid } = options;
  return new Message('user', text, null, null, null, null, attachments ?? [], name ?? null, { uuid });
}

export function assistant(
  text: string = '',
  options: {
    tool_calls?: ToolCall[] | null;
    reasoning?: string | null;
    name?: string | null;
    uuid?: () => string;
  } = {},
): Message {
  const { tool_calls, reasoning, name, uuid } = options;
  return new Message('assistant', text, null, tool_calls ?? null, reasoning ?? null, null, [], name ?? null, { uuid });
}

export function tool_result(content: string, tool_call_id: string, options: UuidOptions = {}): Message {
  return new Message('tool', content, tool_call_id, null, null, null, [], null, options);
}

/**
 * 任意消息形态的角色归一（system/user/assistant/tool）。
 *
 * 识别顺序：role 属性（引擎 Message）→ dict 的 role/type 键 → 类名兜底。
 * human/ai 别名统一归一为 user/assistant；无法识别时返回空串或小写类名，
 * 调用方按「非已知角色」处理即可（不抛错，防迁移期偶发形态崩）。
 *
 * 纯对象字面量（构造来源为 Object/无自定义类名）不触发类名兜底——避免
 * `{}` 被误归为 'object'；类名兜底仅在自定义类实例上生效。
 */
export function message_role(msg: unknown): string {
  const isObj = msg !== null && typeof msg === 'object' && !Array.isArray(msg);
  if (isObj) {
    const obj = msg as Record<string, unknown>;
    const role = obj['role'];
    if (typeof role === 'string' && role.length > 0) {
      return ROLE_ALIASES[role] ?? role;
    }
    const raw = String(obj['role'] || obj['type'] || '');
    if (raw.length > 0) return ROLE_ALIASES[raw] ?? raw;
  }
  // 类名兜底：仅对自定义类生效，构造来源为 Object/无自定义类的纯字典不回退
  if (isObj) {
    const ctor = (msg as { constructor?: { name?: string } }).constructor;
    const ctorName = ctor?.name ?? '';
    if (ctorName && ctorName !== 'Object') {
      const name = ctorName.toLowerCase();
      const stem = name.endsWith('message') ? name.slice(0, -'message'.length) : name;
      return ROLE_ALIASES[stem] ?? (stem || name);
    }
  }
  return '';
}

/** 按 index 合并流式工具调用增量（保持首次出现顺序，index 乱序时仍按首见序输出）。 */
export function accumulate_tool_calls(deltas: readonly ToolCallDelta[]): ToolCall[] {
  const byIndex = new Map<number, ToolCall>();
  const order: number[] = [];
  for (const delta of deltas) {
    let tc = byIndex.get(delta.index);
    if (tc === undefined) {
      tc = new ToolCall({ id: delta.id ?? '', name: delta.name ?? '', arguments: '' });
      byIndex.set(delta.index, tc);
      order.push(delta.index);
    }
    if (delta.id) tc.id = delta.id;
    if (delta.name) tc.name = delta.name;
    if (delta.arguments_delta) tc.arguments += delta.arguments_delta;
  }
  return order.map((i) => byIndex.get(i) as ToolCall);
}