/**
 * assemble 命令面（stats）——组装链统计只读投影。
 *
 * 数据源 = runtime.assembly_runtime（组装运行期挂载产物：开关位/
 * 累计统计）+ runtime.fingerprint_cache_store（指纹缓存计数与观测
 * 统计）+ runtime.restore_diag / runtime.skill_crystallizer（集状态恢复
 * 诊断与技能结晶装配态）。host 只透传引擎产物，不做缓存语义判断。
 * 未挂载 = 结构化空态（available:false + 字段如实，不报错不编造）。
 */

import type { AssembleCommand } from './commands.generated.js';
export { ASSEMBLE_COMMANDS, type AssembleCommand } from './commands.generated.js';
import { type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 组装运行期结构面（runtime 装配产物，结构即契约）。 */
interface AssemblyRuntimeLike {
  config: { enabled: boolean } | null;
  contract_enabled: boolean;
  multipath_enabled: boolean;
  canary: boolean;
  stats_total: Record<string, number>;
}

/** 指纹缓存统计（引擎 store.stats 五计数器透传）。 */
export interface FingerprintCacheStatsView {
  lookups: number;
  upserts: number;
  invalidations: number;
  reports: number;
  evictions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function cacheStats(store: unknown): FingerprintCacheStatsView {
  const stats = isRecord(store) && isRecord(store['stats']) ? store['stats'] : {};
  return {
    lookups: num(stats['lookups']),
    upserts: num(stats['upserts']),
    invalidations: num(stats['invalidations']),
    reports: num(stats['reports']),
    evictions: num(stats['evictions']),
  };
}

/** assemble 命令声明（方法名真源 = plugins/commands → commands.generated.ts 派生；装配由 index 聚合生成物元组）。 */
export function buildAssembleCommands(deps: HostBridgeDeps): Readonly<Record<AssembleCommand, BridgeHandler>> {
  /** assemble.stats：组装链统计 + 缓存计数（未挂载 = 空态）。 */
  const stats: BridgeHandler = async (): Promise<Record<string, unknown>> => {
    const runtime = deps.runtime;
    const flags = runtime.assembly_flags;
    const assembled = runtime.assembly_runtime;
    const runtimeLike = assembled === null
      ? null
      : (assembled as unknown as AssemblyRuntimeLike);
    const cache = runtime.fingerprint_cache_store;
    const cacheAvailable = cache !== null;
    let entries = 0;
    if (cache !== null) {
      entries = await cache.count().catch(() => 0);
    }
    const assemblerEnabled = runtimeLike?.config?.enabled
      ?? flags?.assembler_enabled
      ?? false;
    const contractEnabled = runtimeLike?.contract_enabled
      ?? flags?.contract_enabled
      ?? false;
    const multipathEnabled = runtimeLike?.multipath_enabled
      ?? flags?.multipath_enabled
      ?? false;
    const crystallizer = runtime.skill_crystallizer;
    const crystallized = crystallizer?.crystallized ?? [];
    return {
      available: runtimeLike !== null,
      assembler_enabled: assemblerEnabled,
      contract_enabled: contractEnabled,
      multipath_enabled: multipathEnabled,
      canary_gate: runtimeLike?.canary ?? false,
      stats: { ...(runtimeLike?.stats_total ?? {}) },
      // 启动恢复诊断（集状态补丁链恢复失败逐段留痕；空 = 无降级恢复记录）
      restore_diag: [...runtime.restore_diag],
      // 技能结晶器装配态（自学习族装配产物；结晶技能名清单只读投影）
      skill_crystal: {
        available: crystallizer !== null,
        count: crystallized.length,
        crystallized: [...crystallized],
      },
      fingerprint_cache: {
        available: cacheAvailable,
        entries,
        stats: cacheAvailable ? cacheStats(cache) : {
          lookups: 0,
          upserts: 0,
          invalidations: 0,
          reports: 0,
          evictions: 0,
        },
      },
    };
  };

  return { 'assemble.stats': stats };
}
