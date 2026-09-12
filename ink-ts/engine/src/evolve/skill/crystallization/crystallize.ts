/**
 * 指纹缓存自动结晶 + 沉淀钩子（skill_crystal.py crystallize_from_cache /
 * SkillCrystallizeHook 移植）：从指纹缓存沉淀已达标条目自动结晶为可分享
 * 技能。零 LLM：纯算法读缓存 entries，达「命中数 ≥ N 且命中率 ≥ 阈值」
 * 即结晶，阈值可配置；未注入缓存/技能存储 = fail-closed 不结晶。
 *
 * 缓存条目为 duck 面（指纹缓存域未导入，形状与其 FingerprintCacheEntry
 * 对齐）：只消费结晶所需字段（invalid/hit/fail/path/指纹/域/模型/快照）。
 */

import {
  SKILL_HIT_MIN_DEFAULT,
  SKILL_SUCCESS_RATE_DEFAULT,
} from './_types.js';
import {
  build_test_report,
  classify_skill_kind,
  _skill_name,
  _success_rate,
} from './mechanism.js';
import { SkillEntry } from './skill_entry.js';

/** 结晶所消费的缓存条目面（与指纹缓存 FingerprintCacheEntry 同形）。 */
export interface CacheEntryLike {
  invalid: boolean;
  hit_count: number;
  fail_count: number;
  path_fingerprint: string;
  domain: string;
  path: Record<string, unknown>;
  contract_snapshot: readonly (readonly [string, string])[];
  evidence_snapshot: readonly Record<string, unknown>[];
  model_id: string;
}

/** 缓存存储面（entries() 枚举，domain 过滤可选——与指纹缓存存储同构）。 */
export interface CacheEntrySource {
  entries(domain?: string | null): Promise<readonly CacheEntryLike[]>;
}

/** 技能存储面（结晶只写 upsert 与读去重 get_by_fingerprint）。 */
export interface SkillStoreLike {
  get_by_fingerprint(fingerprint: string): Promise<SkillEntry | null>;
  upsert(entry: SkillEntry): Promise<void>;
}

/** crystallize_from_cache 选项（阈值 + 时间 seam；now 缺省确定值 0）。 */
export interface CrystallizeOptions {
  hit_min?: number;
  success_rate?: number;
  now?: number | null;
}

/**
 * 从指纹缓存自动结晶技能（读 entries，命中数/命中率双阈值达标即结晶）。
 *
 * 去重：同指纹技能已存在且计数与指纹均未变化 = 跳过；否则版本递增重写
 * （保留历史版本可追溯）。返回本次新结晶/更新的技能名清单。视觉路径经
 * classify_skill_kind 标记为 visual，结晶同构。
 *
 * 调用方须传入指纹缓存存储与技能存储；任一为 null = fail-closed 不结晶。
 */
export async function crystallize_from_cache(
  cache_store: CacheEntrySource | null,
  skill_store: SkillStoreLike | null,
  opts: CrystallizeOptions = {},
): Promise<string[]> {
  if (cache_store === null || cache_store === undefined || skill_store === null || skill_store === undefined) {
    return [];
  }
  const ts = opts.now ?? 0;
  const hitMin = opts.hit_min ?? SKILL_HIT_MIN_DEFAULT;
  const successRate = opts.success_rate ?? SKILL_SUCCESS_RATE_DEFAULT;
  const created: string[] = [];
  for (const entry of await cache_store.entries()) {
    if (entry.invalid) continue;
    if (entry.hit_count < hitMin) continue;
    const rate = _success_rate(entry.hit_count, entry.fail_count);
    if (rate < successRate) continue;
    const kind = classify_skill_kind(entry.path);
    const name = _skill_name(entry.path_fingerprint, entry.domain, kind);
    const existing = await skill_store.get_by_fingerprint(entry.path_fingerprint);
    if (
      existing !== null &&
      existing.hit_count === entry.hit_count &&
      existing.fail_count === entry.fail_count &&
      existing.fingerprint === entry.path_fingerprint
    ) {
      continue;
    }
    const version = existing !== null ? existing.version + 1 : 1;
    const report = build_test_report({
      name,
      version,
      domain: entry.domain,
      model_id: entry.model_id,
      hit_count: entry.hit_count,
      fail_count: entry.fail_count,
      success_rate: rate,
      evidence_snapshot: entry.evidence_snapshot,
      kind,
      now: ts,
    });
    const skill = new SkillEntry({
      name,
      version,
      domain: entry.domain,
      fingerprint: entry.path_fingerprint,
      kind,
      path: { ...entry.path },
      contract_snapshot: entry.contract_snapshot,
      evidence_snapshot: entry.evidence_snapshot,
      model_id: entry.model_id,
      hit_count: entry.hit_count,
      fail_count: entry.fail_count,
      test_report: report,
      source_path: entry.path_fingerprint,
      created_at: ts,
      updated_at: ts,
    });
    await skill_store.upsert(skill);
    created.push(name);
  }
  return created;
}

