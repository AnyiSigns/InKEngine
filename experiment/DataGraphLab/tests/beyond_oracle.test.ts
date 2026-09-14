/**
 * G2.2 超 oracle 率判定与门禁断言（R5 轨迹约束后定义性归零）。
 *
 * ① 判定式直测——R5 后真实 follow 任务（spec.trace 存在）的验收要求 hist ==
 * trace 精确匹配：plan_bfs 沿 trace 前缀剪枝，唯一解即金计划（等长），"严格
 * 更短"按定义不存在 ⇒ 全批零命中（G2.2 归零实证）。BFS 口径本身的边界用例
 * （等长不算超、补冗余恢复命中、超预算、退化 gold）用手工 **无 trace** 任务
 * 构造（spec:{} → 走完整 BFS 分支，旧语义仍可用）。
 * ② 门禁面——形状键齐全、`passed` 只由 `evaluateThresholds(metrics, thresholds)`
 * 复算（用例绝不手写布尔期望），阈值字面钉死 ≤0.02，同上下文 memoized 命中。
 *
 * 运行时纪律：R5 后 follow 任务的 plan_bfs 为 O(goldLen) 回溯（前缀剪枝），
 * 小批与门禁批都是瞬时的；完整 120 条统计量在 README，不进门禁。
 */

import { describe, expect, it } from 'vitest';

import { makeSplit } from '../gen/generator.js';
import { GRAPH } from '../runner/graph.js';
import { planBfs } from '../teacher/search.js';
import { beyondOracleRate } from '../eval/beyond_oracle.js';
import { applyOp, initState, type State } from '../world/operators.js';
import { accept } from '../verify/acceptor.js';
import { createGateContext } from '../conformance/gates/harness.js';
import { G22_SAMPLE_BATCH, run as runG22 } from '../conformance/gates/g22_beyond_oracle.js';
import { evaluateThresholds, gateShapeKeys } from '../conformance/gates/common.js';
import { hashObj } from '../world/hash.js';
import type { Task } from '../schema.js';

/** noUncheckedIndexedAccess 下取必存在 metric 的小提取器（缺键即当场炸）。 */
function num(v: number | undefined): number {
  if (v === undefined) throw new Error('门禁 metrics 缺必需键');
  return v;
}

/** 顺序回放到末态（与 G0.2 同构：initState → 逐算子 applyOp）。 */
function replayEnd(task: Task, plan: readonly string[]): State | null {
  let st = initState(task.x, task.spec);
  for (const op of plan) {
    const next = applyOp(GRAPH, op, st);
    if (next === null) return null;
    st = next;
  }
  return st;
}

/** 手工构造 follow 任务（spec 无 trace → 走完整 BFS 分支，供口径边界用例）。 */
function manualTask(plan_hidden: readonly string[], x: number | string, expected: number | string): Task {
  return {
    style: 'follow',
    family: 'value',
    instruction: '手工',
    x,
    spec: {},
    expected,
    plan_hidden: [...plan_hidden],
    root: typeof x === 'string' ? 'Str' : 'Int',
    plan_hash: hashObj(plan_hidden),
    composition_id: 'beyond-manual',
    split: 'heldout',
  };
}

interface Judgment {
  readonly sample: Task[];
  readonly witnesses: (string[] | null)[];
}
let judgment: Judgment | undefined;
/** 判定直测小批（每族 1 条取 follow 子集）：R5 后全部零命中（定义性归零）。 */
function prepare(): Judgment {
  if (judgment === undefined) {
    const sample = makeSplit('heldout', 1, 7).filter((t) => t.style === 'follow');
    const witnesses = sample.map((t) =>
      planBfs(t, GRAPH, { maxDepth: t.plan_hidden.length - 1 }),
    );
    // R5 归零实证：任何任务都不该再被搜出严格更短解。
    for (let i = 0; i < sample.length; i++) {
      if (witnesses[i] !== null) {
        throw new Error(`R5 归零被破坏：任务 ${sample[i]!.composition_id} 存在严格更短解`);
      }
    }
    judgment = { sample, witnesses };
  }
  return judgment;
}

