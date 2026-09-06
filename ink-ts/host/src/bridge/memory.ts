/**
 * memory 命令面（list/invalidate）——回合记忆库只读窗口 + 批量失效。
 *
 * 数据源 = 引擎默认记忆存储的 `memory` records 集合（runtime.storage 读
 * 面；写入经 EvolutionWriter kind=memory 受控通道）。list 经
 * storage.list_records_page 游标分页流式读集合（limit 前移为驱动层页窗口，
 * 内存只保留召回 top-limit 候选，不整集物化），按 namespace 分组回显；
 * invalidate 批量失效（引擎 delete = 非破坏性标记，记录可追溯，不物理
 * 擦除）。update_frontmatter 不提供（web 侧删除调用）。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** memory.list 条目视图。 */
export interface MemoryEntryView {
  id: string;
  namespace: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  credibility: number;
  expires_at: number | null;
  created_at: number;
}

/** memory.list 结果（namespace 分组计数 + 条目窗口）。 */
export interface MemoryListView {
  namespaces: Array<{ name: string; count: number }>;
  entries: MemoryEntryView[];
}

/** 记忆条目宽松形态（引擎 MemoryEntry 存储记录字段子集；结构契约）。 */
interface MemoryEntryLike {
  id: unknown;
  namespace: unknown;
  kind: unknown;
  title: unknown;
  content: unknown;
  source: unknown;
  weight: unknown;
  priority: unknown;
  expires_at: unknown;
  created_at: unknown;
  _deleted?: unknown;
}

/** 记忆条目 → 视图（weight = credibility 口径沿用旧桥字段名）。 */
function entryView(entry: MemoryEntryLike): MemoryEntryView {
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    namespace: typeof entry.namespace === 'string' ? entry.namespace : '',
    kind: typeof entry.kind === 'string' ? entry.kind : '',
    title: typeof entry.title === 'string' ? entry.title : '',
    content: typeof entry.content === 'string' ? entry.content : '',
    source: typeof entry.source === 'string' ? entry.source : 'manual',
    credibility: num(entry.weight, 1),
    expires_at: typeof entry.expires_at === 'number' ? entry.expires_at : null,
    created_at: typeof entry.created_at === 'number' ? entry.created_at : 0,
  };
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 召回排序键（与引擎 PriorityRecallPolicy 同判据：priority/created 降序）。 */
function recallCompare(
  left: { priority: number; created_at: number },
  right: { priority: number; created_at: number },
): number {
  return right.priority - left.priority || right.created_at - left.created_at;
}

export function buildMemoryHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  /** 记忆清单（query = 内容/标题/id 子串过滤；limit 截断；namespace 分组）。 */
  const list: BridgeHandler = async (raw): Promise<MemoryListView> => {
    const storage = deps.runtime.storage;
    if (storage === null || deps.runtime.memory_store === null) {
      throw new BridgeError('记忆库未装配（memory_extract 开关关闭）', 'runtime_unavailable');
    }
    const params = raw as { query?: unknown; limit?: unknown } | null;
    let limit = 200;
    if (params !== null && params.limit !== undefined && params.limit !== null) {
      const value = Number(params.limit);
      if (!Number.isInteger(value) || value <= 0) {
        throw new BridgeError('memory.list limit 须为正整数', 'invalid_params');
      }
      limit = Math.min(value, 1000);
    }
    const query =
      params !== null && typeof params.query === 'string' && params.query !== ''
        ? params.query.toLowerCase()
        : null;
    const now = Date.now() / 1000;
    interface Candidate {
      record: MemoryEntryLike;
      priority: number;
      created_at: number;
    }
    // 游标分页流式扫描 + 召回 top-limit 候选（不整集物化；驱动层每页 limit）
    const candidates: Candidate[] = [];
    const pushCandidate = (item: MemoryEntryLike): void => {
      if (typeof item !== 'object' || item === null) return;
      if (item['_deleted'] === true) return;
      const expiresAt = typeof item['expires_at'] === 'number' ? item['expires_at'] : null;
      if (expiresAt !== null && now >= expiresAt) return;
      const created_at = typeof item['created_at'] === 'number' ? item['created_at'] : 0;
      const priority = Math.trunc(num(item['priority'], 5));
      if (query !== null) {
        const text = [
          typeof item['title'] === 'string' ? item['title'] : '',
          typeof item['content'] === 'string' ? item['content'] : '',
          typeof item['kind'] === 'string' ? item['kind'] : '',
          typeof item['namespace'] === 'string' ? item['namespace'] : '',
          typeof item['id'] === 'string' ? item['id'] : '',
        ]
          .join('\n')
          .toLowerCase();
        if (!text.includes(query)) return;
      }
      const candidate = { record: item, priority, created_at };
      if (candidates.length < limit) {
        candidates.push(candidate);
        return;
      }
      // 满窗替换最差候选（recall 判据尾端），窗口恒为全局 top-limit
      let worst = 0;
      for (let i = 1; i < candidates.length; i += 1) {
        if (recallCompare(candidates[i]!, candidate) > 0) worst = i;
      }
      if (recallCompare(candidates[worst]!, candidate) > 0) {
        candidates[worst] = candidate;
      }
    };
    let cursor: string | null = null;
    for (;;) {
      const page: { records: Array<Record<string, unknown>>; next_cursor: string | null } | null =
        await storage
          .list_records_page('memory', { limit, cursor })
          .catch(() => null);
      if (page === null) {
        // 分页原语不可得 = 回落整集合读取（旧行为；当前驱动均实现分页）
        const all = (await storage.list_records('memory').catch(() => [])) as unknown[];
        for (const item of all) pushCandidate(item as unknown as MemoryEntryLike);
        break;
      }
      for (const item of page.records) pushCandidate(item as unknown as MemoryEntryLike);
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    candidates.sort((a, b) => recallCompare(a, b));
    const entries = candidates.slice(0, limit).map((entry) => entryView(entry.record));
    const namespaces = new Map<string, number>();
    for (const entry of entries) {
      namespaces.set(entry.namespace, (namespaces.get(entry.namespace) ?? 0) + 1);
    }
    return {
      namespaces: [...namespaces.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      entries,
    };
  };

  /** 批量失效（ids 全量尝试；缺失条目记 not_found，不阻断其余）。 */
  const invalidate: BridgeHandler = async (raw): Promise<unknown> => {
    const store = deps.runtime.memory_store;
    if (store === null) {
      throw new BridgeError('记忆库未装配（memory_extract 开关关闭）', 'runtime_unavailable');
    }
    const params = raw as { ids?: unknown } | null;
    const ids =
      params !== null && Array.isArray(params.ids)
        ? (params.ids as unknown[]).filter((id): id is string => typeof id === 'string')
        : null;
    if (ids === null) {
      throw new BridgeError('memory.invalidate 需 params.ids（字符串清单）', 'invalid_params');
    }
    if ((params!.ids as unknown[]).some((id) => typeof id !== 'string')) {
      throw new BridgeError('memory.invalidate ids 须为字符串清单', 'invalid_params');
    }
    let invalidated = 0;
    const notFound: string[] = [];
    for (const id of ids) {
      const ok = await store.delete(id).catch(() => false);
      if (ok) invalidated += 1;
      else notFound.push(id);
    }
    return { total: ids.length, invalidated, not_found: notFound };
  };

  return new Map<string, BridgeHandler>([
    ['memory.list', list],
    ['memory.invalidate', invalidate],
  ]);
}
