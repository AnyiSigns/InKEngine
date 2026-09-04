/**
 * Anthropic Messages 请求装配（anthropic.py 请求构造段拆分；模块 anthropic
 * 专属命名防与 openai 拆分冲突）。system 抽为顶层字段，tool 角色转
 * tool_result 块，assistant 工具调用转 tool_use 块；工具 schema 以
 * input_schema 原生形态 passthrough。
 *
 * 推理档位（extended thinking）：low/medium/high → budget_tokens；开启时
 * Anthropic 不允许显式 temperature（须 unset），且 max_tokens 必须大于
 * budget——不足自动抬升（budget + 1024）。off/None 不携带 thinking。
 *
 * 厂商缓存参数：config.extra.cache_control 为真时给 system 挂 ephemeral
 * 缓存断点。extra_body 仅透传厂商扩展键——核心字段由适配器统一装配，杜绝
 * 调用方覆盖核心键。
 */

import { REASONING_EFFORTS, type LLMConfig, type LLMParams } from '../../core/llm/base.js';
import type { Message } from '../../core/llm/messages.js';
import type { ToolSpec } from '../../core/llm/tools.js';

/** Anthropic 最低 max_tokens 兜底（API 要求显式 max_tokens）。 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;

/** 推理档位 → extended thinking budget_tokens（低/中/高；最低 1024）。 */
export const ANTHROPIC_THINKING_BUDGET: Readonly<Record<string, number>> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};

/** extra_body 透传时的保留键（核心字段由适配器装配，不透传覆盖）。 */
const _RESERVED_PAYLOAD_KEYS = new Set([
  'model',
  'max_tokens',
  'messages',
  'stream',
  'tools',
  'system',
  'temperature',
  'thinking',
]);

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取首个 system 消息内容（多 system 仅取首个，与既有约束一致）。 */
export function anthropic_system_text(messages: readonly Message[]): string | null {
  for (const m of messages) {
    if (m.role === 'system') return m.content || null;
  }
  return null;
}

/** 引擎 Message → Anthropic messages（system 已抽离为顶层字段）。 */
export function to_anthropic_messages(messages: readonly Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content },
        ],
      });
      continue;
    }
    const blocks: Record<string, unknown>[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.parsed_arguments,
        });
      }
    }
    out.push({ role: m.role, content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
  }
  return out;
}

/** ToolSpec 列表 → Anthropic tools（input_schema 原生形态；空列表返回 null）。 */
export function to_anthropic_tools(
  tools: readonly ToolSpec[] | null,
): Record<string, unknown>[] | null {
  if (!tools || tools.length === 0) return null;
  const out: Record<string, unknown>[] = [];
  for (const spec of tools) {
    const data = spec.to_dict();
    out.push({
      name: data['name'],
      description: data['description'],
      input_schema: data['parameters'],
    });
  }
  return out;
}

/** 推理档位是否为开启态（off/None = 不携带 thinking）。 */
export function anthropic_thinking_on(effort: string | null): boolean {
  return (
    effort !== null &&
    effort !== 'off' &&
    (REASONING_EFFORTS as readonly string[]).includes(effort) &&
    ANTHROPIC_THINKING_BUDGET[effort] !== undefined
  );
}

/**
 * 装配 Anthropic Messages 请求负载（非流式/流式共用）。thinking 开启且
 * max_tokens 不足 budget 时自动抬升（budget + 1024）并写回负载。
 */
export function build_anthropic_payload(
  config: LLMConfig,
  messages: readonly Message[],
  tools: readonly ToolSpec[] | null,
  params: LLMParams | null,
  stream: boolean,
): Record<string, unknown> {
  const maxTokensRaw =
    params !== null && params.max_tokens !== null
      ? params.max_tokens
      : config.max_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  const payload: Record<string, unknown> = {
    model: config.model_id,
    max_tokens: maxTokensRaw,
    messages: to_anthropic_messages(messages),
    stream,
  };
  // 厂商缓存参数：cache_control 为真时给 system 块挂 ephemeral 缓存断点
  const system = anthropic_system_text(messages);
  if (system !== null) {
    const cache = Boolean(config.extra && config.extra['cache_control']);
    payload['system'] = cache
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }
  const anthropicTools = to_anthropic_tools(tools);
  if (anthropicTools) payload['tools'] = anthropicTools;
  // 推理档位（extended thinking）：开启时 temperature 不设、max_tokens 抬升
  const effort = params !== null ? params.reasoning_effort : null;
  let thinkingOn = false;
  if (anthropic_thinking_on(effort)) {
    const budget = ANTHROPIC_THINKING_BUDGET[effort as string] as number;
    let maxTokens = maxTokensRaw;
    if (maxTokens <= budget) maxTokens = budget + ANTHROPIC_DEFAULT_MAX_TOKENS;
    payload['max_tokens'] = maxTokens;
    payload['thinking'] = { type: 'enabled', budget_tokens: budget };
    thinkingOn = true;
  }
  const temperature =
    params !== null && params.temperature !== null ? params.temperature : config.temperature;
  if (temperature !== null && !thinkingOn) payload['temperature'] = temperature;
  if (params !== null && params.extra_body && is_record(params.extra_body)) {
    for (const [key, value] of Object.entries(params.extra_body)) {
      if (!_RESERVED_PAYLOAD_KEYS.has(key)) payload[key] = value;
    }
  }
  return payload;
}
