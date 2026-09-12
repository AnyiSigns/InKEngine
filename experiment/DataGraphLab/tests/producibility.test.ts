/**
 * gen/producibility 测试（heldout 可产域注册表 + 单步捷径判定）。
 *
 * 断言：判定池 = sampleGoal 采样空间（防漂移）；键仅 goal 两族、follow 零键、
 * composition_id 全落 heldout；规模与实测 211/830 一致；注册表成员经判定池 ×
 * 全域 witness 穷举独立复核零候选（独立 oracle，不 import 被测实现），且
 * goal 两族实例化恒零产出；可产域（非注册表）骨架 goal 两族必在重试预算内产出；
 * hasOneStepSolution 对 value/goal/verify 族的正/负判据。
 */

import { describe, expect, it } from 'vitest';

import {
  coverageKey,
  hasOneStepSolution,
  INT_GOAL_POOL,
  STR_GOAL_POOL,
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

/** 字面誊写 sampleGoal（C.1 词表）的独立 oracle，不 import 被测实现。 */
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

describe('gen/producibility/UNPRODUCIBLE_HELDOUT（可产域注册表）', () => {
  it('注册表判定池与 sampleGoal 采样空间一致（防判定域漂移）', () => {
    expect(INT_GOAL_POOL.length).toBe(30);
    expect(STR_GOAL_POOL.length).toBe(6);
    expect(oraclePoolInt().length).toBe(30);
    expect(oraclePoolStr().length).toBe(6);
    const intSeen = new Set<string>();
    const strSeen = new Set<string>();
    for (let s = 0; s < 3000; s++) {
      intSeen.add(JSON.stringify(sampleGoal(makeRng(s), 'Int')));
      strSeen.add(JSON.stringify(sampleGoal(makeRng(s), 'Str')));
    }
    // 采样空间 ⊆ 判定池，且判定池每个实例都被采样命中（池不可多也不可少）。
    for (const g of intSeen) expect(INT_GOAL_POOL.some((p) => JSON.stringify(p) === g), g).toBe(true);
    for (const g of strSeen) expect(STR_GOAL_POOL.some((p) => JSON.stringify(p) === g), g).toBe(true);
    expect(intSeen.size).toBe(INT_GOAL_POOL.length);
    expect(strSeen.size).toBe(STR_GOAL_POOL.length);
  });

  it('键合法：仅 goal 两族（follow 零键），两族对称，composition_id 全落 heldout 骨架', () => {
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

  it('规模与实测一致：211 骨架 × 2 族 = 422 键（heldout 211/830）', () => {
    const heldoutN = SKELETONS.filter((sk) => splitOf(sk) === 'heldout').length;
    expect(UNPRODUCIBLE_HELDOUT.size).toBe(422);
    expect(heldoutN).toBe(830);
    expect(UNPRODUCIBLE_HELDOUT.size).toBe(211 * 2);
  });

  it('抽样注册表成员全域复核：判定池 × 全域 witness 穷举零候选（不可产不靠预算）', () => {
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
  }, 120_000);

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
  }, 180_000);

  it('非注册表 heldout 骨架抽样：可产域内 goal 两族必在重试预算内产出', () => {
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
  }, 120_000);
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

  it('goal 族：submit 可达判有；恒等骨架对 len 目标判无（无解亦无捷径）', () => {
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
    const idSkel: Skel = { root: 'Str', plan: ['reverse', 'reverse'] };
    expect(
      hasOneStepSolution(
        baseTask({ style: 'goal', family: 'goal', x: 'abcdef', root: 'Str', spec: { goal: { kind: 'len', min: 3, max: 5 } }, plan_hidden: [...idSkel.plan, 'submit'] }),
        GRAPH,
      ),
    ).toBe(false); // 恒等骨架对 len 目标的初始不达标 witness：任何单步都达不到目标
  });

  it('verify 族：answer 与 verdict 双通道单步互斥，验收不可破', () => {
    expect(hasOneStepSolution(baseTask({ family: 'verify', expected: 5, spec: { parity: 1 } }), GRAPH)).toBe(false);
  });
});
