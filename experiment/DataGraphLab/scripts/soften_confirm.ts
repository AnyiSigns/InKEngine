/**
 * 标签软化门禁的统计集重测确认（§6 预注册 P75 规则）：
 * 以 held-out 统计集（4×300 = makeSplit('heldout', per_family=300, seed=0)）的
 * goal 族 oracle 记录为池，多 seed 重测 `safeActionConflictRate`（抽样 ≤200 状态、
 * bounded BFS 检索内核 data/conflict_bfs.ts），确认 rate ≥ 预注册阈值（首轮分布
 * P75 = 1.0；抽样/截断保守下 ≈0.999 视为满足，README 已登记开启条件满足）。
 *
 * 输出 runs/soften-confirm-<ts>/confirm.json：逐 seed rate + 分布汇总 + 结论。
 * 这是「先以统计集（4×300、多 seed）重测确认，再走 on-path 状态动作集软化」
 * 的确认证据，软化动作仍按 Phase 2 门禁内顺序执行。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PKG_ROOT, defaultHeldoutPerFamily, oracleRecords, stamp } from '../eval/scale_pipes.js';
import { makeSplit } from '../gen/generator.js';
import { safeActionConflictRate } from '../data/provenance.js';
import { HELDOUT_CAP } from '../eval/scale.js';

const runDir = join(PKG_ROOT, 'runs', `soften-confirm-${stamp()}`);
mkdirSync(runDir, { recursive: true });

// —— held-out 统计集（C.8：per_family=min(max(30,|HELDOUT_SKELETONS|),cap)）——
const perFamily = defaultHeldoutPerFamily(HELDOUT_CAP);
const statTasks = makeSplit('heldout', perFamily, 0);
const goalTasks = statTasks.filter((t) => t.style === 'goal');
const goalRecords = oracleRecords(goalTasks);
console.log(`[pool] stat tasks=${statTasks.length} goal tasks=${goalTasks.length} goal records=${goalRecords.length}`);

// —— 多 seed 重测（seed = 冲突率抽样子池的固定 seed，C.8 口径）——
const SEEDS = [0, 1, 2, 3, 4];
const perSeed: Array<{ seed: number; rate: number; sampled: number; conflictStates: number; truncatedStates: number; onPathPool: number }> = [];
for (const seed of SEEDS) {
  const rep = safeActionConflictRate(goalRecords, { tasks: goalTasks, seed, limit: 200 });
  perSeed.push({
    seed,
    rate: +rep.rate.toFixed(4),
    sampled: rep.sampled,
    conflictStates: rep.notes.conflictStates,
    truncatedStates: rep.notes.truncatedStates,
    onPathPool: rep.notes.onPathPool,
  });
  console.log(
    `[seed ${seed}] rate=${rep.rate.toFixed(4)} sampled=${rep.sampled} ` +
      `conflict=${rep.notes.conflictStates} truncated=${rep.notes.truncatedStates} onPathPool=${rep.notes.onPathPool}`,
  );
}

const rates = perSeed.map((r) => r.rate);
const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
const minRate = Math.min(...rates);
// 预注册阈值确定规则：首轮统计集 conflict rate 分布 P75 = 1.0（首轮冒烟 rate=1.0）。
// 判定口径（README 已登记）：rate ≈1.0 即满足；低于 1.0 的样本必须可全部归因于
// BFS 截断的保守计数（截断态不计冲突），不允许存在「非截断的真非冲突态」——
// 即每 seed 满足 conflictStates + truncatedStates === sampled 才算确认通过。
const threshold = 1.0;
const satisfied = perSeed.every((r) => r.conflictStates + r.truncatedStates === r.sampled);
const report = {
  gate: 'label-soften-confirm',
  protocol: '§6 P75 rule',
  statistical_set: { per_family: perFamily, families: ['value', 'verify', 'goal', 'goal_verify'], seed: 0 },
  conflict_rate: { seeds: SEEDS, per_seed: perSeed, mean: +mean.toFixed(4), min: +minRate.toFixed(4) },
  pre_registered_threshold: { rule: 'P75 of first-round statistical set distribution', value: threshold },
  conclusion: satisfied
    ? `confirmed (all ${String(SEEDS.length)} seeds: conflict+truncated == sampled, rate ${minRate.toFixed(4)}..1.0000 with only truncation-conservative dips; threshold ${threshold} by P75 rule); gate open, proceed to label softening`
    : `NOT confirmed (seed with non-truncation non-conflict state found)`,
  runDir,
};
writeFileSync(join(runDir, 'confirm.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`CONFIRM_DONE min=${minRate.toFixed(4)} mean=${mean.toFixed(4)} satisfied=${String(satisfied)} | ${runDir}`);