/** 低频兜底扫描间隔（未检测到内容变化时也周期性重扫，兜底外部直写）。 */
export const CRYSTALLIZE_SCAN_INTERVAL = 32;

/** SkillCrystallizeHook 构造选项（与结晶阈值同源，可配置）。 */
export interface SkillCrystallizeHookOptions {
  hit_min?: number;
  success_rate?: number;
  /** 内容变更源（缓存写/命中回馈计数标量；注入后做水位门控——未变化
   *  回合不重扫 entries，避免每回合全库 list_records + JSON.parse）。 */
  mutation_source?: (() => number) | null;
  /** 低频兜底扫描间隔（变化未检测到时每 N 回合强制重扫一次）。 */
  scan_interval?: number;
}

/**
 * 沉淀后处理：指纹缓存达标条目自动结晶为技能（FingerprintSettleHook 后继）。
 *
 * 零 LLM：纯算法读缓存 entries，达「命中数 ≥ N 且命中率 ≥ 阈值」即结晶，
 * 阈值可配置。未注入缓存/技能存储 = fail-closed 不结晶（与指纹缓存同纪律）。
 *
 * 扫描门控（R7-4）：注入 mutation_source 后按水位跳过未变化回合——内容
 * （写/命中回馈计数）与上次扫描一致 = 不重扫 entries（零 DB 读零解析）；
 * 变化才重扫，另以低频间隔兜底外部直写（不经本钩子计数源的变更）。
 */
export class SkillCrystallizeHook {
  readonly #cache_store: CacheEntrySource | null;
  readonly #skill_store: SkillStoreLike | null;
  readonly #hit_min: number;
  readonly #success_rate: number;
  readonly #mutation_source: (() => number) | null;
  readonly #scan_interval: number;
  /** 上次实际扫描时的内容计数（水位基准；NaN = 尚未扫过 → 首轮必扫）。 */
  #last_mutations = Number.NaN;
  /** 距上次实际扫描的回合数（低频兜底用）。 */
  #rounds_since_scan = 0;
  /** 本次 run 结晶的技能名（供测试断言自动结晶语义）。 */
  crystallized: string[] = [];

  constructor(
    cache_store: CacheEntrySource | null,
    skill_store: SkillStoreLike | null,
    opts: SkillCrystallizeHookOptions = {},
  ) {
    this.#cache_store = cache_store;
    this.#skill_store = skill_store;
    this.#hit_min = opts.hit_min ?? SKILL_HIT_MIN_DEFAULT;
    this.#success_rate = opts.success_rate ?? SKILL_SUCCESS_RATE_DEFAULT;
    this.#mutation_source = opts.mutation_source ?? null;
    this.#scan_interval = Math.max(1, opts.scan_interval ?? CRYSTALLIZE_SCAN_INTERVAL);
  }

  /** 距上次扫描的回合数（观测侧；测试断言低频兜底用）。 */
  get rounds_since_scan(): number {
    return this.#rounds_since_scan;
  }

  async settle(_ctx: unknown): Promise<void> {
    if (this.#cache_store === null || this.#skill_store === null) return;
    const source = this.#mutation_source;
    if (source !== null) {
      const current = source();
      this.#rounds_since_scan += 1;
      const changed = current !== this.#last_mutations;
      const due = this.#rounds_since_scan >= this.#scan_interval;
      if (!changed && !due) {
        this.crystallized = [];
        return; // 未变化回合不扫描（水位门控，零 DB 读）
      }
      this.#last_mutations = current;
      this.#rounds_since_scan = 0;
    }
    this.crystallized = await crystallize_from_cache(
      this.#cache_store,
      this.#skill_store,
      {
        hit_min: this.#hit_min,
        success_rate: this.#success_rate,
      },
    );
  }
}
