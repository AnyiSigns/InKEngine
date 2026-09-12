import { describe, expect, it } from 'vitest';

import { canonicalJson, crc32, hash8, hashObj } from '../world/hash.js';
import { makeRng } from '../world/rng.js';

describe('world/hash', () => {
  it('crc32 与 IEEE/zlib 口径一致（已知值）', () => {
    expect(crc32('')).toBe(0);
    expect(crc32('hello')).toBe(907060870);
    expect(crc32('加三')).toBe(1474690540);
  });

  it('canonicalJson：键排序、数字格式固定、-0 归一、CJK 直出', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(0.1)).toBe('0.1');
    expect(canonicalJson(1e-7)).toBe('1e-7');
    expect(canonicalJson('中文')).toBe('"中文"');
  });

  it('canonicalJson 拒绝非有限数', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('hashObj 对同对象稳定、键序无关', () => {
    expect(hashObj({ a: 1, b: [1, 2] })).toBe(hashObj({ b: [1, 2], a: 1 }));
    expect(hashObj(1)).toBe('356a192b7913b04c');
    expect(hashObj(1)).toHaveLength(16);
  });

  it('hash8 = hashObj 前 8 位（B.4 verdict 指纹唯一截断口径）', () => {
    expect(hash8(1)).toBe('356a192b');
    for (const v of [0, -50, 50, 'ABC', '哈'] as const) {
      expect(hash8(v)).toBe(hashObj(v).slice(0, 8));
      expect(hash8(v)).toHaveLength(8);
    }
    expect(hash8(8)).not.toBe(hash8(9));
  });
});

describe('world/rng', () => {
  it('同 seed 逐位可复现', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const xs = Array.from({ length: 8 }, () => a.next());
    const ys = Array.from({ length: 8 }, () => b.next());
    expect(xs).toEqual(ys);
    expect(xs[0]).toBe(2581720956);
  });

  it('randint 闭区间且确定性', () => {
    const r = makeRng(0);
    for (let i = 0; i < 1000; i++) {
      const v = r.randint(-50, 50);
      expect(v).toBeGreaterThanOrEqual(-50);
      expect(v).toBeLessThanOrEqual(50);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('choice 空数组 fail-fast', () => {
    expect(() => makeRng(0).choice([])).toThrow();
  });

  it('shuffle 不改入参', () => {
    const src = [1, 2, 3, 4, 5];
    const out = makeRng(1).shuffle(src);
    expect(src).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual(src);
  });
});
