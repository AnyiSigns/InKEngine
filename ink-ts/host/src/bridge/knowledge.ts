/**
 * knowledge 命令面（list/graph/export）——知识集只读窗口（host 透传）。
 *
 * 写操作（add/promote/archive/restore/skill_import）本期不提供（web 侧删除
 * 写入口，只留读面）。数据源 = runtime.knowledge_set（补丁链快照组装；
 * entries/export/search 纯读）。knowledge.export 只出 JSON 导出串（跨部署
 * 可移植 = 全量补丁链；kind 过滤 = 单类条目子集导出）。
 *
 * list/graph 兼容旧 python 桥的 args 信封（{args: {...}}）与直传两种形态。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import { toJsonSafe } from './records.js';

/** runtime.knowledge_set 的宽松形态（引擎内部类型不外导；字段结构即契约）。 */
type KnowledgeEntryLike = {
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
const GRAPH_KINDS = ['rule', 'template', 'tool_rule', 'weight'] as const;

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

interface ParamsLike {
  args?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解包（直传 | {args:{...}} 信封）；统一落到 params 记录。 */
function unwrapArgs(raw: unknown): Record<string, unknown> {
  const direct = isRecord(raw) ? raw : {};
  const args = direct['args'];
  if (isRecord(args)) return args;
  return direct;
}

function knowledgeSetOrThrow(deps: HostBridgeDeps): KnowledgeSetLike {
  const knowledgeSet = deps.runtime.knowledge_set;
  if (knowledgeSet === null) {
    throw new BridgeError('知识集未装配', 'runtime_unavailable');
  }
  return knowledgeSet as unknown as KnowledgeSetLike;
}

/** 知识集公开方法面（引擎 KnowledgeSet 公开方法子集；结构性契约）。 */
interface KnowledgeSetLike {
  entries(
    level?: string | null,
    options?: { include_archived?: boolean },
  ): KnowledgeEntryLike[];
  export(): { [key: string]: unknown };
}

function entryView(entry: KnowledgeEntryLike): KnowledgeEntryView {
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
function matchesQuery(entry: KnowledgeEntryLike, query: string): boolean {
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

/** knowledge 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const KNOWLEDGE_COMMANDS = [
  'knowledge.list',
  'knowledge.graph',
  'knowledge.export',
] as const;

export type KnowledgeCommand = (typeof KNOWLEDGE_COMMANDS)[number];

export function buildKnowledgeCommands(deps: HostBridgeDeps): Readonly<Record<KnowledgeCommand, BridgeHandler>> {
  /** 知识集条目窗口（query/kind 过滤 + include_archived 开关）。 */
  const list: BridgeHandler = (raw): KnowledgeListView => {
    const knowledgeSet = knowledgeSetOrThrow(deps);
    const params = unwrapArgs(raw);
    const kind = typeof params['kind'] === 'string' && params['kind'] !== ''
      ? params['kind']
      : null;
    const includeArchived =
      params['archived'] === true
      || params['includeArchived'] === true
      || params['include_archived'] === true;
    const query = typeof params['query'] === 'string' && params['query'] !== ''
      ? params['query']
      : null;
    const entries = knowledgeSet.entries(null, { include_archived: includeArchived });
    const filtered = entries.filter((entry) => {
      if (kind !== null && entry.kind !== kind) return false;
      if (query !== null && !matchesQuery(entry, query)) return false;
      return true;
    });
    return { entries: filtered.map((entry) => entryView(entry)) };
  };

  /** 层级概览：层级计数 + 组件支持 kind 的节点/边（tag/source/reference）。 */
  const graph: BridgeHandler = (): unknown => {
    const knowledgeSet = knowledgeSetOrThrow(deps);
    const entries = knowledgeSet.entries();
    const levelCounts = new Map<string, number>();
    for (const entry of entries) {
      levelCounts.set(entry.level, (levelCounts.get(entry.level) ?? 0) + 1);
    }
    const nodes: Array<{ id: string; label: string; kind: string; level: string }> = [];
    for (const entry of entries) {
      if (!(GRAPH_KINDS as readonly string[]).includes(entry.kind)) continue;
      nodes.push({
        id: entry.id,
        label: entry.title || entry.id,
        kind: entry.kind,
        level: entry.level,
      });
    }
    const rendered = new Map<string, string>();
    for (const entry of entries) {
      try {
        rendered.set(entry.id, entry.render_content());
      } catch {
        rendered.set(entry.id, '');
      }
    }
    const edges: Array<{ source: string; target: string; relation: string }> = [];
    const tagPeers = new Map<string, string[]>();
    for (const entry of entries) {
      for (const tag of entry.tags) {
        const peers = tagPeers.get(tag) ?? [];
        peers.push(entry.id);
        tagPeers.set(tag, peers);
      }
    }
    for (const peers of tagPeers.values()) {
      for (let i = 0; i < peers.length; i += 1) {
        for (let j = i + 1; j < peers.length; j += 1) {
          edges.push({ source: peers[i]!, target: peers[j]!, relation: 'tag' });
        }
      }
    }
    const sourcePeers = new Map<string, string[]>();
    for (const entry of entries) {
      if (entry.source === '' || entry.source === 'model') continue;
      const peers = sourcePeers.get(entry.source) ?? [];
      peers.push(entry.id);
      sourcePeers.set(entry.source, peers);
    }
    for (const peers of sourcePeers.values()) {
      for (let i = 0; i < peers.length; i += 1) {
        for (let j = i + 1; j < peers.length; j += 1) {
          edges.push({ source: peers[i]!, target: peers[j]!, relation: 'source' });
        }
      }
    }
    for (const entry of entries) {
      const content = rendered.get(entry.id) ?? '';
      if (content === '') continue;
      for (const other of entries) {
        if (other.id === entry.id) continue;
        if (
          content.includes(other.id)
          || (other.title !== '' && content.includes(other.title))
        ) {
          edges.push({ source: entry.id, target: other.id, relation: 'reference' });
        }
      }
    }
    if (edges.length > 1000) edges.length = 1000;
    return {
      degraded: entries.length === 0,
      total: entries.length,
      levels: [...levelCounts.entries()]
        .map(([level, count]) => ({ level, count }))
        .sort((a, b) => a.level.localeCompare(b.level)),
      nodes,
      edges,
    };
  };

  /** JSON 导出串（全量补丁链可移植；kind 过滤 = 该类条目 to_dict 子集）。 */
  const exportJson: BridgeHandler = (raw): string => {
    const knowledgeSet = knowledgeSetOrThrow(deps);
    const params = unwrapArgs(raw);
    const kind = typeof params['kind'] === 'string' && params['kind'] !== ''
      ? params['kind']
      : null;
    if (kind === null) {
      return JSON.stringify(toJsonSafe(knowledgeSet.export()), null, 2);
    }
    const entries = knowledgeSet.entries(null, { include_archived: true })
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.to_dict());
    return JSON.stringify({ kind, exported_at: Math.floor(Date.now() / 1000), entries }, null, 2);
  };

  return {
    'knowledge.list': list,
    'knowledge.graph': graph,
    'knowledge.export': exportJson,
  };
}

export { toJsonSafe };
