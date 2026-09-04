/**
 * 知识集测试共享设施（Python test_knowledge_set.py 的 _entry 工厂与
 * memory_storage fixture 的 TS 对应物）：条目工厂 + 裸内存存储。
 */

import type { JsonRecord } from '../../../src/core/json.js';
import { KnowledgeEntry } from '../../../src/core/knowledge_set/knowledge_entry.js';
import type { KnowledgeEntryOptions } from '../../../src/core/knowledge_set/knowledge_entry.js';
import { KIND_RULE, LEVEL_WORK } from '../../../src/core/knowledge_set/_types.js';
import type { KnowledgeStorage } from '../../../src/core/knowledge_set/_types.js';

/** 条目工厂（默认 rule/0.7 可信/测试标签；overrides 覆盖任字段）。 */
export function entry(
  entry_id = 'k-1',
  level = LEVEL_WORK,
  overrides: Partial<KnowledgeEntryOptions> = {},
): KnowledgeEntry {
  return new KnowledgeEntry({
    id: entry_id,
    level,
    kind: KIND_RULE,
    data: { rule: { message: `规则 ${entry_id}` } },
    source: 'model',
    credibility: 0.7,
    title: `条目 ${entry_id}`,
    tags: ['测试'],
    ...overrides,
  });
}

/** 裸内存存储：get/put records 全量记录（无守卫；镜像 memory:// 形态）。 */
export class MemStore implements KnowledgeStorage {
  readonly records = new Map<string, Map<string, Record<string, unknown>>>();

  async get_record(
    collection: string,
    key: string,
  ): Promise<Record<string, unknown> | null> {
    return this.records.get(collection)?.get(key) ?? null;
  }

  async put_record(
    collection: string,
    key: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.records.has(collection)) {
      this.records.set(collection, new Map());
    }
    this.records
      .get(collection)!
      .set(key, JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
  }
}

/** 取补丁链原始条目记录（assemble 产物，类型收紧用）。 */
export function rawEntry(
  snapshot: { [key: string]: unknown },
  entry_id: string,
): JsonRecord {
  const entries = snapshot.entries as { [key: string]: unknown };
  return entries[entry_id] as JsonRecord;
}