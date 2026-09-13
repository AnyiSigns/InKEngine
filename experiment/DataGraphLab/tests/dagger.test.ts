/**
 * runner/dagger 测试：on-path 干预语义（偏离判定、打标、老师干预后续跑）、
 * 标签行特征红线（观测与 obsSnapshot 同源、隐藏字段零进入）、编排回调契约与
 * 同 seed 逐字确定性。核心语义用合成任务（手写 gold 计划 + 脚本化 policy，偏离
 * 位置完全可控）钉死；回路与真实数据侧行为用生成器真实任务验证。训练出口一律
 * 恒等回调注入，模块不 spawn Python 子进程。
 */

import { describe, expect, it } from 'vitest';

import { correctGold, dagger, type DaggerResult } from '../runner/dagger.js';
import { GRAPH } from '../runner/graph.js';
import { EXIT, applyOp, initState, obsSnapshot, runPlan, type State } from '../world/operators.js';
import { hashObj } from '../world/hash.js';
import { isOnPath, oracleTrace } from '../teacher/oracle.js';
import { recordFromStep, type StoreRecord } from '../data/store.js';
import { makeTask } from '../gen/generator.js';
import { Policy } from '../controller/policy.js';
import type { Rng } from '../world/rng.js';
import type { Family, Style, Task } from '../schema.js';

/** 沿 hist 逐步回放求当刻状态（打标行 obs 独立重算的参照）。 */
function replayState(task: Task, hist: readonly string[]): State | null {
  let st: State = initState(task.x, task.spec);
  for (const nid of hist) {
    const next = applyOp(GRAPH, nid, st);
    if (next === null) return null;
    st = next;
  }
  return st;
}

function followGold(task: Task, k: number): string {
  return k < task.plan_hidden.length ? task.plan_hidden[k]! : EXIT;
}

/** 从连续 seed 上收集 n 条指定 style 的真实任务。 */
function collectTasks(style: Style, n: number, from = 1): Task[] {
  const out: Task[] = [];
  for (let seed = from; seed < from + 200 && out.length < n; seed++) {
    const t = makeTask(seed, style);
    if (t !== null) out.push(t);
  }
  if (out.length !== n) throw new Error(`collectTasks(${style}) 仅产出 ${String(out.length)}/${String(n)}`);
  return out;
}

/** 合成任务：计划回放求 expected；obs/label 语义与真实任务同构。 */
function synthTask(
  plan: readonly string[],
  x: number | string,
  opts?: { spec?: Readonly<Record<string, unknown>>; family?: Family },
): Task {
  const spec = opts?.spec ?? {};
  const st = runPlan(plan, initState(x, spec));
  if (st === null) throw new Error('synthTask: gold 回放进死路');
  return {
    style: 'follow',
    family: opts?.family ?? 'value',
    instruction: `依次经过 ${plan.join('、')}`,
    x,
    spec,
    expected: st.x as number | string,
    plan_hidden: plan,
    root: typeof x === 'number' ? 'Int' : 'Str',
    plan_hash: hashObj(plan),
    composition_id: `synth:${hashObj(plan)}`,
    split: 'train',
  };
}

/** 脚本化 policy：只按 hist 深度（= gold 位置）决定动作，偏离位置精确可控。 */
function scriptedPolicy(
  task: Task,
  choose: (k: number, cand: readonly string[], task: Task) => string,
): Policy {
  return {
    act(_instruction: string, obs: { hist: readonly string[] }, cand: readonly string[]): string {
      return choose(obs.hist.length, cand, task);
    },
  } as unknown as Policy;
}

const keepPolicy = (p: Policy) => (): Policy => p;

const singleTask = (task: Task) => (_rng: Rng, count: number): readonly Task[] =>
  count > 1 ? [task, task] : count === 1 ? [task] : [];

const PERFECT = ['add3', 'mul2', 'sub1', 'submit'] as const;

