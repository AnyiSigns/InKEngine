/**
 * OpenAI Responses 请求体转换（openai_response.py 的 _to_input_items /
 * tools 扁平化拆出；专用拆分避免与 openai_compat 的共享 _payload 混淆）。
 *
 * Responses 协议的 ``input`` 数组承载消息（含 function_call /
 * function_call_output 工具回环项），与 chat/completions 的 messages
 * 形态不同，这里把引擎 Message 统一形态转为 Responses input item；
 * tools 段为扁平 {type, name, description, parameters}，解包既有
 * to_openai_tools 的 function 嵌套段复用转换。
 */

import type { Json } from '../../core/llm/_shapes.js';
import type { Message } from '../../core/llm/messages.js';
import type { ToolSpec } from '../../core/llm/tools.js';
import { to_openai_tools } from '../../core/llm/tools.js';

/** 适配器统一装配的核心请求字段：extra_body 不得覆盖（防替换对话/强制关流）。 */
export const RESPONSES_CORE_PAYLOAD_KEYS: readonly string[] = [
  'model',
  'input',
  'instructions',
  'tools',
  'stream',
  'temperature',
  'max_output_tokens',
  'reasoning',
];

/** Message 序列 → Responses ``input`` 数组（工具回环项/角色项）。 */
export function to_input_items(messages: readonly Message[]): Record<string, Json>[] {
  const items: Record<string, Json>[] = [];
  for (const message of messages) {
    // tool 角色 → function_call_output（供模型消费工具结果）
    if (message.role === 'tool') {
      items.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: message.content,
      });
      continue;
    }
    // assistant 纯工具调用回复：无文本内容项，函数调用项紧跟其后入列
    if (message.role === 'assistant' && message.tool_calls) {
      for (const tc of message.tool_calls) {
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
      continue;
    }
    // user 附件：文本 + 多模态段展开为 content 数组（type=input_text 命名）
    if (message.role === 'user' && message.attachments.length > 0) {
      const parts: Json[] = [];
      if (message.content) parts.push({ type: 'input_text', text: message.content });
      for (const a of message.attachments) parts.push(a.to_openai_segment());
      const item: Record<string, Json> = { role: 'user', content: parts };
      if (message.name) item['name'] = message.name;
      items.push(item);
      continue;
    }
    const item: Record<string, Json> = { role: message.role, content: message.content };
    if (message.name && (message.role === 'user' || message.role === 'assistant')) {
      item['name'] = message.name;
    }
    items.push(item);
  }
  return items;
}

/**
 * ToolSpec 列表 → Responses 扁平 tools 段。
 *
 * to_openai_tools 产出 chat 嵌套形态 {type, function: {name, description,
 * parameters}}；Responses 段把 function 内容平铺到顶层后原样携带。
 */
export function response_tools(tools: readonly ToolSpec[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const t of to_openai_tools(tools)) {
    const fn = t['function'];
    if (typeof fn === 'object' && fn !== null) {
      out.push({ type: 'function', ...(fn as Record<string, unknown>) });
    } else {
      out.push({ type: 'function' });
    }
  }
  return out;
}
