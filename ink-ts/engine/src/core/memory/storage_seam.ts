/**
 * 记忆存储 seam：MemoryStore 协议 + records 通道最小契约。
 *
 * 实现要求（与 Python MemoryStore 协议一致，可换后端）：
 * - save 幂等安全（同 namespace+source+meta 去重由实现决定）；
 * - query 按 namespace/kind/source 过滤（默认按 priority 降序）；
 * - delete 语义为「遗忘」，物理删除或标记失效均可，召回不再返回即可。
 *
 * MemoryStore 面向任意宿主记忆后端（结构化/文件/向量）互换；
 * MemoryStorage 是引擎默认存储后端（StorageBackedMemoryStore）消费的
 * records 通道子集——宿主侧完整 Storage 实现结构兼容（core 零 IO，
 * 实现由宿主注入）。
 */

import type { MemoryEntry, MemoryQuery } from './memory.js';

/** 记忆存储接口（可换后端；Protocol 的 TS 表达）。 */
export interface MemoryStore {
  save(entry: MemoryEntry): Promise<string>;
  get(entry_id: string): Promise<MemoryEntry | null>;
  update(entry_id: string, data: Record<string, unknown>): Promise<boolean>;
  delete(entry_id: string): Promise<boolean>;
  query(query: MemoryQuery): Promise<MemoryEntry[]>;
}

/** records 通道最小契约：默认存储后端只消费 get/put/list 三原语。 */
export interface MemoryStorage {
  get_record(
    collection: string,
    key: string,
  ): Promise<Record<string, unknown> | null>;
  put_record(
    collection: string,
    key: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  list_records(collection: string): Promise<Record<string, unknown>[]>;
}