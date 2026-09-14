/**
 * 评测指标（C.7/D 表）：端到端口径一律走 greedy rollout，每题只跑一次。
 *
 * `passAt1` 是主指标（按 style 分开报，95% CI 取 Wilson 区间——p 贴近 0/1 时
 * Wald 区间会出负下界或零宽，Wilson 仍合法且更保守）；`routingAcc` 只是诊断项：
 * `submit`/`check_*` 可交换、等价路径会被逐步比对判错，故不入门禁。
 * `pathExcess` 定义在配方族（gold 唯一才可比），目标族的多解冗余由
 * `stepsOverShortest` 对 BFS 穷尽最短解度量；预算耗尽的任务记 ∞ 桶、不 raise
 * （C.4 口径），避免单任务炸停整场评测。rollout/oracle/BFS 全部 import 既有
 * 唯一实现，本文件不重写任何环境循环。
 */

import { rollout } from '../runner/rollout.js';
import { planBfs } from '../teacher/search.js';
import { oracleTrace } from '../teacher/oracle.js';
import { taskHash, type Task } from '../schema.js';
import type { Graph } from '../world/operators.js';
import type { Policy } from '../controller/policy.js';

/** search 侧超预算错误的匹配串（teacher/search 出队点 fail-fast 的原文）。 */
const BUDGET_EXCEEDED = /search budget exceeded/;

export interface PassAt1Report {
  readonly solved: number;
  readonly total: number;
  readonly passRate: number;
  readonly ci95: readonly [number, number];
}

/**
 * Wilson score 95% 区间（z=1.96）：`center ± half`，钳到 [0,1]。n=0 无试验可
 * 约束，返回 [0,0] 而不是抛——统计集为空的调用方要的是可报告的零值。
 */
