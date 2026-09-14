/**
 * teacher/search 测试（C.4 检索内核的行为契约）。
 *
 * 用真实生成任务驱动三件事：可解必找到（follow/goal 四组合 × 多 seed，回放穿
 * accept、plan 不含 EXIT）、最短性口径（BFS 结果长度 ≤ plan_hidden——两者都不
 * 含 EXIT 才可比；注意 has_shortcut 守卫只挡「单算子+收尾」一种捷径，多算子
 * 巧合捷径不设防，所以口径是 ≤ 而非相等：实测 follow value seed1 金标 5 步而
 * 真最短 4 步）、确定性与预算/深度边界（超预算 fail-fast、maxDepth=0、无解
 * 确证）。stateDigest 的身份检查守着"唯一口径"——re-export 必须与
 * data/conflict_bfs 是同一个函数对象，访问计数必须参与去重键。
 */

import { describe, expect, it } from 'vitest';

import { planBfs, stateDigest } from '../teacher/search.js';
import { stateDigest as conflictStateDigest } from '../data/conflict_bfs.js';
import { makeTask } from '../gen/generator.js';
import { GRAPH } from '../runner/graph.js';
import { EXIT, applyOp, initState, type State } from '../world/operators.js';
import { accept } from '../verify/acceptor.js';
import { oracleTrace } from '../teacher/oracle.js';
import { hashObj } from '../world/hash.js';
import type { Family, Style, Task } from '../schema.js';

/** 顺序回放 plan（不含 EXIT 的算子步），返回末态。 */
function replay(task: Task, plan: readonly string[]): State {
  let st = initState(task.x, task.spec);
  for (const op of plan) {
    const next = applyOp(GRAPH, op, st);
    expect(next).not.toBeNull();
    st = next!;
  }
  return st;
}

/** 在候选 seed 里取第一个生成成功的真实任务。 */
function taskFor(style: Style, family: Family, seeds: readonly number[]): Task {
  for (const seed of seeds) {
    const t = makeTask(seed, style, family);
    if (t !== null) return t;
  }
  throw new Error(`makeTask 在 seed ${String(seeds)} 上全部失败`);
}

/** 单任务全套主体断言：非 null、无 EXIT、回放穿 accept、hist 即路径、长度 ≤ 金标。 */
function checkSolution(task: Task): string[] {
  const plan = planBfs(task, GRAPH);
  expect(plan).not.toBeNull();
  const p = plan!;
  expect(p).not.toContain(EXIT);
  expect(p.length).toBeLessThanOrEqual(task.plan_hidden.length);
  const end = replay(task, p);
  expect(accept(task, end)).toBe(true);
  expect([...end.hist]).toEqual(p);
  return p;
}

describe('teacher/planBfs：真实任务可解必找到', () => {
  it('follow/value 多 seed：找到、无 EXIT、回放穿验收、不超过金标长度', () => {
    for (const seed of [1, 5, 13, 77]) {
      checkSolution(taskFor('follow', 'value', [seed]));
    }
  });

  it('follow/verify 多 seed：同口径（双生产者通道下 BFS 仍穿验收）', () => {
    for (const seed of [5, 31, 101]) {
      checkSolution(taskFor('follow', 'verify', [seed]));
    }
  });

  it('goal/goal：accept 只读公开 spec，planBfs 即公开规划臂', () => {
    for (const seed of [1, 2, 5, 13]) {
      checkSolution(taskFor('goal', 'goal', [seed]));
    }
  });

  it('goal/goal_verify：与 oracle 轨迹步数口径一致可比（同不含 EXIT）', () => {
    for (const seed of [1, 2, 101, 202]) {
      const t = taskFor('goal', 'goal_verify', [seed]);
      const plan = checkSolution(t);
      const oracleSteps = oracleTrace(t, GRAPH).length - 1;
      expect(oracleSteps).toBe(t.plan_hidden.length);
      expect(plan.length).toBeLessThanOrEqual(oracleSteps);
    }
  });

  it('R5：follow 族更短解按定义不存在——BFS 解 = gold（等长），G2.2 归零的实证', () => {
    // R5 轨迹约束：验收要求 hist == spec.trace 精确匹配，plan_bfs 沿 trace 前缀
    // 剪枝后唯一解即金计划本身（等长）。旧版实测"follow value seed1 金标 5 步、
    // 真最短 4 步"的多算子巧合捷径已被轨迹约束按定义排除。
    const t = taskFor('follow', 'value', [1]);
    const plan = planBfs(t, GRAPH)!;
    expect(plan.length).toBe(t.plan_hidden.length);
    expect(plan).toEqual(t.plan_hidden);
    expect(accept(t, replay(t, plan))).toBe(true);
  });
});

