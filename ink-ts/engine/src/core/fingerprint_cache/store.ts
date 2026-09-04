/**
 * FingerprintCacheStore：指纹缓存核心域存储（机制判定 + 注入 seam 适配）。
 *
 * 设计要点（全部为机制侧事实，镜像 Python 实现）：
 * - 入缓存质量线：无质量闸门注入 = fail-closed 不入缓存（gate_passed=False
 *   直接拒绝，存储体零触碰）；
 * - 容量上限 + 淘汰：每域上限（默认 1000 条），达上限按「命中率升序 →
 *   时效升序 → 指纹字典序」淘汰最差条目（确定性淘汰序，与 Python SQL
 *   同判据）；
 * - 失效标记：失效条目不再命中但计数保留（命中数/失败数可观测），被
 *   顶替/淘汰时移除；
 * - 时间源注入：now 缺省确定值 0（core 零时钟可复现；生产由宿主注入）。
 * 存储经 FingerprintCacheStorage seam 进出（默认 InMemory*），零 IO。
 */

import { StorageError } from '../errors.js';
import { DEFAULT_CACHE_CAP_PER_DOMAIN } from './_types.js';
import type { FingerprintCacheEntry } from './_types.js';
import { InMemoryFingerprintCacheStorage } from './in_memory.js';
import { contract_snapshot_from_path } from './mechanism.js';
import type { FingerprintCacheRow, FingerprintCacheStorage } from './storage_seam.js';

/** 观测统计（查找/写入/失效/回馈/淘汰计数；供基准与审计）。 */
export type FingerprintCacheStats = {
  lookups: number;
  upserts: number;
  invalidations: number;
  reports: number;
  evictions: number;
};

/** 规范 JSON 序列化：递归键排序（镜像 Python ensure_ascii=False, sort_keys=True；
 *  TS 字符串原生 unicode，无需转义）。 */
function stable_json(value: unknown): string {
  return JSON.stringify(to_canonical(value));
}

function to_canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => to_canonical(v));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = to_canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** 行 → 条目（投影为域类型；复杂字段按 JSON 反序列化，形状与 Python 行转换一致）。 */
function row_to_entry(row: FingerprintCacheRow): FingerprintCacheEntry {
  return {
    context_fingerprint: row.context_fingerprint,
    path: JSON.parse(row.path_data) as Record<string, unknown>,
    path_fingerprint: row.path_fingerprint,
    evidence_snapshot: JSON.parse(row.evidence_snapshot) as readonly Record<string, unknown>[],
    contract_snapshot: (
      JSON.parse(row.contract_snapshot) as Array<readonly [string, string]>
    ).map((pair) => [pair[0], pair[1]] as const),
    model_id: row.model_id,
    domain: row.domain,
    created_at: row.created_at,
    updated_at: row.updated_at,
    hit_count: row.hit_count,
    fail_count: row.fail_count,
    invalid: row.invalid === 1,
  };
}

/** 淘汰序命中率判据：无触碰计 0.0（镜像 Python SQL CASE 表达式）。 */
function hit_rate(row: FingerprintCacheRow): number {
  const total = row.hit_count + row.fail_count;
  if (total === 0) return 0.0;
  return row.hit_count / total;
}

/** 指纹缓存存储（注入 seam 的薄封装；默认 in-memory，生产由宿主注入）。 */
export class FingerprintCacheStore {
  /** 观测统计（Python 同名 stats 字典；随各操作累计）。 */
  readonly stats: FingerprintCacheStats = {
    lookups: 0,
    upserts: 0,
    invalidations: 0,
    reports: 0,
    evictions: 0,
  };
  readonly #storage: FingerprintCacheStorage;
  readonly #cap: number;
  readonly #now: number | null;
  #closed = false;

  constructor(opts: {
    storage?: FingerprintCacheStorage;
    cap_per_domain?: number;
    now?: number | null;
  } = {}) {
    this.#storage = opts.storage ?? new InMemoryFingerprintCacheStorage();
    this.#cap = Math.max(1, Math.trunc(Number(opts.cap_per_domain ?? DEFAULT_CACHE_CAP_PER_DOMAIN)));
    this.#now = opts.now ?? null;
  }