describe('correctGold：on-path 前缀判定（E.13 标签纪律判定源）', () => {
  const task = synthTask(PERFECT, 7);

  it('off-path 状态一律不打标（前缀错位 / 超出计划长度），与所选动作无关', () => {
    expect(correctGold(task, replayState(task, ['mul2'])!, 'add3')).toBeNull();
    expect(correctGold(task, replayState(task, ['add3', 'sub1'])!, EXIT)).toBeNull();
    expect(correctGold(task, replayState(task, ['noop'])!, 'noop')).toBeNull();
    expect(
      correctGold(task, replayState(task, [...PERFECT, 'noop'])!, 'noop'),
    ).toBeNull();
  });

  it('on-path：与 gold 一致返回 null；偏离（含提前/迟滞 exit）返回 gold 动作', () => {
    expect(correctGold(task, replayState(task, [])!, 'add3')).toBeNull();
    expect(correctGold(task, replayState(task, [])!, 'exit')).toBe('add3');
    expect(correctGold(task, replayState(task, ['add3'])!, 'sub1')).toBe('mul2');
    const done = replayState(task, [...PERFECT])!;
    expect(correctGold(task, done, EXIT)).toBeNull();
    expect(correctGold(task, done, 'noop')).toBe(EXIT);
  });
});

