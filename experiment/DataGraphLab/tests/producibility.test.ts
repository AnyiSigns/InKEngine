/**
 * gen/producibility 测试（适格性注册表薄层 + 单步捷径判定）。
 *
 * 断言：GOAL_PROBE_GOALS 与 sampleGoal 采样空间防漂移；注册表键仅 goal 两族
 * （由 goalEligible 派生的 heldout 视图，follow 零键）、规模与实测 210/829 一致、
 * 与 live goalEligible 完全等价；注册表成员经独立判定池 × 全域 witness 穷举零
 * 「初始不达标∧终值达标」候选（独立 oracle，不 import 被测判定实现），且 goal
 * 两族实例化恒零产出；適格（非注册表）heldout 骨架 goal 两族必在重试预算内产出；
 * hasOneStepSolution 对 value/goal/verify 族的正/负判据。
 */

import { describe, expect, it } from 'vitest';

import {
  coverageKey,
  GOAL_PROBE_GOALS,
  goalEligible,
  hasOneStepSolution,
  UNPRODUCIBLE_HELDOUT,
} from '../gen/producibility.js';
import { SKELETONS, _skelId, type Skel } from '../gen/skeletons.js';
import { HELDOUT_SKELETONS, splitOf } from '../gen/splits.js';
import { instanceGoal, instanceTask, sampleGoal } from '../gen/generator.js';
import { GRAPH } from '../runner/graph.js';
import { initState, runPlan } from '../world/operators.js';
import { makeRng } from '../world/rng.js';
import { goalOk, type Goal } from '../world/goal.js';
import type { Task } from '../schema.js';

/** 独立判定池（字面誊写 C.1 采样词表，不 import 被测实现）：Int 5 单体 + 25 合取。 */
function oraclePoolInt(): Goal[] {
  const singles: Goal[] = [
    { kind: 'parity', target: 0 },
    { kind: 'parity', target: 1 },
    { kind: 'gt', target: 0 },
    { kind: 'gt', target: 5 },
    { kind: 'gt', target: 20 },
  ];
  const out: Goal[] = [...singles];
  for (const a of singles) {
    for (const b of singles) out.push({ kind: 'all', of: [a, b] });
  }
  return out;
}

function oraclePoolStr(): Goal[] {
  const out: Goal[] = [];
  for (const min of [1, 2]) for (const max of [3, 4, 5]) out.push({ kind: 'len', min, max });
  return out;
}

/** 把 goal 摊平为单体集合（合取达标 ⇒ 某子句在初始不达标处单独成立）。 */
function flatten(goal: Goal): Goal[] {
  return goal.kind === 'all' ? [...flatten(goal.of[0]!), ...flatten(goal.of[1]!)] : [goal];
}

describe('gen/producibility/GOAL_PROBE_GOALS（适格判定池防漂移）', () => {
  it('判定池恰为 C.1 七项；每项都在 sampleGoal Int/Str 采样空间的可采单体集内', () => {
    expect(GOAL_PROBE_GOALS.map((g) => JSON.stringify(g))).toEqual(
      [
        { kind: 'parity', target: 0 },
        { kind: 'parity', target: 1 },
        { kind: 'gt', target: 0 },
        { kind: 'gt', target: 5 },
        { kind: 'gt', target: 20 },
        { kind: 'len', min: 1, max: 3 },
        { kind: 'len', min: 2, max: 5 },
      ].map((g) => JSON.stringify(g)),
    );
    const intSingles = new Set<string>();
    const strSingles = new Set<string>();
    for (let s = 0; s < 4000; s++) {
      for (const g of flatten(sampleGoal(makeRng(s), 'Int'))) intSingles.add(JSON.stringify(g));
      for (const g of flatten(sampleGoal(makeRng(s), 'Str'))) strSingles.add(JSON.stringify(g));
    }
    for (const g of GOAL_PROBE_GOALS) {
      const key = JSON.stringify(g);
      // 词表漂移（阈值/端点改动）会在这里炸：判定池项必须采样可达。
      const reachable =
        g.kind === 'len' ? strSingles.has(key) : intSingles.has(key);
      expect(reachable, `判定池项 ${key} 不在 sampleGoal 可采域`).toBe(true);
    }
  });
});

describe('gen/producibility/UNPRODUCIBLE_HELDOUT（goalEligible 派生的薄层注册表）', () => {
  it('键合法：仅 goal 两族（follow 零键）、两族对称、composition_id 全落 heldout 骨架', () => {
    const keys = [...UNPRODUCIBLE_HELDOUT];
    expect(keys.some((k) => k.startsWith('follow:'))).toBe(false);
    const ids = new Set<string>();
    for (const k of keys) {
      const [style, fam, id] = k.split(':');
      expect(style).toBe('goal');
      expect(['goal', 'goal_verify']).toContain(fam!);
      expect(HELDOUT_SKELETONS.has(id!)).toBe(true);
      ids.add(id!);
    }
    expect(keys.length).toBe(ids.size * 2);
    expect(ids.size).toBeGreaterThan(0);
  });

  it('规模与实测一致：210 不适格骨架 × 2 族 = 420 键（heldout 210/829）', () => {
    const heldoutN = SKELETONS.filter((sk) => splitOf(sk) === 'heldout').length;
    expect(heldoutN).toBe(829);
    expect(UNPRODUCIBLE_HELDOUT.size).toBe(420);
    expect(UNPRODUCIBLE_HELDOUT.size).toBe(210 * 2);
  });

  it('薄层等价：注册表 goal 键 ⟺ heldout ∧ ¬goalEligible（注册表不得有第二套判定）', () => {
    for (const sk of SKELETONS) {
      const id = _skelId(sk);
      if (!HELDOUT_SKELETONS.has(id)) continue;
      const inRegistry = UNPRODUCIBLE_HELDOUT.has(coverageKey('goal', 'goal', id));
      expect(inRegistry, `${sk.root}:${sk.plan.join(',')}`).toBe(!goalEligible(sk.root, sk.plan));
    }
  });
});

