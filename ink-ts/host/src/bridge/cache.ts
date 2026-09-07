/**
 * cache 命令面（stats）——指纹/多径缓存计数只读投影。
 *
 * 数据源 = runtime.fingerprint_cache_store（引擎指纹缓存 store：
 * entries 枚举域分组 + count 全域 + stats 观测统计）+ 组装运行期
 * multipath 开关（多径配置态，引擎无独立多径缓存存储——指纹缓存即
 * 多径展开的缓存载体，计数如实单一）。无 store = 结构化空态
 * （fingerprint_cache.available:false + 全零，不报错不编造）。
 */

import { type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 空指纹缓存统计（store 未装配时结构化全零）。 */
function emptyStoreView(): Record<string, unknown> {
  return {
    available: false,
    entries: 0,
    per_domain: [],
    stats: { lookups: 0, upserts: 0, invalidations: 0, reports: 0, evictions: 0 },
  };
}

/** cache 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const CACHE_COMMANDS = [
  'cache.stats',
] as const;

export type CacheCommand = (typeof CACHE_COMMANDS)[number];

export function buildCacheCommands(deps: HostBridgeDeps): Readonly<Record<CacheCommand, BridgeHandler>> {
  /** cache.stats：指纹缓存计数（全域 + 按域）+ multipath 配置态。 */
  const stats: BridgeHandler = async (): Promise<Record<string, unknown>> => {
    const runtime = deps.runtime;
    const store = runtime.fingerprint_cache_store;
    if (store === null) {
      const assembled = runtime.assembly_runtime;
      return {
        fingerprint_cache: emptyStoreView(),
        multipath: {
          available: assembled !== null,
          enabled: Boolean(
            (assembled !== null && (assembled as unknown as { multipath_enabled: boolean }).multipath_enabled)
            || runtime.assembly_flags?.multipath_enabled,
          ),
        },
      };
    }
    const entriesTotal = await store.count().catch(() => 0);
    let perDomain: Array<{ domain: string; count: number }> = [];
    try {
      const all = await store.entries();
      const counts = new Map<string, number>();
      for (const entry of all) {
        const domain = typeof (entry as unknown as { domain?: unknown }).domain === 'string'
          ? (entry as unknown as { domain: string }).domain
          : 'default';
        counts.set(domain, (counts.get(domain) ?? 0) + 1);
      }
      perDomain = [...counts.entries()]
        .map(([domain, count]) => ({ domain, count }))
        .sort((a, b) => a.domain.localeCompare(b.domain));
    } catch {
      perDomain = [];
    }
    const storeStats = store['stats'];
    const statsView: Record<string, unknown> = isRecord(storeStats) ? storeStats : {};
    return {
      fingerprint_cache: {
        available: true,
        entries: entriesTotal,
        per_domain: perDomain,
        stats: {
          lookups: num(statsView['lookups']),
          upserts: num(statsView['upserts']),
          invalidations: num(statsView['invalidations']),
          reports: num(statsView['reports']),
          evictions: num(statsView['evictions']),
        },
      },
      multipath: {
        available: runtime.assembly_runtime !== null,
        enabled: Boolean(runtime.assembly_flags?.multipath_enabled),
      },
    };
  };

  return { 'cache.stats': stats };
}