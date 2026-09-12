/**
 * 覆盖集构造测试（从 tests/generator.test.ts 拆出以满足单文件 ≤350 行纪律）。
 *
 * makeCoverageSplitInfo 的可判定覆盖声明：follow 全域每骨架 × 族恰 1 条；goal 域族
 * 只走适格池（R2-P0-2），不适格骨架以键（与 UNPRODUCIBLE_HELDOUT 同口径）与
 * 清单+计数双形式显式上报，不静默；产出对同 seed 逐字确定；适格但产不出该切分
 * 即抛错（fail-fast）。注册表判定本身见 tests/producibility.test.ts，守卫直测见
 * tests/guards.test.ts。
 */

import { describe, expect, it } from 'vitest';

import {
  coverageKey,
  goalEligible,
  instanceTask,
  makeCoverageSplit,
  makeCoverageSplitInfo,
  SKELETONS,
  splitOf,
  UNPRODUCIBLE_HELDOUT,
  _skelId,
  type Skel,
} from '../gen/generator.js';
import { makeRng } from '../world/rng.js';
import { taskHash, type Task } from '../schema.js';

describe('gen/generator/makeCoverageSplit（goal 域适格池覆盖集，R2-P0-2）', () => {
  const heldout = SKELETONS.filter((sk) => splitOf(sk) === 'heldout');

  it('follow 域：全部 heldout 骨架 × {value, verify} 均可产（重试逐次推进 seed）', () => {
    for (const sk of heldout) {
      for (const fam of ['value', 'verify'] as const) {
        let ok = false;
        for (let attempt = 0; attempt < 10 && !ok; attempt++) {
          const t = instanceTask(makeRng(99 + attempt), sk.root, sk.plan, fam, 'follow');
          ok = t !== null && t.split === 'heldout';
        }
        expect(ok, `骨架 ${_skelId(sk)} follow/${fam}`).toBe(true);
      }
    }
  }, 120_000);

  it('goal 域：适格池抽样必产（重试推进 seed），且产出对同 seed 逐字确定', () => {
    // 覆盖声明的可判定论域 = heldout ∩ 适格池；重试如用同一 seed 只是确定性空转，
    // 逐次推进 seed 才有重试语义。
    const sample = heldout
      .filter((sk) => goalEligible(sk.root, sk.plan))
      .slice(0, 24);
    let goalTasks = 0;
    for (const sk of sample) {
      for (const fam of ['goal', 'goal_verify'] as const) {
        let produced: { task: Task; seed: number } | null = null;
        for (let attempt = 0; attempt < 10 && produced === null; attempt++) {
          const seed = 99 + attempt;
          const t = instanceTask(makeRng(seed), sk.root, sk.plan, fam, 'goal');
          if (t !== null && t.split === 'heldout') produced = { task: t, seed };
        }
        expect(produced, `适格骨架 ${_skelId(sk)} goal/${fam} 未能在预算内产出`).not.toBeNull();
        goalTasks++;
        const again = instanceTask(makeRng(produced!.seed), sk.root, sk.plan, fam, 'goal');
        expect(JSON.stringify(again), `骨架 ${_skelId(sk)} goal/${fam} 同 seed 确定性`).toBe(
          JSON.stringify(produced!.task),
        );
      }
    }
    expect(goalTasks).toBe(sample.length * 2);
  }, 120_000);

  it('heldout 全量冒烟（固定 seed）：follow 全域 + goal 适格域每骨架每 (style,family) 恰 1 条、不适格计数显式带出、不抛错', () => {
    const info = makeCoverageSplitInfo('heldout', 0);
    expect(info.unproducibleCount).toBe(UNPRODUCIBLE_HELDOUT.size);
    expect(new Set(info.unproducible).size).toBe(info.unproducible.length);
    expect([...info.unproducible].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(
      [...UNPRODUCIBLE_HELDOUT].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    // 不适格骨架显式上报：goal 域两族共用同一适格性判定 → ineligible 清单与
    // 注册表键一一对应（×2 族），且逐骨架可由 goalEligible 独立复算。
    expect(info.ineligibleCount).toBe(info.unproducible.length / 2);
    const heldoutEligible = new Map(heldout.map((sk) => [_skelId(sk), goalEligible(sk.root, sk.plan)]));
    const expectedIneligible = [...heldoutEligible].filter(([, ok]) => !ok).map(([id]) => id).sort();
    expect([...info.ineligible].sort()).toEqual(expectedIneligible);
    expect(info.ineligibleCount).toBe(210);
    const counts = new Map<string, number>();
    for (const t of info.tasks) {
      const k = coverageKey(t.style, t.family, t.composition_id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of counts) expect(n, `${k} 重复覆盖`).toBe(1);
    const heldoutIds = new Set(heldout.map(_skelId));
    let producedGoalCombos = 0;
    for (const id of heldoutIds) {
      for (const fam of ['value', 'verify'] as const) {
        expect(counts.get(coverageKey('follow', fam, id)), `follow/${fam}/${id}`).toBe(1);
      }
      for (const fam of ['goal', 'goal_verify'] as const) {
        const ineligible = UNPRODUCIBLE_HELDOUT.has(coverageKey('goal', fam, id));
        expect(counts.has(coverageKey('goal', fam, id)), `goal/${fam}/${id}`).toBe(!ineligible);
        producedGoalCombos += ineligible ? 0 : 1;
      }
    }
    expect(info.tasks.length).toBe(heldoutIds.size * 2 + producedGoalCombos);
    expect(makeCoverageSplit('heldout', 0).map(taskHash)).toEqual(info.tasks.map(taskHash));
  }, 180_000);

  it('fail-fast：适格但 50 次重试仍产不出该切分即抛错（注入切分不匹配的适格骨架）', () => {
    // [add3] 在 Int gt0 目标下适格（如 x=-1 初始不达 gt0 终值 2 达标），但把它的实例
    // 放进 'val' 覆盖池（其真实切分是 train）→ 每次产出 split 都不等于 'val' → 抛错，
    // 覆盖「适格池通过但同骨架重试耗尽仍无该切分任务」的 fail-fast 分支（不静默降级）。
    const sk: Skel = { root: 'Int', plan: ['add3'] };
    expect(goalEligible(sk.root, sk.plan)).toBe(true);
    expect(splitOf(sk)).not.toBe('val');
    expect(() => makeCoverageSplitInfo('val', 0, [sk])).toThrow(/yields no task/);
  }, 60_000);
});
