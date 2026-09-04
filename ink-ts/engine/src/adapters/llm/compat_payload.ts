/**
 * OpenAI 兼容请求装配（openai_compat.py 拆分：端点/请求头/统一 payload 构造）。
 *
 * 适配器统一装配核心请求字段（model/messages/stream/tools/temperature/
 * max_tokens）；params.extra_body 仅透传厂商扩展键——核心字段静默覆盖会
 * 替换整段对话/强制关流，P1 回归约束。推理链开关（enable_thinking）与档位
 * （reasoning_effort）按 LLMConfig.extra.reasoning_style 映射下发。
 */
import { LLMConfig, LLMParams, REASONING_EFFORTS } from '../../core/llm/base.js';
import type { Message } from '../../core/llm/messages.js';
import type { ToolSpec } from '../../core/llm/tools.js';
import { to_openai_tools } from '../../core/llm/tools.js';

/** 适配器统一装配的核心请求字段：extra_body 不得覆盖（防替换对话/强制关流）。 */
export const _CORE_PAYLOAD_KEYS = new Set([
  'model',
  'messages',
  'stream',
  'tools',
  'temperature',
  'max_tokens',
]);

/** chat/completions 端点（base_url 去尾斜杠后拼接）。 */
export function openai_chat_completions_endpoint(base_url: string): string {
  return base_url.replace(/\/+$/, '') + '/chat/completions';
}

/** 请求头：Content-Type 恒带；api_key 非空时带 Bearer 认证头。 */
export function request_headers(api_key: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (api_key) headers['Authorization'] = `Bearer ${api_key}`;
  return headers;
}

/** 装配一次请求 payload（stream 开/关复用同一构造，缺省字段不携带）。 */
export function build_payload(
  config: LLMConfig,
  messages: readonly Message[],
  tools: readonly ToolSpec[] | null,
  params: LLMParams | null,
  stream: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: config.model_id,
    messages: messages.map((m) => m.to_openai_dict()),
    stream,
  };
  if (tools) payload['tools'] = to_openai_tools(tools);
  const temperature =
    params !== null && params.temperature !== null ? params.temperature : config.temperature;
  if (temperature !== null) payload['temperature'] = temperature;
  const max_tokens =
    params !== null && params.max_tokens !== null ? params.max_tokens : config.max_tokens;
  if (max_tokens !== null) payload['max_tokens'] = max_tokens;
  if (params !== null && params.extra_body !== null) {
    // extra_body 仅透传厂商扩展键：核心字段由适配器统一装配（白名单策略）
    for (const [key, value] of Object.entries(params.extra_body)) {
      if (!_CORE_PAYLOAD_KEYS.has(key)) payload[key] = value;
    }
  }
  // 推理链开关（LLMParams.enable_thinking 独立字段）：避免反复拼 extra_body
  if (params !== null && params.enable_thinking !== null) {
    payload['enable_thinking'] = params.enable_thinking;
  }
  // 推理档位：按配置声明的厂商推理样式（reasoning_style）映射
  const effort = params !== null ? params.reasoning_effort : null;
  if (effort !== null && (REASONING_EFFORTS as readonly string[]).includes(effort)) {
    let style = 'effort';
    if (config.extra !== null && typeof config.extra === 'object' && !Array.isArray(config.extra)) {
      style = String(config.extra['reasoning_style'] || 'effort');
    }
    if (style === 'boolean') {
      payload['enable_thinking'] = effort !== 'off';
    } else if (style === 'effort' && effort !== 'off') {
      payload['reasoning_effort'] = effort;
    }
  }
  return payload;
}
