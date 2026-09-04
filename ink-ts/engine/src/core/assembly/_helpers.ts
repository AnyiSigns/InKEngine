/**
 * InputAssembler 内部辅助（assembly.py 模块级私有函数移植）：源分组/
 * 工具裁剪/压缩克隆/引用提取/回退优先级。仅限本目录内部使用，index 不
 * re-export（对应 Python 下划线私有成员）。
 */

import { GraphDefinitionError } from '../errors.js';
import { _SOURCE_TYPES, _ROLLBACK_PRIORITY } from './assembly_config.js';
import { ContextSource } from '../context/context_types.js';
import { SourceActivation } from './assembly_types.js';
import type { SourceActivationInit } from './assembly_types.js';

/** 按源类别分组（未知类别显式拒绝——类别是预算分级的键，不得漂移）。 */
export function group_sources(
  sources: readonly ContextSource[],
): Record<string, ContextSource[]> {
  const grouped: Record<string, ContextSource[]> = {};
  for (const kind of _SOURCE_TYPES) grouped[kind] = [];
  for (const source of sources) {
    const bucket = grouped[source.type];
    if (bucket === undefined) {
      throw new GraphDefinitionError(`未知装配源类别: ${source.type}`);
    }
    bucket.push(source);
  }
  return grouped;
}

/** 工具激活数裁剪：按分配分（weight × relevance）取前 N（经验框架）。 */
export function limit_tools(
  sources: ContextSource[],
  max_tools: number,
): ContextSource[] {
  if (sources.length <= max_tools) return sources;
  return [...sources]
    .sort((a, b) => b.score() - a.score() || b.priority - a.priority)
    .slice(0, max_tools);
}

/** 压缩视图源克隆：原文不动，仅本次调用使用摘要视图（meta 并入压缩标记）。 */
export function source_with_content(
  source: ContextSource,
  content: string,
): ContextSource {
  return new ContextSource(source.type, content, {
    title: source.title,
    weight: source.weight,
    relevance: source.relevance,
    priority: source.priority,
    ttl: source.ttl,
    max_chars: source.max_chars,
    dedup_key: source.dedup_key,
    meta: { ...source.meta, compressed: true, original_chars: source.content.length },
    created_at: source.created_at,
    clock: source.clock,
  });
}

/** 条目引用（entry_ref）：知识/记忆条目经 meta.entry_id 挂接。 */
export function entry_ref_of(source: ContextSource): string {
  const value = source.meta['entry_id'];
  return typeof value === 'string' ? value : '';
}

/** 工具激活数超上限丢弃说明（留痕归因可读）。 */
export function tool_cap_note(max_tools: number): string {
  return `工具激活数超上限（${max_tools}）`;
}

/** 回退优先级取值（未知类别按 0，镜像 Python dict.get 兜底）。 */
export function rollback_priority(block: [string, SourceActivation[]]): number {
  const first = block[1][0];
  if (first === undefined) return 0;
  return _ROLLBACK_PRIORITY[first.source_type] ?? 0;
}

/**
 * 源 → 激活留痕统一构造：抽取源公共字段（type/title/weight/relevance/
 * entry_ref），档位差异走 extra（char_limit/mode/note）。
 */
export function activation_for(
  source: ContextSource,
  extra: Partial<Omit<SourceActivationInit, 'source_type'>> = {},
): SourceActivation {
  return new SourceActivation({
    source_type: source.type,
    title: source.title ?? '',
    weight: source.weight,
    relevance: source.relevance,
    entry_ref: entry_ref_of(source),
    ...extra,
  });
}
