/**
 * G2.2 超 oracle 率判定与门禁断言。
 *
 * ① 判定式直测——命中必须由可独立回放的证词支撑（BFS 找到的更短计划重放到
 * `accept` 为真），边界钉死「等长不算超、严格更短才算」（把命中任务的 gold 换成
 * 等长的全局最短解必须不命中，补一步冗余才恢复命中）；超预算按保守未命中且单列
 * 计数、gold 无展开余量任务留在分母恒未命中、goal 族混入 fail-fast。
 * ② 门禁面——形状键齐全、`passed` 只由 `evaluateThresholds(metrics, thresholds)`
 * 复算（用例绝不手写布尔期望），阈值字面钉死 ≤0.02，同上下文 memoized 命中。
 *
 * 运行时纪律：plan_bfs 在「无更短解」任务上要耗尽 gold−1 深球，单任务秒级；判定
 * 直测用 held-out 每族 1 条的小批（数秒），门禁用 4 条筛查批（~3 s，见 g22 头注），
 * 都压在 vitest worker→main 心跳之下（完整 120 条统计量在 README，不进门禁）。
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

interface Judgment {
  readonly sample: Task[];
  readonly witnesses: (string[] | null)[];
  readonly hitIdx: number;
}
let judgment: Judgment | undefined;
/** 判定直测小批（每族 1 条取 follow 子集）与各任务严格更短证词；须含至少一条命中。 */
function prepare(): Judgment {
  if (judgment === undefined) {
    const sample = makeSplit('heldout', 1, 7).filter((t) => t.style === 'follow');
    const witnesses = sample.map((t) =>
      planBfs(t, GRAPH, { maxDepth: t.plan_hidden.length - 1 }),
    );
    const hitIdx = witnesses.findIndex((p) => p !== null);
    if (hitIdx < 0) throw new Error('判定小批必须含命中任务，否则边界用例失去数据');
    judgment = { sample, witnesses, hitIdx };
  }
  return judgment;
}

describe('eval/beyondOracleRate：判定式与边界', () => {
  it('聚合值 = 逐任务证词之和，分母 = follow 全体，真实批零超预算', () => {
    const { sample, witnesses } = prepare();
    const rep = beyondOracleRate(sample, GRAPH);
    expect(rep.total).toBe(sample.length);
    expect(rep.hits).toBe(witnesses.filter((p) => p !== null).length);
    expect(rep.overBudget).toBe(0);
    expect(rep.rate).toBeCloseTo(rep.hits / rep.total, 15);
    expect(beyondOracleRate(sample, GRAPH)).toEqual(rep);
  }, 120_000);

  it('命中任务：更短证词严格短于 gold 且重放穿验收，单任务判定=1', () => {
    const { sample, witnesses } = prepare();
    let checked = 0;
    for (let i = 0; i < sample.length; i++) {
      const witness = witnesses[i]!;
      if (witness === null) continue;
      const task = sample[i]!;
      expect(witness.length).toBeLessThan(task.plan_hidden.length);
      const end = replayEnd(task, witness);
      expect(end, `证词计划回放死于契约闸: ${witness.join(', ')}`).not.toBeNull();
      expect(accept(task, end!)).toBe(true);
      expect(beyondOracleRate([task], GRAPH)).toEqual({
        total: 1, hits: 1, overBudget: 0, rate: 1,
      });
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);

  it('等长不算超：gold 换成等长全局最短解后不命中，补一步冗余才恢复命中', () => {
    const { sample, witnesses, hitIdx } = prepare();
    const task = sample[hitIdx]!;
    const witness = witnesses[hitIdx]!;
    // BFS 出队序保证 witness 就是全局最短；把它当 gold 复制出来即「等长」现场：
    // 同长验收解存在（gold 层恰有解），但不存在严格更短的——早停深度恰差一步，
    // 等长绝不记命中（把 gold 本身当捷径是本用例要挡的错误）。
    const sameLen: Task = { ...task, plan_hidden: [...witness] };
    expect(accept(sameLen, replayEnd(sameLen, witness)!)).toBe(true);
    expect(planBfs(sameLen, GRAPH, { maxDepth: witness.length - 1 })).toBeNull();
    expect(beyondOracleRate([sameLen], GRAPH)).toEqual({
      total: 1, hits: 0, overBudget: 0, rate: 0,
    });
    // 再挂一步收尾冗余：同一世界态里存在严格更短解 → 命中恢复。
    const longer: Task = { ...task, plan_hidden: [...witness, 'noop'] };
    expect(beyondOracleRate([longer], GRAPH)).toEqual({
      total: 1, hits: 1, overBudget: 0, rate: 1,
    });
  }, 120_000);

  it('超预算：保守未命中、单列计数、分母不变，绝不静默吞掉', () => {
    const { sample } = prepare();
    const searchable = sample.filter((t) => t.plan_hidden.length >= 2);
    expect(searchable.length).toBeGreaterThan(0);
    const rep = beyondOracleRate(searchable, GRAPH, { nodeBudget: 0 });
    expect(rep.total).toBe(searchable.length);
    expect(rep.hits).toBe(0);
    expect(rep.overBudget).toBe(searchable.length);
    expect(rep.rate).toBe(0);
  }, 60_000);

  it('gold 无展开余量的任务：不进 BFS、恒未命中但留在分母', () => {
    const { sample } = prepare();
    const oneStep: Task = { ...sample[0]!, plan_hidden: ['submit'] };
    const empty: Task = { ...sample[1]!, plan_hidden: [] };
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
