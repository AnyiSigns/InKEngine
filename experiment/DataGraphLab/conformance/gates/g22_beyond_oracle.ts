/**
 * G2.2 超 oracle 率（docs/gates.md G2.2 / 计划 A.2 钉死）：仅配方族（follow）。
 * 对 held-out follow 子集逐任务跑「深度限 goldLen−1 的 plan_bfs 早停」，统计被搜出
 * 存在**严格更短**验收解的任务占比——gold 的极小性本应由生成端守卫保证（恒等
 * 签名已去冗余丢弃、follow 极小性守卫挡「单算子+收尾提交」捷径），但该守卫只覆盖
 * 单算子形态；多算子组合下「某步在本 witness 上是恒等/值碰撞」造成的更短路径不在
 * 守卫覆盖内。实测此缺口显著（门禁小样 4 条全命中；完整 120 条 108 命中≈0.90），
 * 故本门如实红、阈值 0.02 固定不放宽（A.1/E.7），非零数字即自检证据。
 *
 * 抽样口径：`makeSplit('heldout', 2, 13)` 的 follow 子集（value/verify 各 2、共 4
 * 条）。小样是运行时约束——plan_bfs 在「无更短解」任务上需耗尽 gold−1 深球，单任务
 * 秒级；整批 120 条约 4 分钟，任何进程内同步块都会越过 vitest worker→main 的
 * 心跳（与 G0.1 把复算放进子进程同一规避动机）。4 条把单块压到数秒内，且实测率≈1
 * 时判决完全无歧义；完整 120 条统计量另在 README 报告，门禁筛查不替换主指标。
 *
 * 预算口径：plan_bfs 用缺省节点预算（超预算抛错由判定式按保守未命中处理并单列
 * `over_budget`，绝不静默）；分母恒为 follow 子集全体，不做任何筛选。
 */

import { beyondOracleRate, type BeyondOracleReport } from '../../eval/beyond_oracle.js';
import { GRAPH } from '../../runner/graph.js';
import { buildResult, memoized, type BatchSpec, type GateContext, type GateResult } from './common.js';

const VERSION = 1;
/** 阈值（A.2 固定值，禁改）；样本量下限阈只做子集哨兵，防掏空造成假通过。 */
const BEYOND_ORACLE_MAX = 0.02;
const TOTAL_MIN = 4;
const PER_FAMILY_MIN = 1;

/** 门禁固定批（口径论证见头注），经 genTasks 缓存，跨门禁确定性复用。 */
export const G22_SAMPLE_BATCH: BatchSpec = Object.freeze({
  split: 'heldout',
  perFamily: 2,
  seed: 13,
});

function pct(p: number): string {
  return p.toFixed(4);
}

function compute(ctx: GateContext): GateResult {
  const follow = ctx.genTasks(G22_SAMPLE_BATCH).filter((t) => t.style === 'follow');
  const rep: BeyondOracleReport = beyondOracleRate(follow, GRAPH);
  const nValue = follow.filter((t) => t.family === 'value').length;
  const nVerify = follow.length - nValue;
  const metrics: Record<string, number> = {
    beyond_oracle_rate: rep.rate,
    tasks_total: rep.total,
    hits: rep.hits,
    over_budget: rep.overBudget,
    n_value: nValue,
    n_verify: nVerify,
  };
  const thresholds: Record<string, number> = {
    'beyond_oracle_rate:max': BEYOND_ORACLE_MAX,
    'tasks_total:min': TOTAL_MIN,
    'n_value:min': PER_FAMILY_MIN,
    'n_verify:min': PER_FAMILY_MIN,
  };
  const sample = `抽样口径：makeSplit('heldout', ${String(G22_SAMPLE_BATCH.perFamily)}, ${String(G22_SAMPLE_BATCH.seed)}) 的 follow 子集=${String(rep.total)} 条（value=${String(nValue)}、verify=${String(nVerify)}），逐任务 plan_bfs 限深早停（goldLen−1）、缺省预算；完整 120 条统计量见 README（小样只为运行时约束，不改阈值）`;
  const budgetNote = rep.overBudget > 0 ? `；over_budget=${String(rep.overBudget)} 条按保守未命中计入分母，不静默` : '';
  const notes = rep.rate <= BEYOND_ORACLE_MAX
    ? `超 oracle 率=${pct(rep.rate)}（hits=${String(rep.hits)}/${String(rep.total)}）≤${String(BEYOND_ORACLE_MAX)}：批内实测命中数在阈值内${budgetNote}。${sample}`
    : `失败模式：超 oracle 率=${pct(rep.rate)}（hits=${String(rep.hits)}/${String(rep.total)}）>${String(BEYOND_ORACLE_MAX)}——生成端极小性守卫只挡「单算子+收尾提交」捷径，多算子组合下「冗余步在具体 witness 上恒等/值碰撞」与 decoy 可达解不在守卫覆盖内；非零如实报告即本门自检证据，阈值固定不放宽、基线不删（A.1/E.7）${budgetNote}。${sample}`;
  return buildResult({
    gate: 'G2.2',
    version: VERSION,
    ctx,
    seeds: [G22_SAMPLE_BATCH.seed],
    metrics,
    thresholds,
    notes,
  });
}

/** 公开入口：同一上下文只算一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G2.2', ctx, () => compute(ctx));
}
