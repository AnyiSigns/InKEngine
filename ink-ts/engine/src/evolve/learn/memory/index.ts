/**
 * 记忆域公开 re-export（snake_case 镜像 Python __all__）。
 *
 * 文件拆分纪律：条目/查询/来源分级权重与召回策略落 memory；存储
 * seam（MemoryStore/MemoryStorage）落 storage_seam；默认存储后端
 * 落 store。
 */

export {
  DEFAULT_ID_GEN,
  DEFAULT_NOW,
  SOURCE_WEIGHT_BY_SOURCE,
  MemoryEntry,
  PriorityRecallPolicy,
} from './memory.js';

export type {
  IdGenFn,
  MemoryEntryInput,
  MemoryEntryOptions,
  MemoryQuery,
  MemoryRecallPolicy,
  NowFn,
  PriorityRecallPolicyOptions,
} from './memory.js';

export type { MemoryStore, MemoryStorage } from './storage_seam.js';

export { StorageBackedMemoryStore } from './store.js';
export type { StorageBackedMemoryStoreOptions } from './store.js';