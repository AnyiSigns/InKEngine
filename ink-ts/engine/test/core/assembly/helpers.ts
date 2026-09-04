/**
 * core/assembly 测试共享构造辅助（镜像 test_assembly.py 的 _source 与
 * _summary_compressor）。
 */

import { ContextSource } from '../../../src/core/context/context_types.js';

/** _source 辅助可选字段（Python 关键字参映射）。 */
export interface SourceFields {
  weight?: number;
  relevance?: number;
  entry_ref?: string;
}

/** 测试源构造：title = {kind}-{text[:8]}，entry_ref 经 meta.entry_id 挂接。 */
export function _source(
  kind: string,
  text: string,
  fields: SourceFields = {},
): ContextSource {
  return new ContextSource(kind, text, {
    title: `${kind}-${text.slice(0, 8)}`,
    weight: fields.weight ?? 1.0,
    relevance: fields.relevance ?? 0.5,
    meta: fields.entry_ref ? { entry_id: fields.entry_ref } : {},
  });
}

/** 测试压缩钩子：摘要视图 = 首句 + 省略标记（预算内）。 */
export function _summary_compressor(
  source: ContextSource,
  budget: number,
): string {
  const prefix = `摘要:${source.content.slice(0, 12)}`;
  return prefix.slice(0, budget);
}
