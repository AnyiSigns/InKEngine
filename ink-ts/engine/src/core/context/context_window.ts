/**
 * 域上下文窗口投影（context.py domain_window 段移植）。
 *
 * 对共享消息流做**投影**——只给当前域看它该看的部分（用户消息全留 +
 * 本域最近工具轮 + 最近完成性回复 + 归档摘要锚点），共享消息流本身不变。
 *
 * 工具轮归属：轮内**任一**工具属于本域（或公共集）则整轮保留——宁多勿少，
 * 防上下文撕裂（只留半轮会让模型看到无结果的调用或无调用的结果）。
 */

import { message_role } from '../llm/messages.js';
import {
  archive_digest,
  message_text,
  tool_round_spans,
} from './context_compression.js';

/** 域窗口保留的工具轮数上限（防上下文膨胀；用户消息不设限全留）。 */
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

/** 归档摘要总长上限（连续性锚点，供下次进入该域时注入装配）。 */
export const DEFAULT_DIGEST_MAX_CHARS = 800;

/** 工具→域归属解析器：工具名 → 域名；返回 null = 公共集工具（所有域共用）。 */
export type GroupResolver = (tool_name: string) => string | null;

/** 公共集哨兵：group_of 返回 null 表示该工具不属任何单一域，所有域都可见。 */
const SHARED_GROUP = null;

/**
 * 从末尾向前切分工具轮：``[(带 tool_calls 的 assistant 消息, 该轮 tool 消息), ...]``。
 *
 * 消息流顺序 = assistant(tool_calls) → tool 消息…，故从后往前扫时 tool
 * 消息先入缓冲，遇到其所属 assistant 消息时配对成轮；遇用户消息（回合
 * 边界）停止——工具轮只取最近回合的；完成性回复 assistant 消息（无
 * tool_calls）不属任何轮，清空未配对缓冲后继续向前扫（其前可能仍有更早
 * 的工具轮）。
 */
export function iter_tool_rounds(messages: readonly unknown[]): Array<[unknown, unknown[]]> {
  const rounds: Array<[unknown, unknown[]]> = [];
  let pending: unknown[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const role = message_role(msg);
    if (role === 'tool') {
      pending.push(msg);
    } else if (role === 'assistant') {
      if (tool_calls_of(msg).length > 0) {
        rounds.push([msg, [...pending]]);
      }
      // 完成性回复：其后的未配对缓冲不属任何轮（回复在消息流中位于轮后）
      pending = [];
    } else if (role === 'user') {
      break;
    }
  }
  return rounds.reverse();
}

/** assistant 消息的工具调用列表（Message / dict 双形态，无则空序列）。 */
function tool_calls_of(msg: unknown): readonly unknown[] {
  if (msg !== null && typeof msg === 'object' && !Array.isArray(msg)) {
    const calls = (msg as Record<string, unknown>)['tool_calls'];
    return Array.isArray(calls) ? calls : [];
  }
  return [];
}

/** 单轮工具名集合（ToolCall 与 dict 双形态）。 */
function tool_names_of_round(ai_msg: unknown, tool_msgs: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const call of tool_calls_of(ai_msg)) {
    const name =
      call !== null && typeof call === 'object' && !Array.isArray(call)
        ? (call as Record<string, unknown>)['name']
        : undefined;
    if (name) names.add(String(name));
  }
  for (const m of tool_msgs) {
    if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
      const name = (m as Record<string, unknown>)['name'];
      if (name) names.add(String(name));
    }
  }
  return names;
}

/**
 * 最近一条完成性回复（assistant 且无 tool_calls 且文本非空），不跨回合。
 */
export function last_body_message(messages: readonly unknown[]): unknown | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const role = message_role(msg);
    if (role === 'user') break;
    if (
      role === 'assistant' &&
      tool_calls_of(msg).length === 0 &&
      message_text(msg).trim() !== ''
    ) {
      return msg;
    }
  }
  return null;
}

/**
 * 上下文视图投影：用户消息全留 + 本域最近工具轮 + 最近完成性回复。
 *
 * Args:
 * - messages：共享消息流（只读，不修改）；
 * - group：当前域名；
 * - group_of：工具→域归属解析器（宿主注入）；返回 null = 公共集工具；
 * - max_tool_rounds：保留的工具轮数上限，防上下文膨胀。
 *
 * Returns:
 * 投影后的窗口消息列表（用户消息在前，工具轮与回复按原序在后）。
 */
export function build_domain_window(
  messages: readonly unknown[],
  group: string,
  opts: { group_of: GroupResolver; max_tool_rounds?: number },
): unknown[] {
  const max_tool_rounds = opts.max_tool_rounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const window: unknown[] = [];
  for (const m of messages) {
    if (message_role(m) === 'user') window.push(m);
  }
  const recent_rounds = iter_tool_rounds(messages).slice(-max_tool_rounds);
  const kept: unknown[] = [];
  for (const [ai_msg, tool_msgs] of recent_rounds) {
    const names = tool_names_of_round(ai_msg, tool_msgs);
    let belongs = false;
    for (const name of names) {
      const g = opts.group_of(name);
      if (g === SHARED_GROUP || g === group) {
        belongs = true;
        break;
      }
    }
    if (belongs) {
      kept.push(ai_msg);
      kept.push(...tool_msgs);
    }
  }
  const body = last_body_message(messages);
  if (body !== null) kept.push(body);
  return [...window, ...kept];
}

// 重新导出域摘要与轮区间，便于消费者单点引入
export { archive_digest, message_text, tool_round_spans };