describe('eval/beyondOracleRate：R5 归零 + BFS 口径边界', () => {
  it('真实 follow 批全零命中：聚合=0、分母=follow 全体、零超预算', () => {
    const { sample } = prepare();
    const rep = beyondOracleRate(sample, GRAPH);
    expect(rep.total).toBe(sample.length);
    expect(rep.hits).toBe(0);
    expect(rep.overBudget).toBe(0);
    expect(rep.rate).toBe(0);
    expect(beyondOracleRate(sample, GRAPH)).toEqual(rep);
  }, 120_000);

  it('R5 归零机制：plan_bfs 默认口径返回解 == gold（等长），重放穿验收', () => {
    const { sample } = prepare();
    let checked = 0;
    for (const task of sample) {
      const plan = planBfs(task, GRAPH)!;
      expect(plan).toEqual(task.plan_hidden);
      const end = replayEnd(task, plan);
      expect(end).not.toBeNull();
      expect(accept(task, end!)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  it('BFS 口径边界（手工无 trace 任务）：gold=全局最短不命中，补一步冗余恢复命中', () => {
    // x=4 mul2→8：最短解 [mul2,submit]。gold 就是它 → 早停深度 goldLen-1=1，
    // 同长验收解存在但不存在严格更短 → 不命中（把 gold 本身当捷径是本用例要挡的错误）。
    const sameLen = manualTask(['mul2', 'submit'], 4, 8);
    expect(accept(sameLen, replayEnd(sameLen, ['mul2', 'submit'])!)).toBe(true);
    expect(planBfs(sameLen, GRAPH, { maxDepth: 1 })).toBeNull();
    expect(beyondOracleRate([sameLen], GRAPH)).toEqual({
      total: 1, hits: 0, overBudget: 0, rate: 0,
    });
    // 挂一步收尾冗余（noop）：goldLen=3 → 早停深度 2，[mul2,submit] 严格更短 → 命中。
    const longer = manualTask(['mul2', 'noop', 'submit'], 4, 8);
    expect(beyondOracleRate([longer], GRAPH)).toEqual({
      total: 1, hits: 1, overBudget: 0, rate: 1,
    });
  }, 120_000);

  it('超预算（手工无 trace 任务）：保守未命中、单列计数、分母不变，绝不静默吞掉', () => {
    const searchable = [manualTask(['mul2', 'add3', 'submit'], 4, 11)];
    const rep = beyondOracleRate(searchable, GRAPH, { nodeBudget: 0 });
    expect(rep.total).toBe(searchable.length);
    expect(rep.hits).toBe(0);
    expect(rep.overBudget).toBe(searchable.length);
    expect(rep.rate).toBe(0);
  }, 60_000);

  it('gold 无展开余量的任务：不进 BFS、恒未命中但留在分母', () => {
    const oneStep = manualTask(['submit'], 4, 4);
    const empty = manualTask([], 4, 4);
    // 对照组是 nodeBudget=0：真进 BFS 的任务会立刻抛错并被记成 overBudget，
    // 这里 overBudget=0 恰好证明两条退化 gold 跳过搜索、只剩分母。
    const rep = beyondOracleRate([oneStep, empty, oneStep], GRAPH, { nodeBudget: 0 });
    expect(rep.total).toBe(3);
    expect(rep.hits).toBe(0);
    expect(rep.overBudget).toBe(0);
    expect(rep.rate).toBe(0);
  }, 60_000);

  it('goal 族混入 fail-fast；空批返回全零', () => {
    const goalTask = makeSplit('heldout', 1, 7).find((t) => t.style === 'goal')!;
    expect(() => beyondOracleRate([goalTask], GRAPH)).toThrow(/仅配方族/);
    expect(beyondOracleRate([], GRAPH)).toEqual({
      total: 0, hits: 0, overBudget: 0, rate: 0,
    });
  });
});

describe('门禁 G2.2 形状、阈值复算与确定性', () => {
  it('形状齐全、passed 由 thresholds 机器复算、阈值 0.02 字面钉死', () => {
    const ctx = createGateContext();
    const res = runG22(ctx);
    expect(res.gate).toBe('G2.2');
    expect(res.inputs_hash).toBe(ctx.inputsHash);
    expect(res.world_version).toBe(ctx.worldVersion);
    expect(res.seeds).toEqual([G22_SAMPLE_BATCH.seed]);
    for (const key of gateShapeKeys()) expect(res).toHaveProperty(key);
    expect(evaluateThresholds(res.metrics, res.thresholds)).toBe(res.passed);
    expect(res.thresholds['beyond_oracle_rate:max']).toBe(0.02);
    const m = res.metrics;
    const total = num(m.tasks_total);
    expect(total).toBe(G22_SAMPLE_BATCH.perFamily * 2);
    expect(num(m.n_value) + num(m.n_verify)).toBe(total);
    expect(num(m.hits)).toBeLessThanOrEqual(total);
    expect(num(m.beyond_oracle_rate)).toBeCloseTo(num(m.hits) / total, 15);
    expect(res.notes).toContain(`hits=${String(num(m.hits))}/${String(total)}`);
    expect(runG22(ctx)).toBe(res); // 同上下文记忆命中，不重复计算
  }, 180_000);
});
