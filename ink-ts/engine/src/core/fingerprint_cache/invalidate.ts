/**
 * 指纹缓存语义化失效（复用既有 invalidate 单条/整库失效机制）。
 *
 * scope 三种形态：
 * - "*" / "all"：整库失效（逐项 invalidate，计数累加）；
 * - "domain:<域>"：指定域全部条目失效；
 * - 其余：按上下文指纹单条失效（未知指纹 = 0 条失效，fail-closed 不报错）。
 *
 * 空 scope = fail-closed 拒绝（不静默吞错）。每条失效经既有 invalidate
 * 走「降级不命中」语义，被顶替/淘汰时移除——本函数不另起实现。审计复用
 * fingerprint_replace 既有类型（缓存相关留痕），经 emit_audit 落
 * set_audit 集合；反向复原 = 重新 upsert 该指纹（命中恢复）。
 */

import { emit_audit, type AuditStorage } from '../audit_log/audit_log.js';
import { EVENT_AUDIT_FINGERPRINT_REPLACE } from '../event_types/eventTypeSpecs.js';
import type { FingerprintCacheStore } from './store.js';

/** 语义化失效结果（失效条数与 scope 原样返回）。 */
export type InvalidateCacheResult = {
  invalidated: number;
  scope: string;
};

export async function invalidate_cache(
  store: FingerprintCacheStore,
  scope: string,
  opts: { storage?: AuditStorage | null; reason?: string; now?: number | null } = {},
): Promise<InvalidateCacheResult> {
  if (!scope) throw new Error('缓存失效 scope 不能为空（fail-closed）');
  const reason = opts.reason ?? '';
  let invalidated = 0;
  // 审计 domain 从 scope 解析真实域：domain:<域> → 该域；单条指纹 → 从
  // 缓存条目反查所属域；全域失效 → 空串（跨域操作，不冒认单一域）。
  let domainLabel = '';
  if (scope === '*' || scope === 'all') {
    for (const entry of await store.entries()) {
      if (await store.invalidate(entry.context_fingerprint, { reason })) invalidated += 1;
    }
  } else if (scope.startsWith('domain:')) {
    const domain = scope.slice('domain:'.length);
    domainLabel = domain;
    for (const entry of await store.entries(domain || null)) {
      if (await store.invalidate(entry.context_fingerprint, { reason })) invalidated += 1;
    }
  } else {
    if (await store.invalidate(scope, { reason })) invalidated += 1;
    for (const entry of await store.entries()) {
      if (entry.context_fingerprint === scope) {
        domainLabel = entry.domain;
        break;
      }
    }
  }
  const ts = opts.now ?? 0;
  await emit_audit(opts.storage ?? null, {
    type: EVENT_AUDIT_FINGERPRINT_REPLACE,
    ts,
    domain: domainLabel,
    fingerprint: scope === '*' || scope === 'all' ? '' : scope,
    reason: reason || '人工失效',
    invalidated,
  });
  return { invalidated, scope };
}