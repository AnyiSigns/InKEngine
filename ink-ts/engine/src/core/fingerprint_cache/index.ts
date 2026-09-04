/**
 * 指纹缓存域公开 re-export（snake_case 镜像 Python __all__）。
 *
 * 文件拆分纪律：常数与条目结构落 _types；纯机制判定（契约快照/证据
 * 漂移/顶替审计记录）落 mechanism；存储 seam 落 storage_seam；默认
 * 内存实现落 in_memory；store 封装与淘汰判定落 store；语义化失效落
 * invalidate。
 */

export {
  DEFAULT_CACHE_CAP_PER_DOMAIN,
  DRIFT_MIN_N,
  DRIFT_RATIO,
  REPLACE_REASON_DRIFT,
  REPLACE_REASON_SAMPLE,
} from './_types.js';
export type { FingerprintCacheEntry } from './_types.js';

export { evidence_drifted, fingerprint_replace_audit_record } from './mechanism.js';
export type { FingerprintReplaceAuditRecord } from './mechanism.js';

export { InMemoryFingerprintCacheStorage } from './in_memory.js';

export { FingerprintCacheStore } from './store.js';
export type { FingerprintCacheStats } from './store.js';

export type { FingerprintCacheRow, FingerprintCacheStorage } from './storage_seam.js';

export { invalidate_cache } from './invalidate.js';
export type { InvalidateCacheResult } from './invalidate.js';