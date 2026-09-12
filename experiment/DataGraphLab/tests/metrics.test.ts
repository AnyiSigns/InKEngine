/**
 * eval/metrics 测试（C.7 口径 + D 表「手工构造样例数值正确」）：Wilson CI 在测试
 * 内按公式复算对照（不抄常数）、ECE 用两 bin 手工对照、pass@1/pathExcess/
 * routingAcc 与独立手跑重算逐一相等（同 policy 同任务、greedy 确定性保证两遍
 * 结果可比）。stepsOverShortest 的超预算桶用 vi.mock 注入：默认 2M 预算在真实
 * 世界里不可现实烧穿，mock 只为点亮「抛 search budget exceeded → 记桶不 raise」
 * 分支，其余任务一律透传真实 planBfs 实现。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  calibrationEce,
  ci95,
  passAt1,
  pathExcess,
  routingAcc,
  stepsOverShortest,
} from '../eval/metrics.js';
import { rollout } from '../runner/rollout.js';
import { GRAPH } from '../runner/graph.js';
import { Policy } from '../controller/policy.js';
import { makeTask } from '../gen/generator.js';
import { oracleTrace } from '../teacher/oracle.js';
import { planBfs } from '../teacher/search.js';
import { taskHash, type Family, type Style, type Task } from '../schema.js';
import type { Graph } from '../world/operators.js';
import { hashObj } from '../world/hash.js';

const BUDGET_BOOM = '__budget_boom__';

vi.mock('../teacher/search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../teacher/search.js')>();
  return {
    ...actual,
    planBfs: (task: Task, graph: Graph, opts?: unknown): string[] | null => {
      if (task.instruction === BUDGET_BOOM) throw new Error('search budget exceeded');
      return actual.planBfs(task, graph, opts as never);
    },
  };
});

function taskFor(style: Style, family: Family, seeds: readonly number[]): Task {
  for (const seed of seeds) {
    const t = makeTask(seed, style, family);
    if (t !== null) return t;
  }
  throw new Error(`makeTask 在 seed ${String(seeds)} 上全部失败`);
}

/** Wilson score 区间公式复算（与实现同式同序，逐位可比）。 */
function wilson(p: number, n: number): readonly [number, number] {
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

describe('eval/ci95（Wilson 区间）', () => {
  it('已知组合与公式复算一致（n=10/p=0.5 等四组）', () => {
    for (const [p, n] of [[0.5, 10], [0.34, 57], [0.99, 100], [0, 300]] as const) {
      const got = ci95(p, n);
      const want = wilson(p, n);
      expect(got[0]).toBeCloseTo(want[0], 12);
      expect(got[1]).toBeCloseTo(want[1], 12);
    }
  });

  it('p=0 下界 0、p=1 上界 1；n=0 → [0,0] 不抛', () => {
    expect(ci95(0, 10)[0]).toBeCloseTo(0, 12);
    expect(ci95(1, 10)[1]).toBeCloseTo(1, 12);
    expect(ci95(0, 10)[0]).toBe(0);
    expect(ci95(0.4, 0)).toEqual([0, 0]);
  });

  it('非法入参 fail-fast', () => {
    expect(() => ci95(-0.1, 5)).toThrow(/p/);
    expect(() => ci95(Number.NaN, 5)).toThrow(/p/);
    expect(() => ci95(0.5, 2.5)).toThrow(/n/);
    expect(() => ci95(0.5, -1)).toThrow(/n/);
  });
});

describe('eval/calibrationEce', () => {
  it('conf 恒 0.7、成功率恰 70% → ECE≈0', () => {
    const confs = new Array<number>(10).fill(0.7);
    const outcomes = [1, 1, 1, 1, 1, 1, 1, 0, 0, 0] as const;
    expect(calibrationEce(confs, outcomes)).toBeLessThan(1e-9);
  });

  it('两 bin 手工对照：偏差 0.35', () => {
    // bin1 {0.15,0.15} acc=0.5、bin8 {0.85,0.85} acc=0.5：各贡献 0.35×(2/4)。
    const ece = calibrationEce([0.15, 0.15, 0.85, 0.85], [0, 1, 1, 0]);
    expect(ece).toBeCloseTo(0.175 + 0.175, 12);
  });

  it('长度不等 throw；空输入 0；conf 越界或 bins 非法 throw', () => {
    expect(() => calibrationEce([0.5], [], 10)).toThrow(/长度不一致/);
    expect(calibrationEce([], [])).toBe(0);
    expect(() => calibrationEce([1.5], [1])).toThrow(/conf/);
    expect(() => calibrationEce([0.5], [1], 0)).toThrow(/bins/);
  });
});

describe('eval/passAt1（主指标，greedy 每题一次）', () => {
  it('与独立手跑 rollout 的 solved/total/passRate/CI 全一致', () => {
    const tasks = [1, 2, 3].map((seed) => taskFor('follow', 'value', [seed]));
    const policy = Policy.random(9);
    const manualSolved = tasks.filter((t) => rollout(policy, GRAPH, t, true).accepted).length;
    const report = passAt1(policy, GRAPH, tasks);
    expect(report.total).toBe(3);
    expect(report.solved).toBe(manualSolved);
    expect(report.passRate).toBe(manualSolved / 3);
    expect(report.ci95).toEqual(wilson(report.passRate, 3));
    expect(report.ci95).toEqual(ci95(report.passRate, 3));
  });

  it('空任务集 → 0 与 [0,0]，不抛', () => {
    const report = passAt1(Policy.random(1), GRAPH, []);
    expect(report).toEqual({ solved: 0, total: 0, passRate: 0, ci95: [0, 0] });
  });
});

describe('eval/pathExcess（仅 follow 族、只统计 accepted）', () => {
  it('混合 style 输入：数值与手工重算一致，goal 任务不参与', () => {
    const tasks: Task[] = [
      taskFor('follow', 'value', [1]),
      taskFor('follow', 'verify', [31]),
      taskFor('goal', 'goal', [1]),
    ];
    const policy = Policy.random(9);
    let sum = 0;
    let count = 0;
    for (const t of tasks) {
      if (t.style !== 'follow') continue;
      const r = rollout(policy, GRAPH, t, true);
      if (!r.accepted) continue;
      sum += r.trace.length - 1 - t.plan_hidden.length;
      count++;
    }
    const res = pathExcess(policy, GRAPH, tasks);
    expect(res.successCount).toBe(count);
    expect(res.mean).toBeCloseTo(count === 0 ? 0 : sum / count, 12);
  });

  it('空输入 → mean 0、successCount 0', () => {
    expect(pathExcess(Policy.random(1), GRAPH, [])).toEqual({ mean: 0, successCount: 0 });
  });
});

describe('eval/stepsOverShortest（超预算记 ∞ 桶、不 raise）', () => {
  it('BFS 自身结果作 solvedPlans → excess=0；gold 回放计划的 excess = 长度差；未解任务跳过', () => {
    const t1 = taskFor('goal', 'goal', [1]);
    const t2 = taskFor('goal', 'goal_verify', [101]);
    const t3 = taskFor('goal', 'goal', [13]);
    const bfs1 = planBfs(t1, GRAPH);
    const bfs2 = planBfs(t2, GRAPH);
    expect(bfs1).not.toBeNull();
    expect(bfs2).not.toBeNull();
    const excess2 = t2.plan_hidden.length - bfs2!.length;
    expect(excess2).toBeGreaterThanOrEqual(0);
    const plans: ReadonlyMap<string, readonly string[]> = new Map([
      [taskHash(t1), bfs1!],
      [taskHash(t2), t2.plan_hidden],
    ]);
    const res = stepsOverShortest([t1, t2, t3], GRAPH, plans);
    expect(res.total).toBe(2);
    expect(res.overBudget).toBe(0);
    expect(res.meanExcess).toBeCloseTo((0 + excess2) / 2, 12);
  });

  it('planBfs 抛预算错误 → 记 overBudget 桶、进 total 不进均值、不 raise', () => {
    const good = taskFor('goal', 'goal', [2]);
    const boom: Task = { ...taskFor('goal', 'goal', [5]), instruction: BUDGET_BOOM };
    const plans: ReadonlyMap<string, readonly string[]> = new Map([
      [taskHash(good), planBfs(good, GRAPH)!],
      [taskHash(boom), boom.plan_hidden],
    ]);
    const res = stepsOverShortest([boom, good], GRAPH, plans);
    expect(res.overBudget).toBe(1);
    expect(res.total).toBe(2);
    expect(res.meanExcess).toBe(0);
  });
});

describe('eval/routingAcc（teacher-forced 诊断项）', () => {
  it('oracle 轨迹全比对：total = Σ步数，match 与手工重算一致（EXIT 步也计入）', () => {
    const policy = Policy.random(11);
    const tasks = [
      taskFor('follow', 'value', [77]),
      taskFor('goal', 'goal', [2]),
    ];
    let match = 0;
    let total = 0;
    for (const t of tasks) {
      for (const step of oracleTrace(t, GRAPH)) {
        total++;
        if (policy.act(t.instruction, step.obs, step.candidates, GRAPH, true) === step.action) {
          match++;
        }
      }
    }
    expect(total).toBeGreaterThan(tasks.length);
    expect(routingAcc(policy, GRAPH, tasks)).toEqual({ match, total });
  });

  it('oracleTrace 抛错的坏任务整条跳过，不缩水其它任务 total', () => {
    const broken: Task = {
      style: 'follow',
      family: 'value',
      instruction: '坏标签',
      x: 4,
      spec: {},
      expected: 999,
      plan_hidden: ['ghost_op'],
      root: 'Int',
      plan_hash: hashObj(['ghost_op']),
      composition_id: 'skel-broken-0',
      split: 'train',
    };
    const real = taskFor('follow', 'verify', [5]);
    const policy = Policy.random(13);
    expect(routingAcc(policy, GRAPH, [broken])).toEqual({ match: 0, total: 0 });
    expect(routingAcc(policy, GRAPH, [broken, real]).total).toBe(
      routingAcc(policy, GRAPH, [real]).total,
    );
  });
});