describe('dagger：偏离打标与老师干预续跑（合成任务钉死语义）', () => {
  const task = synthTask(PERFECT, 7);

  it('与 gold 全程一致：零偏离、零监督行，rollout 正常在 EXIT 收口', () => {
    const p = scriptedPolicy(task, (k) => followGold(task, k));
    const r = dagger(p, {
      taskProvider: singleTask(task),
      train: keepPolicy(p),
      iterations: 1,
      tasksPerIter: 1,
    });
    expect(r.deviations).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.stats).toMatchObject({ rollouts: 1, steps: 5, deviatedSteps: 0, deviatedRollouts: 0, firstDeviationDepths: [] });
    expect(r.policy).toBe(p);
  });

  it('老师干预后续跑：第二次偏离仍是合法 on-path 标签被收', () => {
    const p = scriptedPolicy(task, (k) => (k <= 1 ? 'noop' : followGold(task, k)));
    const r = dagger(p, { taskProvider: singleTask(task), train: keepPolicy(p), iterations: 1, tasksPerIter: 1 });
    expect(r.deviations.map((d) => [d.stepIndex, d.goldAction, d.chosenAction])).toEqual([
      [0, 'add3', 'noop'],
      [1, 'mul2', 'noop'],
    ]);
    expect(r.rows.map((row) => [row.target, [...row.hist]])).toEqual([
      ['add3', []],
      ['mul2', ['add3']],
    ]);
    expect(r.stats).toMatchObject({ steps: 5, deviatedSteps: 2, deviatedRollouts: 1, firstDeviationDepths: [0] });
  });

  it('EXIT 偏离被判定并打标：计划耗尽选非 EXIT → target=exit 并终止；提前选 EXIT → 记 gold 算子并干预续跑', () => {
    const vTask = synthTask(['submit', 'check_parity'], 7, { spec: { parity: 1 }, family: 'verify' });
    const overstaying = scriptedPolicy(vTask, (k) => (k < 2 ? followGold(vTask, k) : 'noop'));
    const r1 = dagger(overstaying, { taskProvider: singleTask(vTask), train: keepPolicy(overstaying), iterations: 1, tasksPerIter: 1 });
    expect(r1.deviations).toEqual([{ taskHash: r1.rows[0]!.meta.task_hash, stepIndex: 2, goldAction: EXIT, chosenAction: 'noop' }]);
    expect(r1.rows).toHaveLength(1);
    expect(r1.rows[0]!.target).toBe(EXIT);
    expect(r1.stats.firstDeviationDepths).toEqual([2]);

    const leaving = scriptedPolicy(task, (k) => (k === 1 ? EXIT : followGold(task, k)));
    const r2 = dagger(leaving, { taskProvider: singleTask(task), train: keepPolicy(leaving), iterations: 1, tasksPerIter: 1 });
    expect(r2.deviations.map((d) => [d.stepIndex, d.goldAction, d.chosenAction])).toEqual([[1, 'mul2', EXIT]]);
    expect(r2.rows.map((row) => row.target)).toEqual(['mul2']);
    expect(r2.stats.steps).toBe(5);
  });

  it('单 rollout maxFixes 上限生效：默认 4、覆写 2 各自截断', () => {
    const p = scriptedPolicy(task, () => 'noop');
    const byDefault = dagger(p, { taskProvider: singleTask(task), train: keepPolicy(p), iterations: 1, tasksPerIter: 1 });
    expect(byDefault.deviations.map((d) => d.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(byDefault.rows.map((row) => row.target)).toEqual([...PERFECT]);
    const capped = dagger(p, { taskProvider: singleTask(task), train: keepPolicy(p), iterations: 1, tasksPerIter: 1, maxFixes: 2 });
    expect(capped.deviations.map((d) => d.stepIndex)).toEqual([0, 1]);
    expect(capped.stats).toMatchObject({ steps: 2, firstDeviationDepths: [0], deviatedRollouts: 1 });
  });

  describe('标签行特征红线：gold 只进 target，观测与 obsSnapshot 同源', () => {
    const runs: readonly (readonly StoreRecord[])[] = (() => {
      const a = synthTask(PERFECT, 7);
      const pa = scriptedPolicy(a, (k) => (k % 2 === 0 ? 'noop' : followGold(a, k)));
      const ra = dagger(pa, { taskProvider: singleTask(a), train: keepPolicy(pa), iterations: 1, tasksPerIter: 1 });
      const b = synthTask(['submit', 'check_parity'], 7, { spec: { parity: 1 }, family: 'verify' });
      const pb = scriptedPolicy(b, (k) => (k < 2 ? followGold(b, k) : 'noop'));
      const rb = dagger(pb, { taskProvider: singleTask(b), train: keepPolicy(pb), iterations: 1, tasksPerIter: 1 });
      return [ra.rows, rb.rows];
    })();
    const TOP_FIELDS = 'candidates,family,hist,instruction,meta,state,style,target,x';
    const META_ALLOWED = new Set([
      'task_hash', 'step_index', 'split', 'composition_id', 'plan_hash', 'world_version', 'teacher', 'c_hash',
    ]);

    it('顶层九字段、meta 白名单、state 只含 answer/verdict——无任何隐藏字段键（含 seed/spec）', () => {
      const all = runs.flat();
      expect(all.length).toBeGreaterThan(0);
      for (const row of all) {
        expect(Object.keys(row).sort().join(',')).toBe(TOP_FIELDS);
        for (const key of Object.keys(row.meta)) expect(META_ALLOWED.has(key)).toBe(true);
        expect(Object.keys(row.state).sort().join(',')).toBe('answer,verdict');
        expect(hashObj(row).length).toBeGreaterThan(0);
        const json = JSON.stringify(row);
        for (const forbidden of ['"expected"', '"plan_hidden"', '"spec"', '"seed"']) {
          expect(json.includes(forbidden)).toBe(false);
        }
      }
    });

    it('每条打标行：hist 是 gold 前缀、step_index 等于前缀深度、obs 与回放态 obsSnapshot 逐字相等、target 在候选内', () => {
      const cases: Array<{ rows: readonly StoreRecord[]; task: Task }> = [
        { rows: runs[0]!, task: synthTask(PERFECT, 7) },
        { rows: runs[1]!, task: synthTask(['submit', 'check_parity'], 7, { spec: { parity: 1 }, family: 'verify' }) },
      ];
      for (const { rows, task: t } of cases) {
        for (const row of rows) {
          expect(isOnPath(row.hist, t.plan_hidden)).toBe(true);
          expect(row.meta.step_index).toBe(row.hist.length);
          const st = replayState(t, row.hist);
          expect(st).not.toBeNull();
          const snap = obsSnapshot(st!);
          expect({ x: row.x, answer: row.state.answer, verdict: row.state.verdict, hist: [...row.hist] })
            .toEqual({ x: snap.x, answer: snap.answer, verdict: snap.verdict, hist: [...snap.hist] });
          expect(row.candidates).toContain(row.target);
        }
      }
    });
  });
});

describe('dagger：编排回路（真实生成任务 + 恒等训练回调）', () => {
  const pool = [...collectTasks('follow', 3), ...collectTasks('goal', 3)];
  const base = Policy.random(11);
  const provider = (rng: Rng, count: number): readonly Task[] => rng.shuffle(pool).slice(0, count);

  function run(seed: number): DaggerResult {
    return dagger(base, {
      seed,
      iterations: 2,
      tasksPerIter: 3,
      taskProvider: provider,
      train: () => base,
    });
  }

  it('同 seed 两次结果逐字一致（含 deviations/rows/stats 全量）', () => {
    const r1 = run(7);
    const r2 = run(7);
    expect(r2).toEqual(r1);
    expect(JSON.stringify(r2.rows)).toBe(JSON.stringify(r1.rows));
    expect(r1.stats.rollouts).toBe(6);
    expect(r1.deviations.length).toBeGreaterThan(0);
    expect(r1.rows.length).toBe(r1.stats.rowsAddedPerIter[0]! + r1.stats.rowsAddedPerIter[1]!);
  });

  it('每迭代经 dedup 后监督行非降，且所有打标行观测不含隐藏量', () => {
    const r = run(5);
    expect(r.stats.rowsAddedPerIter.every((n) => n >= 0)).toBe(true);
    const json = JSON.stringify(r.rows);
    for (const forbidden of ['"expected"', '"plan_hidden"', '"spec"', '"seed"']) {
      expect(json.includes(forbidden)).toBe(false);
    }
  });

  it('回调契约：provider 按迭代收 count=rng；train 每迭代一次收累积行 + val 原样透传；evalPass1 按迭代记录、缺省记 null', () => {
    const val: StoreRecord[] = [];
    const seenRows: number[] = [];
    let evalTick = 0;
    const r = dagger(base, {
      taskProvider: (_rng, count, iteration) => {
        expect(count).toBe(2);
        return pool.slice(iteration * 2, iteration * 2 + 2);
      },
      train: (rows, valRows) => {
        expect(valRows).toBe(val);
        seenRows.push(rows.length);
        return base;
      },
      iterations: 2,
      tasksPerIter: 2,
      valRows: val,
      evalPass1: () => ++evalTick,
    });
    expect(seenRows).toHaveLength(2);
    expect(pass1(r)).toEqual([1, 2]);
    const rNoEval = dagger(base, {
      taskProvider: (_rng, count) => pool.slice(0, count),
      train: keepPolicy(base),
      iterations: 1,
      tasksPerIter: 1,
    });
    expect(rNoEval.stats.passAt1PerIter).toEqual([null]);
  });

  it('初始 oracle 监督行保序保留；与偏离行同键（task/step/obs/action）时由步级去重合并、不重复入账', () => {
    const t = pool[0]!;
    const trace = oracleTrace(t, GRAPH);
    const seedRows = [recordFromStep(t, trace[0]!), recordFromStep(t, trace[1]!)];
    const noisy = scriptedPolicy(t, (k) => (k <= 1 ? 'noop' : followGold(t, k)));
    const r = dagger(noisy, {
      trainRows: seedRows,
      taskProvider: singleTask(t),
      train: keepPolicy(noisy),
      iterations: 1,
      tasksPerIter: 1,
    });
    expect(r.deviations.map((d) => d.stepIndex)).toEqual([0, 1]);
    expect(r.rows[0]).toBe(seedRows[0]);
    expect(r.rows[1]).toBe(seedRows[1]);
    expect(r.rows).toHaveLength(seedRows.length);
    expect(r.stats.rowsAddedPerIter).toEqual([0]);
  });

  it('参数守卫：maxFixes ≥1、iterations/tasksPerIter ≥0、seed 为整数，违者当场抛', () => {
    const opts = { taskProvider: provider, train: keepPolicy(base), iterations: 1, tasksPerIter: 1 };
    expect(() => dagger(base, { ...opts, maxFixes: 0 })).toThrow(/maxFixes/);
    expect(() => dagger(base, { ...opts, iterations: -1 })).toThrow(/iterations/);
    expect(() => dagger(base, { ...opts, tasksPerIter: 1.5 })).toThrow(/tasksPerIter/);
    expect(() => dagger(base, { ...opts, seed: 0.5 })).toThrow(/seed/);
  });
});

function pass1(r: DaggerResult): readonly (number | null)[] {
  return r.stats.passAt1PerIter;
}
