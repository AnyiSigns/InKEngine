/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/knowledge.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * knowledge.list/graph/export 三命令共享知识集宽松形态/视图/查询过滤。
 */

import { BridgeError } from '@ink-ts/host';
import type { HostBridgeDeps } from '@ink-ts/host';

/** runtime.knowledge_set 的宽松形态（引擎内部类型不外导；字段结构即契约）。 */
export type KnowledgeEntryLike = {
  id: string;
  level: string;
  kind: string;
  title: string;
  source: string;
  credibility: number;
  tags: readonly string[];
  archived: boolean;
  failure_logs: readonly string[];
  created_at: number;
  updated_at: number;
  data: Record<string, unknown>;
  render_content(): string;
  to_dict(): Record<string, unknown>;
};

/** 图节点只收录的组件支持 kind（对齐旧桥 knowledge_graph 面）。 */
export const GRAPH_KINDS = ['rule', 'template', 'tool_rule', 'weight'] as const;

/** knowledge.list 条目视图。 */
export interface KnowledgeEntryView {
  id: string;
  level: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  credibility: number;
  tags: string[];
  archived: boolean;
  usage_failures: Array<{ at: number | null; reason: string }>;
  created_at: number;
  updated_at: number;
}

/** knowledge.list 结果。 */
export interface KnowledgeListView {
  entries: KnowledgeEntryView[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解包（直传 | {args:{...}} 信封）；统一落到 params 记录。 */
export function unwrapArgs(raw: unknown): Record<string, unknown> {
  const direct = isRecord(raw) ? raw : {};
  const args = direct['args'];
  if (isRecord(args)) return args;
  return direct;
}

export function knowledgeSetOrThrow(deps: HostBridgeDeps): KnowledgeSetLike {
  const knowledgeSet = deps.runtime.knowledge_set;
  if (knowledgeSet === null) {
    throw new BridgeError('知识集未装配', 'runtime_unavailable');
  }
  return knowledgeSet as unknown as KnowledgeSetLike;
}

/** 知识集公开方法面（引擎 KnowledgeSet 公开方法子集；结构性契约）。 */
export interface KnowledgeSetLike {
  entries(
    level?: string | null,
    options?: { include_archived?: boolean },
  ): KnowledgeEntryLike[];
  export(): { [key: string]: unknown };
}

export function entryView(entry: KnowledgeEntryLike): KnowledgeEntryView {
  let content: string;
  try {
    content = entry.render_content();
  } catch {
    content = JSON.stringify(entry.data ?? {});
  }
  return {
    id: entry.id,
    level: entry.level,
    kind: entry.kind,
    title: entry.title,
    content,
    source: entry.source,
    credibility: entry.credibility,
    tags: [...entry.tags],
    archived: entry.archived,
    usage_failures: entry.failure_logs.map((reason) => ({ at: null, reason })),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

/** 文本查询过滤器（标题/标签/渲染内容/id 子串，大小写不敏感）。 */
export function matchesQuery(entry: KnowledgeEntryLike, query: string): boolean {
  const needle = query.toLowerCase();
  if (entry.id.toLowerCase().includes(needle)) return true;
  if (entry.title.toLowerCase().includes(needle)) return true;
  if (entry.tags.some((tag) => tag.toLowerCase().includes(needle))) return true;
  let content: string;
  try {
    content = entry.render_content();
  } catch {
    content = '';
  }
  return content.toLowerCase().includes(needle);
}
