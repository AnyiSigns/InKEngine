/**
 * memory.list 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/memory.ts 迁入，
 * 语义零改）。回合记忆库只读窗口（游标分页流式扫描 + 召回 top-limit 候选，
 * namespace 分组计数）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { entryView, num, recallCompare, type MemoryEntryLike } from '../../../_shared/memory.js';

export default function createMemoryList(deps: HostBridgeDeps): BridgeHandler {
  /** 记忆清单（query = 内容/标题/id 子串过滤；limit 截断；namespace 分组）。 */
  const list: BridgeHandler = async (raw): Promise<unknown> => {
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

  return list;
}
