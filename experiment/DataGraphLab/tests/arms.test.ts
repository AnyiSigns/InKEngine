/**
 * eval/arms 测试（C.7 三臂 + 两诊断/上界臂 + evaluateArm 口径）：
 * ①HeuristicArm 与 parseRecipe 手工参照逐字一致（同一函数同一输入）、lexicon 线性
 * 渲染可还原故 accepted 非零、goal 任务抛 N/A、gold 字段经 Proxy 毒化后 solve 照样
 * 完成（零泄漏的运行证）；②RandomArm 同 seed 逐字确定且与直接 rollout(Policy.random)
 * 一致（委托单一实现）、异 seed 权重必不同（轨迹不强断言，仅记录）；③TrainedArm 的
 * save→fromWeights 往返与注入同 seed Policy 逐字同解；④PlannerArm 对 goal 任务
 * accepted 必真且 trace 与 planBfs 同源、follow 抛 N/A、预算守卫先行；⑤ContractRouteArm
 * 确定性 + verify 族「先补 verdict 再 submit」的规则序（state 级场景）+ 真实 goal
 * 任务不抛错且 accepted 与 trace 重放一致；⑥evaluateArm 的 solved 与手工计数一致、
 * 策略臂逐字复用 passAt1（CI 同源）、style 过滤、N/A 记 applicable=false 全零、
 * 空集零值（ci95 走 metrics.js 同函数）。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ContractRouteArm,
  HeuristicArm,
  PlannerArm,
  RandomArm,
  TrainedArm,
  evaluateArm,
} from '../eval/arms.js';
import { ci95, passAt1 } from '../eval/metrics.js';
import { Policy } from '../controller/policy.js';
import { rollout, type RolloutResult, type RolloutStep } from '../runner/rollout.js';
import { MAX_STEPS, GRAPH, candidates } from '../runner/graph.js';
import { EXIT, applyOp, initState, obsSnapshot, type Graph, type State } from '../world/operators.js';
import { parseRecipe } from '../world/render.js';
import { planBfs } from '../teacher/search.js';
import { accept } from '../verify/acceptor.js';
import { makeTask } from '../gen/generator.js';
import type { Family, Style, Task } from '../schema.js';

/** 在连续 seed 上取第一个生成成功的真实任务（null 换下一 seed）。 */
function firstTask(style: Style, family?: Family, from = 1): Task {
  for (let seed = from; seed < from + 60; seed++) {
    const t = makeTask(seed, style, family);
    if (t !== null) return t;
  }
  throw new Error(`makeTask(style=${style}, family=${String(family)}) 于 seed ${from}.. 连续失败`);
}

/** 收集 n 个指定 style 的真实任务（家族不限，同 generator 的轮转口径）。 */
function collectTasks(style: Style, n: number, from = 1): Task[] {
  const out: Task[] = [];
  for (let seed = from; seed < from + 200 && out.length < n; seed++) {
    const t = makeTask(seed, style);
    if (t !== null) out.push(t);
  }
  if (out.length !== n) throw new Error(`collectTasks(${style}) 仅产出 ${out.length}/${n}`);
  return out;
}

/** 隐藏 gold 毒化代理：读 plan_hidden 即抛——期望臂不读，读了当场暴露。 */
function withoutGold(task: Task): Task {
  return new Proxy(task, {
    get(target, prop, receiver) {
      if (prop === 'plan_hidden') throw new Error('leak: plan_hidden 被读取');
      return Reflect.get(target, prop, receiver);
    },
  }) as Task;
}

/** 任务书钉死的手工参照：parseRecipe 输出逐步重放（在候选才走，错位跳步，末尾 EXIT）。 */
function heuristicReference(task: Task): RolloutStep[] {
  let st: State = initState(task.x, task.spec);
  const steps: RolloutStep[] = [];
  for (const opId of parseRecipe(task.instruction, task.root)) {
    const cand = candidates(GRAPH, st, st.hist);
    if (!cand.includes(opId)) continue;
    const next = applyOp(GRAPH, opId, st);
    if (next === null) continue;
    steps.push({ obs: obsSnapshot(st), candidates: cand, action: opId });
    st = next;
  }
  steps.push({ obs: obsSnapshot(st), candidates: candidates(GRAPH, st, st.hist), action: EXIT });
  return steps;
}

