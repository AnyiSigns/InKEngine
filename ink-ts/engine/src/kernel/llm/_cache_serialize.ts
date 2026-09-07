/**
 * 缓存记录负载序列化助手（cache.py 的私有函数拆出：单文件 ≤350 行纪律）。
 *
 * 三个纯函数：
 * - _result_to_dict / _result_from_dict：LLMResult ↔ records JSON 负载
 *   （ToolCall 与 Message 同款内联，往返精确还原）；
 * - _stable_json：Python ``json.dumps(payload, ensure_ascii=False,
 *   sort_keys=True, default=str)`` 的确定性镜像——对象键递归排序、非
 *   JSON 值回落 String（default=str）、undefined 按 null 处理（JS 域
 *   兜底）。仅作进程内指纹稳定输入，不承诺跨语言字节等价（digest 与
 *   Python 独立）。
 *
 * 仅 cache.ts 复用；下划线命名 = 模块内私件，非公开契约。
 */

import type { Json } from './_shapes.js';
import { ToolCall } from './_shapes.js';
import { LLMResult } from './base.js';

/** LLMResult → 记录负载（JSON 形态；ToolCall 与 Message 同款内联）。 */
export function _result_to_dict(result: LLMResult): Record<string, unknown> {
  return {
    content: result.content,
    reasoning: result.reasoning,
    tool_calls: result.tool_calls
      ? result.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        }))
      : null,
    finish_reason: result.finish_reason,
    usage: result.usage,
  };
}

/** 记录负载 → LLMResult（与 to_dict 往返精确还原）。 */
export function _result_from_dict(data: Record<string, unknown>): LLMResult {
  const calls = data['tool_calls'];
  return new LLMResult({
    content: (data['content'] as string | undefined) || '',
    reasoning: (data['reasoning'] as string | null | undefined) ?? null,
    tool_calls: Array.isArray(calls)
      ? calls.map((raw) => {
          const c = raw as Record<string, unknown>;
          return new ToolCall({
            id: c['id'] as string,
            name: c['name'] as string,
            arguments: (c['arguments'] as string | undefined) || '',
          });
        })
      : null,
    finish_reason: (data['finish_reason'] as string | null | undefined) ?? null,
    usage: (data['usage'] as Record<string, Json> | null | undefined) ?? null,
  });
}

/** 确定性稳定字符串化（键排序 + default=str 兜底；见模块头注释）。 */
export function _stable_json(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') return String(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const parts = new Array<string>(value.length);
    for (let i = 0; i < value.length; i++) parts[i] = _stable_json(value[i]);
    return `[${parts.join(',')}]`;
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts = new Array<string>(keys.length);
      for (let i = 0; i < keys.length; i++) {
        parts[i] = `${JSON.stringify(keys[i])}:${_stable_json(obj[keys[i]!])}`;
      }
      return `{${parts.join(',')}}`;
    }
  }
  return String(value); // Python default=str 兜底
}