describe('teacher/planBfs：确定性与预算/深度边界', () => {
  it('同一任务两次调用逐字相同（candidates 排序 × FIFO 出队序）', () => {
    for (const t of [
      taskFor('follow', 'value', [13]),
      taskFor('follow', 'verify', [101]),
      taskFor('goal', 'goal', [1]),
    ]) {
      expect(planBfs(t, GRAPH)).toEqual(planBfs(t, GRAPH));
    }
  });

  it('nodeBudget=1 在出队点 fail-fast：抛 search budget exceeded', () => {
    const t = taskFor('goal', 'goal', [1]);
    expect(() => planBfs(t, GRAPH, { nodeBudget: 1 })).toThrow(/search budget exceeded/);
  });

  it('maxDepth=0：初始态在 B.4 下恒不过验收（answer 未落），队列耗尽返回 null', () => {
    expect(planBfs(taskFor('follow', 'value', [13]), GRAPH, { maxDepth: 0 })).toBeNull();
  });

  it('maxDepth 截断：比最短解浅则耗尽返回 null，恰好够则原样找到', () => {
    const deep = taskFor('follow', 'value', [13]);
    const found = planBfs(deep, GRAPH)!;
    expect(found.length).toBeGreaterThan(2);
    expect(planBfs(deep, GRAPH, { maxDepth: found.length - 1 })).toBeNull();
    expect(planBfs(deep, GRAPH, { maxDepth: found.length })).toEqual(found);

    const shallow = taskFor('goal', 'goal', [1]);
    expect(planBfs(shallow, GRAPH, { maxDepth: 2 })).toHaveLength(2);
    expect(planBfs(shallow, GRAPH, { maxDepth: 1 })).toBeNull();
  });

  it('手工构造的无解任务：队列耗尽确证 null', () => {
    const bad: Task = {
      style: 'follow',
      family: 'value',
      instruction: '无解',
      x: 5,
      spec: {},
      expected: 'IMPOSSIBLE',
      plan_hidden: [],
      root: 'Int',
      plan_hash: hashObj([]),
      composition_id: hashObj(['unsolvable']),
      split: 'train',
    };
    // 无解判定 = 队列耗尽；全深度 12 的可达状态数远超任何可行预算（预算内只会
    // 抛），"确证无解"必须在有限深度上做，故钉 maxDepth=3 让耗尽真的发生。
    expect(planBfs(bad, GRAPH, { maxDepth: 3 })).toBeNull();
  });
});

describe('teacher/stateDigest（C.4 唯一口径的再导出）', () => {
  it('与 data/conflict_bfs 是同一个函数对象（禁止第二份实现）', () => {
    expect(stateDigest).toBe(conflictStateDigest);
  });

  it('值相同但访问计数不同的状态判为不同态（MAX_REPEAT 依赖计数进键）', () => {
    const base = initState(5);
    const once = { ...base, hist: ['noop'] };
    const twice = { ...base, hist: ['noop', 'noop'] };
    expect(stateDigest(base)).toBe(stateDigest({ ...base }));
    expect(stateDigest(once)).not.toBe(stateDigest(twice));
  });
});