/** 独立重放 trace 求 accepted：verify 臂的 accepted 字段不许自说自话。 */
function replayAccepted(task: Task, result: RolloutResult): boolean {
  let st: State = initState(task.x, task.spec);
  for (const step of result.trace) {
    if (step.action === EXIT) return accept(task, st);
    const next = applyOp(GRAPH, step.action, st);
    if (next === null) return false;
    st = next;
  }
  return false;
}

describe('HeuristicArm：follow 重放 + 零泄漏 + goal N/A', () => {
  const arm = new HeuristicArm();
  const tasks = collectTasks('follow', 5);

  it('trace 与手工参照逐字一致（同一函数同一输入的逐步比对）', () => {
    for (const task of tasks) {
      const r = arm.solve(task, GRAPH);
      expect(r.trace).toEqual(heuristicReference(task));
      expect(r.trace[r.trace.length - 1]!.action).toBe(EXIT);
    }
  });

  it('lexicon 线性首现解析可还原（与 oracle 前缀同构）：seed 1..24 至少 1 例 accepted', () => {
    let solved = 0;
    for (let seed = 1; seed < 24; seed++) {
      const t = makeTask(seed, 'follow');
      if (t !== null && arm.solve(t, GRAPH).accepted) solved++;
    }
    expect(solved).toBeGreaterThan(0);
  });

  it('goal 任务 solve 抛 N/A（两 goal 族各验一个）', () => {
    for (const family of ['goal', 'goal_verify'] as const) {
      expect(() => arm.solve(firstTask('goal', family), GRAPH)).toThrow(/N\/A/);
    }
  });

  it('零泄漏：plan_hidden 毒化后 solve 照常完成且结果不变（expected 由 accept 合法读取）', () => {
    for (const task of tasks) {
      const r = arm.solve(task, GRAPH);
      const t2 = withoutGold(task);
      expect(() => arm.solve(t2, GRAPH)).not.toThrow();
      expect(arm.solve(t2, GRAPH).accepted).toBe(r.accepted);
    }
  });
});

describe('RandomArm：随机权重下界的确定性', () => {
  const task = firstTask('follow', 'value', 11);

  it('同 seed 两次 solve 逐字相同，且逐字等于直接 rollout(Policy.random(seed))', () => {
    const ref = rollout(Policy.random(7), GRAPH, task, true);
    expect(new RandomArm(7).solve(task, GRAPH)).toEqual(ref);
    const r1 = new RandomArm(2).solve(task, GRAPH);
    const r2 = new RandomArm(2).solve(task, GRAPH);
    expect(r2).toEqual(r1);
  });

  it('不同 seed 的权重必不同（轨迹允许同解——不强断言，仅记录）', () => {
    const a = new RandomArm(2);
    const b = new RandomArm(9, 'hash_only');
    expect(a.policy.params.wo.data).not.toEqual(b.policy.params.wo.data);
    void a.solve(task, GRAPH);
    void b.solve(task, GRAPH);
  });
});

