/**
 * eval/arms HeuristicArm 组（自 tests/arms.test.ts 拆分，C.7 弱扫描臂语义，逐字未改）：
 * ①HeuristicArm 与测试内独立重算的弱词法扫描参照逐字一致（同语义非同源，同位命中按
 * LEX_OPS_BASE 固定序取首、不做类型消歧）；lexicon 线性渲染可还原故 accepted 非零；
 * 钉 reverse·`取反` 恒选 neg → reverse 任务稳定失败；goal 抛 N/A；零泄漏（gold 毒化
 * 照样完成）。其余臂（Random/Trained/Planner/ContractRoute/evaluateArm）见 arms.test.ts。
 */

import { describe, expect, it } from 'vitest';

import { HeuristicArm } from '../eval/arms.js';
import type { RolloutStep } from '../runner/rollout.js';
import { GRAPH, candidates } from '../runner/graph.js';
import { EXIT, LEX_OPS_BASE, applyOp, initState, obsSnapshot, type State } from '../world/operators.js';
import { LEXICON } from '../world/lexicon.js';
import { findSequence, senseTokens, tokens } from '../world/tokenize.js';
import { makeTask } from '../gen/generator.js';
import type { Task } from '../schema.js';
import { collectTasks, firstTask } from './fixtures_arms.js';

/** 隐藏 gold 毒化代理：读 plan_hidden 即抛——期望臂不读，读了当场暴露。 */
function withoutGold(task: Task): Task {
  return new Proxy(task, {
    get(target, prop, receiver) {
      if (prop === 'plan_hidden') throw new Error('leak: plan_hidden 被读取');
      return Reflect.get(target, prop, receiver);
    },
  }) as Task;
}

/** 手工参照：测试内独立重算弱扫描（首现位置升序、同位按 LEX_OPS_BASE 取首、无类型消歧），
 *  再逐步重放（在候选才走，错位跳步，末尾 EXIT）。 */
function heuristicReference(task: Task): RolloutStep[] {
  const toks = tokens(task.instruction);
  const byFirst = new Map<number, string[]>();
  for (const opId of LEX_OPS_BASE) {
    for (const sense of LEXICON[opId] ?? []) {
      const at = findSequence(toks, senseTokens(sense));
      if (at < 0 || byFirst.get(at)?.includes(opId)) continue;
      byFirst.set(at, [...(byFirst.get(at) ?? []), opId]);
    }
  }
  let st: State = initState(task.x, task.spec);
  const steps: RolloutStep[] = [];
  for (const at of [...byFirst.keys()].sort((a, b) => a - b)) {
    const chosen = byFirst.get(at)!.reduce((a, b) => (LEX_OPS_BASE.indexOf(b) < LEX_OPS_BASE.indexOf(a) ? b : a));
    const cand = candidates(GRAPH, st, st.hist);
    if (!cand.includes(chosen)) continue;
    const next = applyOp(GRAPH, chosen, st);
    if (next === null) continue;
    steps.push({ obs: obsSnapshot(st), candidates: cand, action: chosen });
    st = next;
  }
  steps.push({ obs: obsSnapshot(st), candidates: candidates(GRAPH, st, st.hist), action: EXIT });
  return steps;
}

describe('HeuristicArm：follow 重放 + 零泄漏 + goal N/A', () => {
  const arm = new HeuristicArm();
  const tasks = collectTasks('follow', 5);

  it('trace 与手工参照逐字一致（测试内独立弱扫描参照的逐步比对）', () => {
    for (const task of tasks) {
      const r = arm.solve(task, GRAPH);
      expect(r.trace).toEqual(heuristicReference(task));
      expect(r.trace[r.trace.length - 1]!.action).toBe(EXIT);
    }
  });

  it('非类型感知确实生效：reverse·`取反` 任务恒误选 neg 而失败（搜索式取任务）', () => {
    // 可产域恢复（R5）会改变同 seed 的采样消耗路径，不再依赖固定 seed 的任务
    // 形状——改为在 seed 空间里搜索「Str 骨架含 reverse、指令渲染出 `取反`、
    // 且弱扫描恰好因选 neg 跳过 reverse 步而失败」的任务形态（该形态 = 非类型
    // 感知的稳定失败源，S_heur≈0.98 的 1.7% 失败率），断言其 trace 无 reverse、
    // accepted=false。
    const found: Task[] = [];
    for (let seed = 0; seed < 2000 && found.length < 3; seed++) {
      const t = makeTask(seed, 'follow');
      if (t === null) continue;
      if (t.root !== 'Str' || !t.plan_hidden.includes('reverse') || !t.instruction.includes('取反')) continue;
      const r = arm.solve(t, GRAPH);
      if (r.accepted) continue;
      if (r.trace.some((s) => s.action === 'reverse')) continue; // 非目标形态：reverse 被执行
      found.push(t);
    }
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const t of found.slice(0, 3)) {
      expect([t.root, t.plan_hidden.includes('reverse'), t.instruction.includes('取反')]).toEqual(['Str', true, true]);
      expect(arm.solve(t, GRAPH).trace.some((s) => s.action === 'reverse')).toBe(false);
      expect(arm.solve(t, GRAPH).accepted).toBe(false);
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
