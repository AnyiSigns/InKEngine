/**
 * 边证据评分公式与档位推导单测（对标 ink_engine/tests/test_edge_evidence.py
 * 评分段）：单调性、τ 档位序、零证据下界、信任档推导。
 */

import { describe, expect, it } from 'vitest';

import {
  derive_edge_tier,
  edge_score,
  laplace_success,
  sample_weight,
  time_decay,
  zero_evidence_score,
} from '../../../src/core/edge_evidence/tier_model.js';
import {
  TIER_OBSERVING,
  TIER_PROMOTED,
  TIER_REGULAR,
  TIER_TAU,
  ZERO_EVIDENCE_WEIGHT,
} from '../../../src/core/edge_evidence/_types.js';
import {
  cold_start_index,
  is_exploration_mode,
  multi_path_trigger,
} from '../../../src/core/edge_evidence/derived.js';
import { EXPLORATION_INDEX_THRESHOLD, MULTIPATH_GAP } from '../../../src/core/edge_evidence/_types.js';
import { makeCandidate, makeEvidence, NOW } from './helpers.js';

describe('Score formula monotonicity', () => {
  it('higher success rate raises score (Laplace smooth)', () => {
    const low = edge_score(makeEvidence(4, 4), { now: NOW }).score;
    const high = edge_score(makeEvidence(6, 2), { now: NOW }).score;
    expect(high).toBeGreaterThan(low);
  });

  it('more samples raises score (half-saturation)', () => {
    const s1 = edge_score(makeEvidence(2, 0), { now: NOW }).score;
    const s2 = edge_score(makeEvidence(8, 0), { now: NOW }).score;
    const s3 = edge_score(makeEvidence(30, 0), { now: NOW }).score;
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it('greater age lowers score (30d half-life)', () => {
    const fresh = edge_score(makeEvidence(10, 0, { last_used: NOW }), { now: NOW }).score;
    const old = edge_score(makeEvidence(10, 0, { last_used: NOW - 60 * 86400 }), { now: NOW }).score;
    expect(old).toBeLessThan(fresh);
  });

  it('policy edge exempts time decay', () => {
    const old = edge_score(
      makeEvidence(10, 0, { policy: true, last_used: NOW - 365 * 86400 }),
      { now: NOW },
    );
    const fresh = edge_score(makeEvidence(10, 0, { policy: true, last_used: NOW }), { now: NOW });
    expect(old.decay).toBe(1.0);
    expect(old.score).toBeCloseTo(fresh.score);
  });

  it('tau ordering 0.6<0.8<1.0', () => {
    const taus = [
      TIER_TAU[TIER_OBSERVING]!,
      TIER_TAU[TIER_REGULAR]!,
      TIER_TAU[TIER_PROMOTED]!,
    ];
    expect(taus).toEqual([0.6, 0.8, 1.0]);
  });

  it('zero-evidence weight = 1/9 prior floor', () => {
    expect(sample_weight(0)).toBeCloseTo(ZERO_EVIDENCE_WEIGHT);
    expect(zero_evidence_score()).toBeCloseTo(
      laplace_success(0, 0) * ZERO_EVIDENCE_WEIGHT * 1.0 * TIER_TAU[TIER_OBSERVING]!,
    );
    expect(zero_evidence_score()).toBeCloseTo(1 / 30);
  });

  it('30-day half-life boundary', () => {
    expect(time_decay(30)).toBeCloseTo(Math.exp(-1));
    expect(time_decay(0)).toBe(1.0);
    expect(time_decay(30, { exempt: true })).toBe(1.0);
  });
});

describe('Tier derivation boundaries', () => {
  it('N=7 observing; N=8 with p_hat=0.7 regular', () => {
    expect(derive_edge_tier(7, 0)).toBe(TIER_OBSERVING);
    expect(derive_edge_tier(6, 2)).toBe(TIER_REGULAR);
    expect(laplace_success(6, 2)).toBeCloseTo(0.7);
    expect(derive_edge_tier(5, 3)).toBe(TIER_OBSERVING);
    expect(derive_edge_tier(26, 3)).toBe(TIER_REGULAR);
    expect(derive_edge_tier(26, 4)).toBe(TIER_REGULAR);
    expect(derive_edge_tier(28, 2)).toBe(TIER_PROMOTED);
  });

  it('auto-promotion requires no approval', () => {
    expect(derive_edge_tier(28, 2)).toBe(TIER_PROMOTED);
    expect(TIER_TAU[derive_edge_tier(28, 2)!]).toBe(1.0);
  });
});

describe('Multi-path trigger', () => {
  it('insufficient samples trigger (N<5)', () => {
    expect(multi_path_trigger(makeCandidate(2, 2), makeCandidate(1, 1), { now: NOW })).toBe(true);
    expect(multi_path_trigger(makeCandidate(4, 0), makeCandidate(2, 1), { now: NOW })).toBe(true);
    expect(multi_path_trigger(makeCandidate(1, 0), makeCandidate(4, 0), { now: NOW })).toBe(true);
  });

  it('missing candidate triggers (null)', () => {
    expect(multi_path_trigger(null, null, { now: NOW })).toBe(true);
    expect(multi_path_trigger(makeCandidate(5, 0), null, { now: NOW })).toBe(true);
  });

  it('gap 0.15 boundary: <0.15 triggers, >=0.15 does not', () => {
    expect(multi_path_trigger(makeCandidate(5, 0), makeCandidate(5, 0), { now: NOW })).toBe(true);
    const strong = makeCandidate(30, 0);
    const weak = makeCandidate(5, 0);
    const gap = edge_score(strong, { now: NOW }).score - edge_score(weak, { now: NOW }).score;
    expect(gap).toBeGreaterThanOrEqual(MULTIPATH_GAP);
    expect(multi_path_trigger(strong, weak, { now: NOW })).toBe(false);
    const c1 = makeCandidate(5, 1);
    const c2 = makeCandidate(6, 1);
    const gap2 = edge_score(c1, { now: NOW }).score - edge_score(c2, { now: NOW }).score;
    expect(gap2).toBeLessThan(MULTIPATH_GAP);
    expect(multi_path_trigger(c1, c2, { now: NOW })).toBe(true);
  });

  it('N=4 always triggers; N=5 with strong evidence does not', () => {
    expect(multi_path_trigger(makeCandidate(4, 0), makeCandidate(4, 0), { now: NOW })).toBe(true);
    expect(multi_path_trigger(makeCandidate(5, 0), makeCandidate(30, 0), { now: NOW })).toBe(false);
  });
});

describe('Cold-start index', () => {
  it('boundary 0.3; zero candidate -> 0; overshoot capped at 1', () => {
    expect(cold_start_index(0, 10)).toBe(0.0);
    expect(cold_start_index(2, 10)).toBe(0.2);
    expect(is_exploration_mode(0.299)).toBe(true);
    expect(is_exploration_mode(0.3)).toBe(false);
    expect(is_exploration_mode(0.9)).toBe(false);
    expect(EXPLORATION_INDEX_THRESHOLD).toBe(0.3);
    expect(cold_start_index(0, 0)).toBe(0.0);
    expect(is_exploration_mode(cold_start_index(0, 0))).toBe(true);
    expect(cold_start_index(12, 10)).toBe(1.0);
  });
});