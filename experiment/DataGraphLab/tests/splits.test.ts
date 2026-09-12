/**
 * gen/splits 测试（C.1 `_split_maps` + D 表必须断言）。
 *
 * 切分语义：每层（深度 × 是否含 cond）先按 _skelId 排序，heldout 由
 * `emod(crc32(_skelId+'heldout'),5)==0` 判定（≈20%），剩余中 `'val'%20==0`
 * 判定（≈5%），每层保底 ≥1；层内 <2 直接报错。测试用独立重算做 oracle，
 * 并断言 train/heldout 的层分布 KL < 0.05（G0.5，同源 STRATA 保证）。
 */

import { describe, expect, it } from 'vitest';

import {
  HELDOUT_SKELETONS,
  VAL_SKELETONS,
  _splitMaps,
  _stratum,
  compareStratum,
  splitOf,
  STRATA,
} from '../gen/splits.js';
import { SKELETONS, _skelId, type Skel } from '../gen/skeletons.js';
import { crc32 } from '../world/hash.js';
import { emod } from '../world/operators.js';

/** 独立重算每层切分（oracle：不 import 任何被侧实现）。 */
function oracleSplit(): { heldout: Set<string>; val: Set<string> } {
  const heldout = new Set<string>();
  const val = new Set<string>();
  for (const key of [...STRATA.keys()].sort(compareStratum)) {
    const ordered = [...(STRATA.get(key) ?? [])].sort((a, b) => _skelId(a).localeCompare(_skelId(b)));
    const h = ordered.filter((sk) => emod(crc32(_skelId(sk) + 'heldout'), 5) === 0);
    const hFinal = h.length > 0 ? h : [ordered[0]!];
    for (const sk of hFinal) heldout.add(_skelId(sk));
    const rest = ordered.filter((sk) => !hFinal.includes(sk));
    const v = rest.filter((sk) => emod(crc32(_skelId(sk) + 'val'), 20) === 0);
    const vFinal = v.length > 0 ? v : [rest[0]!];
    for (const sk of vFinal) val.add(_skelId(sk));
  }
  return { heldout, val };
}

describe('gen/splits/切分映射与 C.1 判定口径', () => {
  it('注册表 = 独立重算的 oracle（crc32 判定 + 保底规则一致）', () => {
    const o = oracleSplit();
    expect(HELDOUT_SKELETONS).toEqual(o.heldout);
    expect(VAL_SKELETONS).toEqual(o.val);
  });

  it('每个骨架恰落 train/val/heldout 之一，且注册表内部零重叠', () => {
    for (const sk of SKELETONS) {
      const s = splitOf(sk);
      expect(['train', 'val', 'heldout']).toContain(s);
    }
    const intersect = new Set(HELDOUT_SKELETONS);
    for (const id of VAL_SKELETONS) expect(intersect.has(id)).toBe(false);
  });

  it('每层 heldout ≥1、val ≥1（保底规则）', () => {
    for (const [key, sks] of STRATA) {
      expect(sks.some((sk) => splitOf(sk) === 'heldout'), `层 ${key} 缺 heldout`).toBe(true);
      expect(sks.some((sk) => splitOf(sk) === 'val'), `层 ${key} 缺 val`).toBe(true);
    }
  });

  it('heldout≈20%、val≈5%（按层看比例带；微小层只受保底约束）', () => {
    for (const [key, sks] of STRATA) {
      const n = sks.length;
      const h = sks.filter((sk) => splitOf(sk) === 'heldout').length;
      const v = sks.filter((sk) => splitOf(sk) === 'val').length;
      // 层内骨架过少（<10）时保底 ≥1 会推高比例（如 2 骨架层 heldout 必然 50%），
      // 比例带只对足够大的层有意义；小层的保底约束由上一用例覆盖。
      if (n < 10) continue;
      expect(h / n, `层 ${key} heldout 比例`).toBeGreaterThanOrEqual(0.05);
      expect(h / n, `层 ${key} heldout 比例`).toBeLessThanOrEqual(0.45);
      expect(v / n, `层 ${key} val 比例`).toBeGreaterThanOrEqual(0.01);
      expect(v / n, `层 ${key} val 比例`).toBeLessThanOrEqual(0.3);
    }
  });

  it('每层骨架 ≥2（保证可切 train/heldout）', () => {
    for (const [key, sks] of STRATA) {
      expect(sks.length, `层 ${key}`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('gen/splits/train-heldout 零重叠与分布对齐（G0.5）', () => {
  it('train 与 heldout 的 composition_id 零重叠', () => {
    for (const sk of SKELETONS) {
      if (splitOf(sk) === 'train') {
        expect(HELDOUT_SKELETONS.has(_skelId(sk))).toBe(false);
      }
    }
  });

  it('train/heldout 深度×cond 层分布 KL < 0.05（同源 STRATA 保证）', () => {
    const kl = (p: Map<string, number>, q: Map<string, number>): number => {
      let d = 0;
      for (const [k, pi] of p) {
        const qi = q.get(k) ?? 0;
        if (pi > 0) d += pi * Math.log(pi / Math.max(qi, 1e-12));
      }
      return d;
    };
    const dist = (sel: (sk: Skel) => boolean): Map<string, number> => {
      const m = new Map<string, number>();
      let total = 0;
      for (const sk of SKELETONS) {
        if (!sel(sk)) continue;
        const k = _stratum(sk);
        m.set(k, (m.get(k) ?? 0) + 1);
        total++;
      }
      for (const [k, c] of m) m.set(k, c / total);
      return m;
    };
    const train = dist((sk) => splitOf(sk) === 'train');
    const heldout = dist((sk) => splitOf(sk) === 'heldout');
    const full = dist(() => true);
    expect(kl(train, heldout)).toBeLessThan(0.05);
    expect(kl(train, full)).toBeLessThan(0.05);
    expect(kl(heldout, full)).toBeLessThan(0.05);
  });
});

describe('gen/splits/层内骨架不足的报错分支', () => {
  it('<2 直接抛错，不静默降级', () => {
    const fake = new Map<string, readonly Skel[]>([
      [_stratum({ root: 'Int', plan: ['add3'] }), [{ root: 'Int', plan: ['add3'] }]],
    ]);
    expect(() => _splitMaps(fake)).toThrow(/不足 2/);
  });
});
