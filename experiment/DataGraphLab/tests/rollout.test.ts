/**
 * runner/rollout 测试（C.7 执行闭环）：greedy 逐字确定性、非 greedy 同 seed 可
 * 复现、成功口径（末步 exit 且 accept 在 exit 当刻状态上成立）、逐步 obs/候选与
 * 当刻状态一致（回放重算比对）、单候选直取捷径不咨询 policy、空预算与缺 rng 的
 * 入口守卫。gold 回放用鸭子类型的脚本 policy——Policy 是类但 rollout 只消费
 * `act` 方法，测试以最小实现模拟"完美控制器"，不触碰权重。
 */

import { describe, expect, it } from 'vitest';

import { rollout, type RolloutStep } from '../runner/rollout.js';
import { GRAPH, candidates } from '../runner/graph.js';
import { Policy } from '../controller/policy.js';
import { makeTask } from '../gen/generator.js';
import {
  EXIT,
  applyOp,
  initState,
  obsSnapshot,
  type Graph,
  type State,
} from '../world/operators.js';
import { accept } from '../verify/acceptor.js';
import { makeRng } from '../world/rng.js';
import type { Family, Style, Task } from '../schema.js';

/** 在候选 seed 上取第一个生成成功的真实任务。 */
function taskFor(style: Style, family: Family, seeds: readonly number[]): Task {
  for (const seed of seeds) {
    const t = makeTask(seed, style, family);
    if (t !== null) return t;
  }
  throw new Error(`makeTask 在 seed ${String(seeds)} 上全部失败`);
}

/** 沿 gold 前缀逐字回放的脚本 policy（完美控制器替身；hist 长度就是下一 gold 下标）。 */
function goldPolicy(task: Task): Policy {
  return {
    act(_instruction: string, obs: { hist: readonly string[] }, cand: readonly string[]): string {
      const k = obs.hist.length;
      const want = k < task.plan_hidden.length ? task.plan_hidden[k]! : EXIT;
      if (!cand.includes(want)) throw new Error(`gold 动作不在候选: ${want}`);
      return want;
    },
  } as unknown as Policy;
}

/** 由步 obs 重建当刻验收态：accept 只读 answer/verdict（+ 任务侧 spec）。 */
function stateFromObs(task: Task, step: RolloutStep): State {
  return { ...step.obs, spec: task.spec } as State;
}

describe('runner/rollout：确定性（greedy 无采样）', () => {
  it('同 policy 同任务 greedy 两次逐字相同（follow/goal 各验一组）', () => {
    const policy = Policy.random(5);
    for (const task of [taskFor('follow', 'value', [11]), taskFor('goal', 'goal', [1])]) {
      const r1 = rollout(policy, GRAPH, task, true);
      const r2 = rollout(policy, GRAPH, task);
      expect(r2.trace).toEqual(r1.trace);
      expect(r2.accepted).toBe(r1.accepted);
    }
  });

  it('非 greedy 同 seed rng 两次运行逐字相同；缺 rng 在入口即抛', () => {
    const task = taskFor('follow', 'value', [11]);
    const policy = Policy.random(9);
    const r1 = rollout(policy, GRAPH, task, false, undefined, makeRng(4));
    const r2 = rollout(policy, GRAPH, task, false, undefined, makeRng(4));
    expect(r2.trace).toEqual(r1.trace);
    expect(() => rollout(policy, GRAPH, task, false)).toThrow(/rng/);
    expect(() => rollout(policy, GRAPH, task, false, 3)).toThrow(/rng/);
  });
});

describe('runner/rollout：成功口径与验收时机', () => {
  for (const [style, family, seeds] of [
    ['follow', 'value', [1, 5]] as const,
    ['follow', 'verify', [5, 31]] as const,
    ['goal', 'goal', [1, 2]] as const,
    ['goal', 'goal_verify', [1, 101]] as const,
  ]) {
    it(`${style}/${family}：gold 回放即成功——末步 exit、trace 动作序列 = plan + exit`, () => {
      const task = taskFor(style, family, seeds);
      const r = rollout(goldPolicy(task), GRAPH, task);
      expect(r.accepted).toBe(true);
      expect(r.trace.map((s) => s.action)).toEqual([...task.plan_hidden, EXIT]);
      const last = r.trace[r.trace.length - 1]!;
      expect(last.action).toBe(EXIT);
      expect(accept(task, stateFromObs(task, last))).toBe(true);
    });
  }

  it('随机臂若判 accepted=true，必满足末步 exit 且当刻状态穿验收', () => {
    const policy = Policy.random(3);
    for (const seed of [1, 2, 3, 5, 8, 13]) {
      const task = taskFor('follow', 'value', [seed]);
      const r = rollout(policy, GRAPH, task);
      if (!r.accepted) continue;
      const last = r.trace[r.trace.length - 1]!;
      expect(last.action).toBe(EXIT);
      expect(accept(task, stateFromObs(task, last))).toBe(true);
    }
  });
});

describe('runner/rollout：逐步状态自洽（obs/candidates 与当刻状态一致）', () => {
  it('从初始态重放 trace：每一步的 obs 与候选都和重算逐字相等', () => {
    for (const task of [
      taskFor('follow', 'verify', [77]),
      taskFor('goal', 'goal', [13]),
    ]) {
      const policy = Policy.random(2);
      let st: State = initState(task.x, task.spec);
      for (const step of rollout(policy, GRAPH, task).trace) {
        expect(step.obs).toEqual(obsSnapshot(st));
        expect([...step.candidates]).toEqual(candidates(GRAPH, st, st.hist));
        expect(step.candidates).toContain(step.action);
        if (step.action === EXIT) break;
        const next = applyOp(GRAPH, step.action, st);
        expect(next).not.toBeNull();
        st = next!;
      }
    }
  });
});

describe('runner/rollout：边界与守卫', () => {
  it('单候选（仅剩 exit）直接取，不咨询 policy、不死循环', () => {
    const onlyExit: Graph = { nodes: { exit: GRAPH.nodes.exit! } };
    const boom = {
      act(): string {
        throw new Error('单候选捷径不应调用 policy.act');
      },
    } as unknown as Policy;
    const task = taskFor('follow', 'value', [11]);
    const r = rollout(boom, onlyExit, task);
    expect(r.trace).toHaveLength(1);
    expect(r.trace[0]!.candidates).toEqual([EXIT]);
    expect(r.trace[0]!.action).toBe(EXIT);
    expect(r.accepted).toBe(false);
  });

  it('maxSteps=0 → trace 空、accepted false（入口守卫仍先行）', () => {
    const task = taskFor('follow', 'value', [11]);
    const r = rollout(Policy.random(5), GRAPH, task, true, 0);
    expect(r.trace).toEqual([]);
    expect(r.accepted).toBe(false);
  });

  it('maxSteps=1 → 只记一步，未碰 exit 即超预算判负', () => {
    const task = taskFor('follow', 'value', [11]);
    const r = rollout(goldPolicy(task), GRAPH, task, true, 1);
    expect(r.trace).toHaveLength(1);
    if (task.plan_hidden.length > 0) expect(r.accepted).toBe(false);
  });
});