describe('TrainedArm：Policy 注入 + fromWeights 权重往返', () => {
  const work = mkdtempSync(join(tmpdir(), 'dgl-arms-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const task = firstTask('follow', 'value', 5);

  it('save → fromWeights 与注入同 seed Policy 对同一任务逐字同解', () => {
    const path = join(work, 'weights.json');
    const direct = new TrainedArm(Policy.random(1)).solve(task, GRAPH);
    Policy.random(1).save(path);
    expect(TrainedArm.fromWeights(path).solve(task, GRAPH)).toEqual(direct);
    expect(TrainedArm.fromWeights(path, { featureSet: 'lang', head: 'progress' })
      .solve(task, GRAPH)).toEqual(direct);
  });

  it('fromWeights 走 Policy.load 的 arch fail-fast（head 期望不符当场抛）', () => {
    const path = join(work, 'headless.json');
    Policy.random(1, 'lang', 'none').save(path);
    expect(() => TrainedArm.fromWeights(path, { head: 'progress' })).toThrow(/head/);
  });
});

describe('PlannerArm：goal 公开规划上界（plan_bfs）', () => {
  it('goal 任务 accepted 必真（BFS 有解必找到），trace 恰为最短 plan + EXIT', () => {
    const arm = new PlannerArm();
    for (const family of ['goal', 'goal_verify'] as const) {
      const task = firstTask('goal', family, 9);
      const r = arm.solve(task, GRAPH);
      expect(r.accepted).toBe(true);
      const plan = planBfs(task, GRAPH);
      expect(plan).not.toBeNull();
      expect(r.trace.map((s) => s.action)).toEqual([...plan!, EXIT]);
      expect(replayAccepted(task, r)).toBe(true);
    }
  });

  it('N/A：任务书钉死 follow 族抛 N/A；确证无解按 {trace:[], accepted:false} 收口', () => {
    const arm = new PlannerArm();
    expect(() => arm.solve(firstTask('follow', 'value'), GRAPH)).toThrow(/N\/A/);
    const dead: Task = {
      style: 'goal',
      family: 'goal',
      instruction: '让值大于 9999',
      x: 3,
      spec: { goal: { kind: 'gt', target: 9999 } },
      expected: 9999,
      plan_hidden: [],
      root: 'Int',
      plan_hash: 'deadbeefdeadbeef',
      composition_id: 'none',
      split: 'heldout',
    };
    // 确证无解收口在小图（{add3, exit}）上测：全图整数值展开无界，未耗尽即超预算
    // throw（走姊妹分支），而小图 BFS 队列必然排空、plan_bfs 如实返回 null。
    const TINY: Graph = { nodes: { add3: GRAPH.nodes.add3!, exit: GRAPH.nodes.exit! } };
    expect(arm.solve(dead, TINY)).toEqual({ trace: [], accepted: false });
    expect(planBfs(dead, TINY)).toBeNull();
  });

  it('预算口径：超预算在 planBfs 出队点 fail-fast（本臂 catch 后记失败不 raise）', () => {
    const task = firstTask('goal', 'goal', 2);
    expect(() => planBfs(task, GRAPH, { nodeBudget: 0 })).toThrow(/budget/);
    expect(accept(task, initState(task.x, task.spec))).toBe(false);
  });
});

describe('ContractRouteArm：规则序与确定性（对照列，两 style 适用）', () => {
  const arm = new ContractRouteArm();

  it('state 级场景：family=verify 且 verdict 缺失 → 候选序首个 check_* 先于 submit', () => {
    const task: Task = {
      style: 'follow',
      family: 'verify',
      instruction: '（对照列臂不读指令——本字段故意置空仍须可解）',
      x: 7,
      spec: { parity: 1 },
      expected: 7,
      plan_hidden: [],
      root: 'Int',
      plan_hash: '0000000000000000',
      composition_id: 'none',
      split: 'val',
    };
    expect(planBfs(task, GRAPH)).not.toBeNull();
    const r = arm.solve(task, GRAPH);
    expect(r.trace[0]!.action).toBe('check_parity');
    expect(r.trace[1]!.action).toBe('submit');
    expect(r.trace[1]!.obs.verdict).not.toBeNull();
    const submitAt = r.trace.findIndex((s) => s.action === 'submit');
    const checkAt = r.trace.findIndex((s) => s.action.startsWith('check_'));
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(checkAt).toBeLessThan(submitAt);
  });

  it('goal 族规则 1：输入已达标 → 首步即 submit（goalOk 前置短路）', () => {
    const task: Task = {
      style: 'goal',
      family: 'goal',
      instruction: '不必读',
      x: 8,
      spec: { goal: { kind: 'gt', target: 5 } },
      expected: 8,
      plan_hidden: [],
      root: 'Int',
      plan_hash: '0000000000000000',
      composition_id: 'none',
      split: 'val',
    };
    const first = arm.solve(task, GRAPH).trace[0]!;
    expect(first.action).toBe('submit');
    expect(first.obs.answer).toBe(null);
  });

  it('确定性：两次 solve 逐字相同；真实 goal 任务不抛错且 accepted 与 trace 重放一致', () => {
    for (const task of collectTasks('goal', 3)) {
      const r1 = arm.solve(task, GRAPH);
      expect(arm.solve(task, GRAPH)).toEqual(r1);
      expect(r1.trace.length).toBeLessThanOrEqual(MAX_STEPS);
      expect(r1.accepted).toBe(replayAccepted(task, r1));
    }
  });
});

describe('evaluateArm：按 style 报告、N/A 记 N/A、CI 走 metrics.js', () => {
  const tasks = collectTasks('follow', 3, 12);

  it('RandomArm：手工数 accepted = solved；solved/total/passRate/ci95 与 passAt1 逐字一致', () => {
    const arm = new RandomArm(4);
    let manual = 0;
    for (const t of tasks) if (arm.solve(t, GRAPH).accepted) manual++;
    const rpt = evaluateArm(arm, tasks, GRAPH, 'follow');
    const ref = passAt1(arm.policy, GRAPH, tasks);
    expect(rpt.arm).toBe('random');
    expect(rpt.style).toBe('follow');
    expect(rpt.applicable).toBe(true);
    expect(rpt.solved).toBe(manual);
    expect(rpt).toEqual({
      arm: 'random', style: 'follow', applicable: true,
      solved: ref.solved, total: ref.total, passRate: ref.passRate, ci95: ref.ci95,
    });
  });

  it('HeuristicArm：solved 与逐题 solve 手工计数一致（参照已由组①钉死），CI 走 metrics.ci95 同源', () => {
    const arm = new HeuristicArm();
    const rpt = evaluateArm(arm, tasks, GRAPH, 'follow');
    let manual = 0;
    for (const t of tasks) if (arm.solve(t, GRAPH).accepted) manual++;
    expect(rpt.applicable).toBe(true);
    expect(rpt.solved).toBe(manual);
    expect(rpt.ci95).toEqual(ci95(rpt.passRate, rpt.total));
  });

  it('N/A 两情形：heuristic×goal、planner×follow → applicable=false、solved/total=0、passRate=0', () => {
    const goalTasks = collectTasks('goal', 2);
    expect(evaluateArm(new HeuristicArm(), goalTasks, GRAPH, 'goal')).toEqual({
      arm: 'heuristic', style: 'goal', applicable: false,
      solved: 0, total: 0, passRate: 0, ci95: [0, 0],
    });
    expect(evaluateArm(new PlannerArm(), tasks, GRAPH, 'follow')).toEqual({
      arm: 'planner', style: 'follow', applicable: false,
      solved: 0, total: 0, passRate: 0, ci95: [0, 0],
    });
  });

  it('style 过滤 + 空集零值 + 臂间互不串台（ContractRoute 两 style 皆 applicable）', () => {
    const goalTasks = collectTasks('goal', 2, 7);
    const mixed = [...tasks, ...goalTasks];
    expect(evaluateArm(new HeuristicArm(), mixed, GRAPH, 'follow').total).toBe(tasks.length);
    expect(evaluateArm(new PlannerArm(), mixed, GRAPH, 'goal').total).toBe(goalTasks.length);
    const empty = evaluateArm(new ContractRouteArm(), [], GRAPH, 'goal');
    expect(empty).toEqual({
      arm: 'contract_route', style: 'goal', applicable: true,
      solved: 0, total: 0, passRate: 0, ci95: [0, 0],
    });
    for (const style of ['follow', 'goal'] as const) {
      expect(evaluateArm(new ContractRouteArm(), mixed, GRAPH, style).applicable).toBe(true);
    }
  });
});