export function ci95(p: number, n: number): [number, number] {
  if (!(p >= 0 && p <= 1)) throw new Error(`ci95: p 必须在 [0,1]，收到 ${String(p)}`);
  if (!Number.isInteger(n) || n < 0) throw new Error(`ci95: n 必须为非负整数，收到 ${String(n)}`);
  if (n === 0) return [0, 0];
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** greedy 每题一次的端到端成功率，附 Wilson 95% CI（主指标）。 */
export function passAt1(policy: Policy, graph: Graph, tasks: readonly Task[]): PassAt1Report {
  const total = tasks.length;
  let solved = 0;
  for (const task of tasks) {
    if (rollout(policy, graph, task, true).accepted) solved++;
  }
  const passRate = total === 0 ? 0 : solved / total;
  return { solved, total, passRate, ci95: ci95(passRate, total) };
}

/**
 * 配方族路径冗余：`mean(len(ctrlPlan) − len(goldPlan))`，只统计 greedy 验收通过
 * 的任务。ctrlPlan 取 trace 中 EXIT 之前的动作数（trace 末步即 EXIT），goldPlan 取
 * `plan_hidden` 长度——两者都不含 EXIT 才可比（G2.2 同源口径）。goal 族 gold 不
 * 唯一（多解合法），传进来会被按 style 过滤掉，冗余该走 `stepsOverShortest`。
 */
export function pathExcess(
  policy: Policy,
  graph: Graph,
  tasks: readonly Task[],
): { readonly mean: number; readonly successCount: number } {
  let sum = 0;
  let successCount = 0;
  for (const task of tasks) {
    if (task.style !== 'follow') continue;
    const result = rollout(policy, graph, task, true);
    if (!result.accepted) continue;
    sum += result.trace.length - 1 - task.plan_hidden.length;
    successCount++;
  }
  return { mean: successCount === 0 ? 0 : sum / successCount, successCount };
}

/**
 * 目标族相对穷尽最短解的冗余步数。solvedPlans 键 = `taskHash(task)`、值 = 成功
 * rollout 的动作序列（不含 EXIT，由调用方从 trace 剥出）；不在表里的任务没有
 * ctrl 计划可量，不参与 total。每任务跑默认参数的 `planBfs`：抛「search budget
 * exceeded」记 overBudget 桶（C.4：进 total 不进均值，不 raise——∞ 冗余不该炸掉
 * 整场评测，但也绝不伪装成 0）；solvedPlans 声称解出而 BFS 判无解是矛盾输入，
 * 当场抛。
 */
export function stepsOverShortest(
  tasks: readonly Task[],
  graph: Graph,
  solvedPlans: ReadonlyMap<string, readonly string[]>,
): { readonly meanExcess: number; readonly overBudget: number; readonly total: number } {
  let sum = 0;
  let meanCount = 0;
  let overBudget = 0;
  let total = 0;
  for (const task of tasks) {
    const ctrlPlan = solvedPlans.get(taskHash(task));
    if (ctrlPlan === undefined) continue;
    total++;
    let bfsPlan: string[] | null;
    try {
      bfsPlan = planBfs(task, graph);
    } catch (err) {
      if (err instanceof Error && BUDGET_EXCEEDED.test(err.message)) {
        overBudget++;
        continue;
      }
      throw err;
    }
    if (bfsPlan === null) {
      throw new Error('stepsOverShortest: solvedPlans 标记已解出但 BFS 判无解（矛盾输入，当场暴露）');
    }
    // 冗余钳 ≥0：基准是 R5 后的 trace 前缀剪枝解（可能等于公开 gold 而非全局最短）或
    // 空 ctrlPlan（起点即验收、首步选 exit）时差值可为负——「比最短解还短」在此口径
    // 无语义，按 0 冗余计，负值不得回流拉低 meanExcess（C.8 消费方同此口径）。
    sum += Math.max(0, ctrlPlan.length - bfsPlan.length);
    meanCount++;
  }
  return { meanExcess: meanCount === 0 ? 0 : sum / meanCount, overBudget, total };
}

/**
 * 逐步路由准确率（teacher-forced，诊断项）：对 `oracleTrace` 的每步，在当刻 obs
 * 与候选上跑 greedy `policy.act`，与 gold action 比对；EXIT 步同样计入分母。
 * oracleTrace 抛错（计划回放穿不上验收等坏标签）即整任务跳过——total 只统计
 * 实际比对步数，不被坏任务膨胀，也不返回第二份跳过计数。
 */
export function routingAcc(
  policy: Policy,
  graph: Graph,
  tasks: readonly Task[],
): { readonly match: number; readonly total: number } {
  let match = 0;
  let total = 0;
  for (const task of tasks) {
    let trace;
    try {
      trace = oracleTrace(task, graph);
    } catch {
      continue;
    }
    for (const step of trace) {
      total++;
      if (policy.act(task.instruction, step.obs, step.candidates, graph, true) === step.action) {
        match++;
      }
    }
  }
  return { match, total };
}

/**
 * 校准误差 ECE：等宽 bins 分桶，`Σ |acc_b − conf_b| · n_b / n`（仅非空桶有贡献）。
 * confs 与 outcomes 长度不一致即抛（配对语义下没有"多余的一半"这种合法输入）。
 */
export function calibrationEce(
  confs: readonly number[],
  outcomes: readonly (0 | 1)[],
  bins = 10,
): number {
  if (confs.length !== outcomes.length) {
    throw new Error(`calibrationEce: 长度不一致 ${String(confs.length)} vs ${String(outcomes.length)}`);
  }
  if (!Number.isInteger(bins) || bins < 1) {
    throw new Error(`calibrationEce: bins 必须为正整数，收到 ${String(bins)}`);
  }
  const n = confs.length;
  if (n === 0) return 0;
  const cnt = new Array<number>(bins).fill(0);
  const confSum = new Array<number>(bins).fill(0);
  const outSum = new Array<number>(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const c = confs[i]!;
    if (!(c >= 0 && c <= 1)) throw new Error(`calibrationEce: conf[${i}] 必须在 [0,1]，收到 ${String(c)}`);
    const b = Math.min(bins - 1, Math.floor(c * bins));
    cnt[b] = (cnt[b] ?? 0) + 1;
    confSum[b] = (confSum[b] ?? 0) + c;
    outSum[b] = (outSum[b] ?? 0) + outcomes[i]!;
  }
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const nb = cnt[b] ?? 0;
    if (nb === 0) continue;
    ece += Math.abs((outSum[b] ?? 0) / nb - (confSum[b] ?? 0) / nb) * (nb / n);
  }
  return ece;
}