describe('gen/producibility/goalEligible（独立全域穷举复核）', () => {
  it('抽样注册表成员：独立判定池 × 全域 witness 穷举零「初始不达标∧终值达标」候选', () => {
    const byId = new Map(SKELETONS.map((sk) => [_skelId(sk), sk]));
    const poolStr = oraclePoolStr();
    const sampled = [...UNPRODUCIBLE_HELDOUT]
      .filter((k) => k.startsWith('goal:goal:'))
      .sort()
      .slice(0, 16)
      .map((k) => byId.get(k.slice('goal:goal:'.length))!);
    expect(sampled.length).toBe(16);
    for (const sk of sampled) {
      const pool = sk.root === 'Int' ? oraclePoolInt() : poolStr;
      const witnesses: (number | string)[] =
        sk.root === 'Int'
          ? Array.from({ length: 101 }, (_, i) => i - 50)
          : Array.from({ length: 8 }, (_, n) => 'abcdefgh'.slice(0, n + 1));
      for (const goal of pool) {
        for (const x of witnesses) {
          const st = runPlan(sk.plan, initState(x));
          if (st === null) continue;
          // 「初始不达标 ∧ 终值达标」候选 = 0：全域穷举结论，与采样预算无关。
          expect(goalOk(x, { goal }) || !goalOk(st.x, { goal }), `${sk.plan.join(',')} @${String(x)}`).toBe(true);
        }
      }
    }
  }, 180_000);

  it('注册表成员行为复核：goal 两族 × 8 seed 的 instanceGoal 全部零产出', () => {
    const byId = new Map(SKELETONS.map((sk) => [_skelId(sk), sk]));
    const samples = [...UNPRODUCIBLE_HELDOUT]
      .filter((k) => k.startsWith('goal:goal_verify:'))
      .sort()
      .slice(0, 6)
      .map((k) => byId.get(k.slice('goal:goal_verify:'.length))!);
    expect(samples.length).toBe(6);
    for (const sk of samples) {
      for (const fam of ['goal', 'goal_verify'] as const) {
        for (let seed = 0; seed < 8; seed++) {
          expect(instanceGoal(makeRng(seed), sk.root, sk.plan, fam), `${sk.plan.join(',')} ${fam} seed=${seed}`).toBeNull();
        }
      }
    }
  }, 240_000);

  it('非注册表 heldout 骨架抽样：适格域内 goal 两族必在重试预算内产出', () => {
    const good = SKELETONS.filter(
      (sk) => splitOf(sk) === 'heldout' && !UNPRODUCIBLE_HELDOUT.has(coverageKey('goal', 'goal', _skelId(sk))),
    ).slice(0, 12);
    expect(good.length).toBe(12);
    for (const sk of good) {
      for (const fam of ['goal', 'goal_verify'] as const) {
        let ok = false;
        for (let attempt = 0; attempt < 50 && !ok; attempt++) {
          const t = instanceTask(makeRng(500 + attempt), sk.root, sk.plan, fam, 'goal');
          ok = t !== null && t.split === 'heldout';
        }
        expect(ok, `可产骨架 ${sk.plan.join(',')} goal/${fam}`).toBe(true);
      }
    }
  }, 180_000);
});

describe('gen/producibility/hasOneStepSolution（depth-1 捷径守卫）', () => {
  const baseTask = (o: Partial<Task>): Task => ({
    style: 'follow',
    family: 'value',
    instruction: '',
    x: 5,
    spec: {},
    expected: 5,
    plan_hidden: ['submit'],
    root: 'Int',
    plan_hash: '',
    composition_id: '',
    split: 'train',
    ...o,
  });

  it('value 族：x==expected 单步即解；需两步则判无', () => {
    expect(hasOneStepSolution(baseTask({}), GRAPH)).toBe(true); // 单步 submit：answer=5=expected
    expect(hasOneStepSolution(baseTask({ expected: 8 }), GRAPH)).toBe(false); // 需 add3→submit 两步
  });

  it('goal 族：submit 可达判有；初始不达标 witness 对 len 目标判无（无解亦无捷径）', () => {
    expect(
      hasOneStepSolution(
        baseTask({ style: 'goal', family: 'goal', x: 'abcd', root: 'Str', spec: { goal: { kind: 'len', min: 2, max: 4 } } }),
        GRAPH,
      ),
    ).toBe(true); // 单步 submit：'abcd' len4 ∈[2,4] 达标
    expect(
      hasOneStepSolution(
        baseTask({ style: 'goal', family: 'goal', x: 'abcdef', root: 'Str', spec: { goal: { kind: 'len', min: 3, max: 5 } } }),
        GRAPH,
      ),
    ).toBe(false); // submit 'abcdef' len6 越界、echo 'echo:abcdef' len12 越界，单步无解
    const lenShift: Skel = { root: 'Str', plan: ['upper', 'reverse'] };
    expect(
      hasOneStepSolution(
        baseTask({ style: 'goal', family: 'goal', x: 'abcdef', root: 'Str', spec: { goal: { kind: 'len', min: 3, max: 5 } }, plan_hidden: [...lenShift.plan, 'submit'] }),
        GRAPH,
      ),
    ).toBe(false); // 长度不变类骨架+初始不达标 witness：任何单步都达不到目标
  });

  it('verify 族：answer 与 verdict 双通道单步互斥，验收不可破', () => {
    expect(hasOneStepSolution(baseTask({ family: 'verify', expected: 5, spec: { parity: 1 } }), GRAPH)).toBe(false);
  });
});
