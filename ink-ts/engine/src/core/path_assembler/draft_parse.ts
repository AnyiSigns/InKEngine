/**
 * 草稿解析 + 重试反馈消毒（path_assembler.py「草稿解析」段移植）。
 *
 * parse_draft_chain：提取 JSON 字符串数组（容忍 ```json 包裹与空白），
 * 空响应/非 JSON/超长 = None（调用方不重试直接兜底）。sanitize_draft_feedback：
 * 校验理由 → 结构化重试反馈（只回理由码 + 白名单类型名，模型自造结点名
 * 原文不拼回下一轮提示词——自反馈注入面关闭，ENG9a-11）。
 */

import type { NodeContract } from '../contracts/contracts.js';
import {
  FEEDBACK_DUPLICATE_NODE,
  FEEDBACK_GOAL_NOT_COVERED,
  FEEDBACK_OTHER,
  FEEDBACK_PREFIX_REQUIREMENT,
  FEEDBACK_SAFETY_TIER,
  FEEDBACK_STATE_RULE,
  FEEDBACK_UNKNOWN_NODE,
  MAX_DRAFT_ITEMS,
  MAX_ITEM_CHARS,
} from './constants.js';

/** 草稿解析：提取 JSON 字符串数组（容忍 ```json 包裹与空白）。 */
export function parse_draft_chain(text: string | null | undefined): readonly string[] | null {
  if (!text || text.trim().length === 0) return null;
  let cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/gm, '')
    .replace(/\s*```$/gm, '')
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(cleaned) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (typeof item !== 'string' || item.length === 0) return null;
  }
  if (data.length > MAX_DRAFT_ITEMS) return null;
  for (const item of data as string[]) {
    if (item.length > MAX_ITEM_CHARS) return null;
  }
  return data as string[];
}

/** 校验理由 → 结构化重试反馈（只回理由码 + 白名单类型名）。 */
export function sanitize_draft_feedback(
  reasons: readonly string[],
  pool: Record<string, NodeContract>,
): string {
  const codes: string[] = [];

  const safe_name = (name: string): string => (name in pool ? name : '?');

  for (const reason of reasons) {
    if (reason.startsWith('结点未知')) {
      const name = safe_name(reason.split('结点未知: ', 1)[1]?.trim() ?? '');
      codes.push(`${FEEDBACK_UNKNOWN_NODE}(${name})`);
    } else if (reason.startsWith('结点重复')) {
      const name = safe_name(reason.split('结点重复: ', 1)[1]?.trim() ?? '');
      codes.push(`${FEEDBACK_DUPLICATE_NODE}(${name})`);
    } else if (reason.startsWith('未覆盖目标字段')) {
      const fields = (reason.split('未覆盖目标字段: ', 1)[1] ?? '')
        .split('、')
        .filter((f) => f.length > 0)
        .map((f) => safe_name(f));
      codes.push(`${FEEDBACK_GOAL_NOT_COVERED}(${fields.join('、')})`);
    } else if (reason.includes('安全档')) {
      codes.push(FEEDBACK_SAFETY_TIER);
    } else if (reason.includes('输入') || reason.includes('必填') || reason.includes('前缀')) {
      codes.push(FEEDBACK_PREFIX_REQUIREMENT);
    } else if (reason.includes('状态') || reason.includes('通道')) {
      codes.push(FEEDBACK_STATE_RULE);
    } else {
      codes.push(FEEDBACK_OTHER);
    }
  }
  const unique: string[] = [];
  for (const code of codes) {
    if (!unique.includes(code)) unique.push(code);
  }
  return unique.join('; ') || FEEDBACK_OTHER;
}
