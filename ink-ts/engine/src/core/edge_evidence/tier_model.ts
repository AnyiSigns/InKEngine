/**
 * 信任档与评分公式（纯算法，零 IO；数据驱动注入常数）。
 *
 * 评分公式：edge_score = p̂ · w_n · d(t) · τ；其中
 *   p̂ = (s+1)/(s+f+2)               拉普拉斯平滑成功率
 *   w_n = max(n,1)/(max(n,1)+H_n)    样本量加权（半饱和点 H_n）
 *   d(t) = exp(-age_days/H_d)        时间衰减（半衰期 H_d 天）
 *   τ ∈ {0.6, 0.8, 1.0}              信任档乘数
 *
 * 策略边（policy=true）恒取 τ=1.0 且豁免时间衰减；种子行（origin=seed）再
 * 乘 SEED_WEIGHT（<1）以实现先验隔离——首次真实成功后 origin 翻为 runtime，
 * 降权解除（真实证据主导）。
 *
 * 数据驱动注入（ENG9b-4/5）：出厂默认 = 模块常量；运行期覆盖经
 * set_decay_half_days / set_seed_weight / set_saturation_n 注入，注入即权威。
 */

import {
  DECAY_HALF_DAYS,
  SATURATION_N,
  SEED_WEIGHT,
  TIER_OBSERVING,
  TIER_PROMOTE_N,
  TIER_PROMOTE_P,
  TIER_REGULAR_N,
  TIER_REGULAR_P,
  TIER_TAU,
  ZERO_EVIDENCE_P,
  ZERO_EVIDENCE_TAU,
  ZERO_EVIDENCE_WEIGHT,
  ORIGIN_SEED,
  ORIGIN_RUNTIME,
} from './_types.js';
import type { EdgeEvidence, EdgeScore } from './_types.js';

// ── 数据驱动注入锚点（注入即权威；不传 = 出厂默认）──
let _decay_half_days = DECAY_HALF_DAYS;
let _seed_weight = SEED_WEIGHT;
let _saturation_n = SATURATION_N;

export function set_decay_half_days(value: number): void {
  _decay_half_days = Number(value);
}

export function get_decay_half_days(): number {
  return _decay_half_days;
}

export function set_seed_weight(value: number): void {
  _seed_weight = Number(value);
}

export function get_seed_weight(): number {
  return _seed_weight;
}

export function set_saturation_n(value: number): void {
  _saturation_n = Number(value);
}

export function get_saturation_n(): number {
  return _saturation_n;
}

/** 拉普拉斯平滑成功率（零证据先验 0.5）。 */
export function laplace_success(success: number, fail: number): number {
  return (success + 1) / (success + fail + 2);
}

/** 样本量加权：max(n,1)/(max(n,1)+H_n)；零证据取 1/(1+H_n) 下界。 */
export function sample_weight(n: number): number {
  const clamped = Math.max(n, 1);
  return clamped / (clamped + get_saturation_n());
}

/** 时间衰减 d(t)=exp(-age_days/H_d)；策略边豁免恒 1.0。 */
export function time_decay(
  age_days: number,
  opts: { exempt?: boolean; decay_half_days?: number | null } = {},
): number {
  if (opts.exempt === true || age_days <= 0) return 1.0;
  const half = opts.decay_half_days === null || opts.decay_half_days === undefined
    ? get_decay_half_days()
    : opts.decay_half_days;
  return Math.exp(-age_days / half);
}

/** 信任档推导：观察 N<8 / 常规 N≥8 且 p̂≥0.7 / 转正 N≥30 且 p̂≥0.9。 */
export function derive_edge_tier(success: number, fail: number): string {
  const n = success + fail;
  const p = laplace_success(success, fail);
  if (n >= TIER_PROMOTE_N && p >= TIER_PROMOTE_P) return 'promoted';
  if (n >= TIER_REGULAR_N && p >= TIER_REGULAR_P) return 'regular';
  return TIER_OBSERVING;
}

/** 信任档 → τ 乘数；未知档回落观察档。 */
export function tier_tau(tier: string): number {
  const v = TIER_TAU[tier];
  return v === undefined ? TIER_TAU[TIER_OBSERVING]! : v;
}

/** 零证据候选边评分（先验下界）：p̂=0.5 · w_n=1/(1+H_n) · d(t)=1 · τ=0.6。 */
export function zero_evidence_score(): number {
  return ZERO_EVIDENCE_P * ZERO_EVIDENCE_WEIGHT * 1.0 * ZERO_EVIDENCE_TAU;
}

/** 评分入口（公式 + 默认常数 = 引擎机制；使用方仅覆盖常数权）。 */
export function edge_score(
  evidence: EdgeEvidence | null,
  opts: {
    success?: number | null;
    fail?: number | null;
    age_days?: number | null;
    now?: number | null;
    decay_half_days?: number | null;
  } = {},
): EdgeScore {
  if (evidence === null) {
    const score = zero_evidence_score();
    return {
      score,
      p: ZERO_EVIDENCE_P,
      weight: ZERO_EVIDENCE_WEIGHT,
      decay: 1.0,
      tau: ZERO_EVIDENCE_TAU,
      tier: TIER_OBSERVING,
    };
  }
  const s = opts.success === null || opts.success === undefined ? evidence.success_count : opts.success;
  const f = opts.fail === null || opts.fail === undefined ? evidence.fail_count : opts.fail;
  const tier = derive_edge_tier(s, f);
  const tau = evidence.policy ? TIER_TAU['promoted']! : tier_tau(tier);
  const p = laplace_success(s, f);
  const weight = sample_weight(s + f);
  let age_days: number;
  if (opts.age_days === null || opts.age_days === undefined) {
    const ts = opts.now === null || opts.now === undefined ? Date.now() / 1000 : opts.now;
    const last = evidence.last_used_at ?? evidence.created_at;
    age_days = Math.max(0, (ts - last) / 86400);
  } else {
    age_days = opts.age_days;
  }
  const decay = time_decay(age_days, {
    exempt: evidence.policy,
    decay_half_days: opts.decay_half_days,
  });
  let score = p * weight * decay * tau;
  const origin = evidence.origin ?? ORIGIN_RUNTIME;
  if (origin === ORIGIN_SEED && !evidence.policy) {
    score *= get_seed_weight();
  }
  return { score, p, weight, decay, tau, tier };
}