  /** 时间源：注入 now 优先，缺省确定值 0（core 零时钟可复现）。 */
  #ts(): number {
    return this.#now ?? 0;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new StorageError('指纹缓存存储已关闭（close() 后不可再读写）');
    }
  }

  /** 写入/顶替缓存条目（fail-closed：gate_passed=False 不落库）。已存在
   *  同主键 = 顶替（整行替换：新快照/计数清零/失效标记复位）。落库后按域
   *  执行容量淘汰（达上限淘汰最差条目）。 */
  async upsert(
    fingerprint: string,
    opts: {
      path: Record<string, unknown>;
      evidence_snapshot: readonly Record<string, unknown>[];
      model_id: string;
      gate_passed: boolean;
      path_fingerprint?: string;
      domain?: string;
    },
  ): Promise<boolean> {
    if (!opts.gate_passed) return false; // 入缓存质量线：质量线以下不入缓存
    this.#assertOpen();
    const ts = this.#ts();
    const domain = opts.domain ?? 'default';
    const row: FingerprintCacheRow = {
      context_fingerprint: fingerprint,
      path_data: stable_json(opts.path),
      path_fingerprint: opts.path_fingerprint ?? '',
      evidence_snapshot: stable_json([...opts.evidence_snapshot]),
      contract_snapshot: JSON.stringify(contract_snapshot_from_path(opts.path)),
      model_id: opts.model_id,
      domain,
      created_at: ts,
      updated_at: ts,
      hit_count: 0,
      fail_count: 0,
      invalid: 0,
    };
    try {
      await this.#storage.upsert_row(row);
    } catch (exc) {
      throw new StorageError(`指纹缓存写入失败: ${String(exc)}`);
    }
    this.stats.upserts += 1;
    await this.#evict_if_over_cap(domain);
    return true;
  }

  /** 按主键取有效条目（失效条目不命中——降级不命中而非静默复用）。 */
  async lookup(fingerprint: string): Promise<FingerprintCacheEntry | null> {
    this.#assertOpen();
    this.stats.lookups += 1;
    try {
      const row = await this.#storage.lookup_row(fingerprint);
      return row === null ? null : row_to_entry(row);
    } catch (exc) {
      throw new StorageError(`指纹缓存读取失败: ${String(exc)}`);
    }
  }

  /** 按主键取任意条目（含失效；审计/测试/顶替比较用）。 */
  async get(fingerprint: string): Promise<FingerprintCacheEntry | null> {
    this.#assertOpen();
    try {
      const row = await this.#storage.get_row(fingerprint);
      return row === null ? null : row_to_entry(row);
    } catch (exc) {
      throw new StorageError(`指纹缓存读取失败: ${String(exc)}`);
    }
  }

  /** 标记失效（降级不命中）：计数保留，被顶替/淘汰时移除。reason 在
   *  Python 侧仅用于日志留痕，core 不落（保持同签名）。 */
  async invalidate(fingerprint: string, opts: { reason?: string } = {}): Promise<boolean> {
    this.#assertOpen();
    let updated: boolean;
    try {
      updated = await this.#storage.invalidate_row(fingerprint, this.#ts());
    } catch (exc) {
      throw new StorageError(`指纹缓存失效标记失败: ${String(exc)}`);
    }
    if (updated) this.stats.invalidations += 1;
    return updated;
  }

  /** 缓存路径执行回馈：命中成功 → 命中数+1 并刷新时间戳；命中失败 →
   *  失败数+1 且条目立即失效（不命中），调用方重组装。 */
  async report(fingerprint: string, opts: { ok: boolean }): Promise<boolean> {
    this.#assertOpen();
    let updated: boolean;
    try {
      updated = opts.ok
        ? await this.#storage.report_hit(fingerprint, this.#ts())
        : await this.#storage.report_fail(fingerprint, this.#ts());
    } catch (exc) {
      throw new StorageError(`指纹缓存回馈失败: ${String(exc)}`);
    }
    if (updated) this.stats.reports += 1;
    return updated;
  }

  /** 物理移除（容量淘汰/清理用；派生数据可重建）。 */
  async remove(fingerprint: string): Promise<boolean> {
    this.#assertOpen();
    try {
      return await this.#storage.remove_row(fingerprint);
    } catch (exc) {
      throw new StorageError(`指纹缓存移除失败: ${String(exc)}`);
    }
  }

  /** 条目计数（含失效；domain=null = 全域计数）。 */
  async count(domain: string | null = null): Promise<number> {
    this.#assertOpen();
    try {
      return await this.#storage.count_rows(domain);
    } catch (exc) {
      throw new StorageError(`指纹缓存计数失败: ${String(exc)}`);
    }
  }

  /** 枚举条目（含失效；审计/测试用；按主键升序）。 */
  async entries(domain: string | null = null): Promise<FingerprintCacheEntry[]> {
    this.#assertOpen();
    try {
      return (await this.#storage.list_rows(domain)).map((row) => row_to_entry(row));
    } catch (exc) {
      throw new StorageError(`指纹缓存枚举失败: ${String(exc)}`);
    }
  }

  /** 容量淘汰：域内条目数超上限 → 按「命中率升序 → 时效升序 → 指纹字典序」
   *  淘汰最差条目（确定性序，达标之源与 Python SQL 判据一致）。 */
  async #evict_if_over_cap(domain: string): Promise<void> {
    try {
      const over = (await this.#storage.count_rows(domain)) - this.#cap;
      if (over <= 0) return;
      const victims = (await this.#storage.list_rows(domain))
        .sort((a, b) => {
          const rateA = hit_rate(a);
          const rateB = hit_rate(b);
          if (rateA !== rateB) return rateA < rateB ? -1 : 1;
          if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? -1 : 1;
          return a.context_fingerprint < b.context_fingerprint
            ? -1
            : a.context_fingerprint > b.context_fingerprint
              ? 1
              : 0;
        })
        .slice(0, over);
      for (const victim of victims) {
        await this.#storage.remove_row(victim.context_fingerprint);
      }
      this.stats.evictions += victims.length;
    } catch (exc) {
      throw new StorageError(`指纹缓存淘汰失败: ${String(exc)}`);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#storage.close !== undefined) {
      await this.#storage.close();
    }
  }
}