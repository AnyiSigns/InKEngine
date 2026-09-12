/**
 * 种子 PRNG（mulberry32）。JS 标准库没有可复现 RNG，`Math.random` 的实现与
 * 状态均不可移植，会直接毁掉 G0.1（同 seed 跨进程逐字节相同）。所有世界内随机
 * 一律经 `makeRng(seed)`，禁用 `Math.random`。
 */

export interface Rng {
  /** 下一个无符号 32 位整数。 */
  next(): number;
  /** 闭区间 [lo, hi] 均匀整数。 */
  randint(lo: number, hi: number): number;
  /** 均匀取一个元素；空数组 fail-fast。 */
  choice<T>(arr: readonly T[]): T;
  /** 返回打乱后的新数组（不改入参）。 */
  shuffle<T>(arr: readonly T[]): T[];
  /** [a, b) 均匀浮点。 */
  uniform(a: number, b: number): number;
}

export function makeRng(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new Error(`makeRng: seed must be an integer, got ${String(seed)}`);
  }
  let s = seed >>> 0;

  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return (x ^ (x >>> 14)) >>> 0;
  };

  const choice = <T>(arr: readonly T[]): T => {
    if (arr.length === 0) throw new Error('makeRng.choice: empty array');
    return arr[next() % arr.length]!;
  };

  return {
    next,
    randint(lo: number, hi: number): number {
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) {
        throw new Error(`makeRng.randint: invalid range ${lo}..${hi}`);
      }
      return lo + (next() % (hi - lo + 1));
    },
    choice,
    shuffle<T>(arr: readonly T[]): T[] {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = next() % (i + 1);
        const tmp = a[i]!;
        a[i] = a[j]!;
        a[j] = tmp;
      }
      return a;
    },
    uniform(a: number, b: number): number {
      return a + (next() / 0x100000000) * (b - a);
    },
  };
}
