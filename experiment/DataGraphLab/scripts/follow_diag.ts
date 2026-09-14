/**
 * R5 follow 分层诊断（2026-09-14，区分瓶颈归属）：
 * A. 按 goldLen 分组 pass@1（误差累积）；B. 按「含恒等冗余步」分组（可产域恢复的
 * 80 骨架近似特征）；C. teacher-forced routing_acc 按步位；D. trained 失败集 vs
 * 弱扫描失败集重叠（表示容量 vs 数据覆盖）。口径与 scale 报告一致：
 * 统计集 makeSplit('heldout', 300, 0) 的 follow 子集 600 条；选点 =
 * readWeightsJson + selectCheckpoint（val greedy pass@1，saveLastK=5）。
 */

import { join } from 'node:path';
import { readWeightsJson } from '../controller/checkpoint.js';
import { selectCheckpoint } from '../eval/scale_report.js';
import { makeSplit } from '../gen/generator.js';
import { candidates, GRAPH } from '../runner/graph.js';
import { HeuristicArm, TrainedArm } from '../eval/arms.js';
import { rollout } from '../runner/rollout.js';
import { applyOp, initState, obsSnapshot } from '../world/operators.js';
import { deepEq } from '../world/types.js';
import type { Task } from '../schema.js';

const RUN = 'runs/scale-20260914T23-r7-smoke';

const statFollow = makeSplit('heldout', 300, 0).filter((t) => t.style === 'follow');
console.log(`统计集 follow 任务数: ${statFollow.length}`);

/** 金计划算子段（submit 之前）逐步检测 x 是否不变（恒等冗余步近似判定）。 */
function hasIdentityStep(t: Task): boolean {
  let st = initState(t.x, t.spec);
  for (const op of t.plan_hidden) {
    if (op === 'submit') break;
    const next = applyOp(GRAPH, op, st);
    if (next === null) break;
    if (deepEq(next.x, st.x)) return true;
    st = next;
  }
  return false;
}

/** teacher-forced 逐步准确率（oracle 前缀状态下 greedy act 与 gold 比对）。 */
function routingAccByStep(policy: { act: (i: string, o: unknown, c: readonly string[], g: unknown, greedy: boolean) => string }, tasks: readonly Task[]): { step: number; acc: number; n: number }[] {
  const per = new Map<number, { ok: number; n: number }>();
  for (const t of tasks) {
    let st = initState(t.x, t.spec);
    for (let k = 0; k < t.plan_hidden.length; k++) {
      const cand = candidates(GRAPH, st, st.hist);
      const a = policy.act(t.instruction, obsSnapshot(st), cand, GRAPH, true);
      const rec = per.get(k) ?? { ok: 0, n: 0 };
      rec.n += 1;
      if (a === t.plan_hidden[k]) rec.ok += 1;
      per.set(k, rec);
      const next = applyOp(GRAPH, t.plan_hidden[k]!, st);
      if (next === null) break;
      st = next;
    }
  }
  return [...per.entries()].sort((a, b) => a[0] - b[0]).map(([step, v]) => ({ step, acc: v.ok / v.n, n: v.n }));
}

function diagnose(weightsPath: string, label: string): void {
  const file = readWeightsJson(weightsPath);
  const valTasks = makeSplit('val', 200, 0);
  const { policy } = selectCheckpoint(file, valTasks, 5);
  const arm = new TrainedArm(policy);
  const heur = new HeuristicArm();

  const solved: Record<string, { ok: number; total: number }> = {};
  const byLen = new Map<number, { ok: number; total: number }>();
  const byIdent = { no: { ok: 0, total: 0 }, yes: { ok: 0, total: 0 } };
  const heurFailAlso: { ok: number; total: number } = { ok: 0, total: 0 };
  let trainedFailOnHeurOk = 0;

  for (const t of statFollow) {
    const r = rollout(policy, GRAPH, t);
    const ok = r.accepted;
    solved[label] = { ok: (solved[label]?.ok ?? 0) + (ok ? 1 : 0), total: (solved[label]?.total ?? 0) + 1 };
    const rec = byLen.get(t.plan_hidden.length) ?? { ok: 0, total: 0 };
    rec.total += 1;
    if (ok) rec.ok += 1;
    byLen.set(t.plan_hidden.length, rec);
    const ident = hasIdentityStep(t) ? 'yes' : 'no';
    byIdent[ident].total += 1;
    if (ok) byIdent[ident].ok += 1;
    const heurOk = heur.solve(t, GRAPH).accepted;
    if (!ok) {
      if (heurOk) trainedFailOnHeurOk += 1;
      else heurFailAlso.total += 1;
    } else if (heurOk) {
      heurFailAlso.ok += 1;
    }
  }

  const fmt = (v: { ok: number; total: number }): string => `${v.ok}/${v.total} (${(v.ok / v.total).toFixed(4)})`;
  console.log(`\n===== ${label} =====`);
  console.log(`总体 pass@1: ${fmt(solved[label])}`);
  console.log(`A. goldLen 分组:`);
  for (const [len, v] of [...byLen.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  len${len}: ${fmt(v)}`);
  }
  console.log(`B. 含恒等冗余步: yes=${fmt(byIdent.yes)} no=${fmt(byIdent.no)}`);
  console.log(`C. routing_acc 按步位:`);
  for (const { step, acc, n } of routingAccByStep(policy, statFollow)) {
    console.log(`  step${step}: ${acc.toFixed(4)} (n=${n})`);
  }
  console.log(`D. 失败集重叠: trained 失败且弱扫描也失败=${heurFailAlso.total}；trained 失败但弱扫描成功=${trainedFailOnHeurOk}`);
}

diagnose(join(RUN, 'trained_N10000_s0_weights.json'), '10k-s0');
diagnose(join(RUN, 'trained_N10000_s1_weights.json'), '10k-s1');
diagnose(join(RUN, 'trained_N10000_s2_weights.json'), '10k-s2');
