/**
 * 知识集纯工具（knowledge_set.py 模块级工具函数移植）：CJK 分词判定与
 * 2-gram 滑窗、条目 id 生成（uuid seam 注入点）、补丁链条目路径、存储
 * 集合名。无内部状态，全部为纯函数——检索与落库两侧共用同一形状定义。
 */

import type { Path } from '../patch/types.js';
import type { EntryIdProvider } from './_types.js';

/** 含 CJK 表意字符（中文无空格边界，分词缺陷的判定依据）。 */
export function _has_cjk(text: string): boolean {
  for (const ch of text) {
    if (ch >= '\u4e00' && ch <= '\u9fff') return true;
  }
  return false;
}

/** CJK 长 token 的 2-gram 滑窗展开（去重保序）。
 *
 * 中文长句（装配 query = 回合输入全文）无空格边界，空格分词会整段
 * 塌缩为单个超长 token——按 2-gram 滑窗展开为关键片段，检索命中
 * 「任一连续 2 字片段」即可进入候选并按命中数评分，中文 query 不再
 * 必然 0 命中。
 */
export function _cjk_bigrams(text: string): readonly string[] {
  if (text.length < 2) return [text];
  const grams: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    if (!seen.has(gram)) {
      seen.add(gram);
      grams.push(gram);
    }
  }
  return grams;
}

/** 缺省 id 提供者：固定串（uuid seam 未注入时的确定性复现值）。 */
export const DEFAULT_ENTRY_ID = 'k-000000000000';

/** 新条目 id 生成（uuid 短前缀，集内唯一即可；seam 可注入，缺省固定串）。 */
export function _make_entry_id(
  provider: EntryIdProvider = (): string => DEFAULT_ENTRY_ID,
): string {
  return provider();
}

/** 补丁链中条目所在路径（entries/<id>，层级经条目自身字段承载）。 */
export function _entry_path(entry_id: string): Path {
  return ['entries', entry_id];
}

/** 用户集存储集合名（多用户隔离：一用户一集，集内条目补丁链承载）。 */
export function knowledge_collection(user_id: string): string {
  return `knowledge:${user_id}`;
}