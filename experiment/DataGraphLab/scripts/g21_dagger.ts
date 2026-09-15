/**
 * G2.1 DAgger 偏离诊断（Phase 2 搜证，§10 G2.1 行）：从 BC s0 起步、逐迭代贪心
 * rollout 收 on-path 偏离行（correctGold，E.13 标签纪律）并入 oracle 基重训，
 * 记录偏离步分布 + 每 iter held-out pass@1，与纯 BC 对照。
 *
 * 预注册解读（§10 G2.1 行）：诊断项不作晋级门槛——首次偏离之前未经过的 off-path
 * 状态始终无监督，即便老师干预后亦然；偏离分布与 BC−DAgger held-out 差如实报告。
 * 输出全 ASCII 防控制台乱码。
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PKG_ROOT,
  defaultTrainerPath,
  sampleTasks,
  skeletonPool,
  stamp,
  oracleRecords,
  runTrainer,
} from '../eval/scale_pipes.js';
import { makeSplit } from '../gen/generator.js';
import { Policy } from '../controller/policy.js';
import { dagger } from '../runner/dagger.js';
import { passAt1 } from '../eval/metrics.js';
import { GRAPH } from '../runner/graph.js';
import { featurizeRecords } from '../data/records.js';
import { writeRecordsBin } from '../data/records_bin.js';
import { actionFeatureTable } from '../data/records.js';
import { OBS_DIM } from '../controller/features.js';
import { readWeightsJson } from '../controller/checkpoint.js';
import { selectCheckpoint } from '../eval/scale_report.js';
import type { StoreRecord } from '../data/store.js';

const runDir = join(PKG_ROOT, 'runs', `phase2-g21-${stamp()}`);
mkdirSync(runDir, { recursive: true });
const valBin = join(PKG_ROOT, 'runs', 'scale-20260915T00-a1-full', 'val.bin');
const bcWeights = join(PKG_ROOT, 'runs', 'scale-20260915T00-a1-full', 'trained_N10000_s0_weights.json');
if (!existsSync(valBin) || !existsSync(bcWeights)) throw new Error('缺 a1-full val.bin / BC weights');

// —— 初始 BC s0 policy（按 val 选点，与 scale 同口径）——
const file = readWeightsJson(bcWeights);
const valTasks = makeSplit('val', 200, 0);
const bcSel = selectCheckpoint(file, valTasks, 5);
const bcPolicy = bcSel.policy;
console.log(`[init] BC s0 selected epoch=${bcSel.selectedSnapshotEpoch} val_pass1=${bcSel.bestValPass1.toFixed(4)}`);

// —— oracle 基 = BC s0 训练集（cellSeed(10000,0) 复刻，apples-to-apples）——
const trainPool = skeletonPool('train');
const cellSeed = (n: number, seed: number): number =>
  (Math.imul(seed + 1, 2654435761) ^ Math.imul(n + 1, 40503)) >>> 0;
const oracleBase: StoreRecord[] = oracleRecords(sampleTasks(10000, cellSeed(10000, 0), trainPool, 0.5));
console.log(`[init] oracle base rows=${oracleBase.length}`);

const statTasks = makeSplit('heldout', 300, 0);
const goalSubset = statTasks.filter((t) => t.style === 'goal');
const followSubset = statTasks.filter((t) => t.style === 'follow');

let trainCbCalls = 0;
const trainCb = (rows: readonly StoreRecord[], _valRows: readonly StoreRecord[]): Policy => {
  const it = trainCbCalls++;
  const bin = join(runDir, `dagger_iter${it}.bin`);
  const w = join(runDir, `dagger_iter${it}_weights.json`);
  const feat = featurizeRecords(rows, 'lang');
  writeRecordsBin(bin, feat, OBS_DIM.lang, actionFeatureTable());
  runTrainer({ trainer: defaultTrainerPath(), trainBin: bin, valBin, outWeights: w, saveLastK: 5 });
  const f = readWeightsJson(w);
  return selectCheckpoint(f, valTasks, 5).policy;
};

const evalPass1 = (p: Policy): number => passAt1(p, GRAPH, goalSubset).passRate;

// —— DAgger 主编排 ——
const result = dagger(bcPolicy, {
  iterations: 3,
  tasksPerIter: 2000,
  maxFixes: 4,
  seed: 7,
  trainRows: oracleBase,
  taskProvider: (_rng, count, it) => sampleTasks(count, 7000 + it * 1000, trainPool, 0.5),
  train: trainCb,
  evalPass1,
});

// —— 偏离分布直方图（首次偏离步位 k = hist.length）——
const hist = new Map<number, number>();
for (const d of result.stats.firstDeviationDepths) hist.set(d, (hist.get(d) ?? 0) + 1);
const depthHist = [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, c]) => `k${k}:${c}`).join(' ');

// —— 终评：DAgger final vs BC s0（held-out follow + goal）——
const daggerFollow = passAt1(result.policy, GRAPH, followSubset).passRate;
const daggerGoal = passAt1(result.policy, GRAPH, goalSubset).passRate;
const bcFollow = passAt1(bcPolicy, GRAPH, followSubset).passRate;
const bcGoal = passAt1(bcPolicy, GRAPH, goalSubset).passRate;

const report = {
  g21_dagger: {
    iterations: result.iterations,
    stats: {
      rollouts: result.stats.rollouts,
      steps: result.stats.steps,
      deviatedSteps: result.stats.deviatedSteps,
      deviatedRollouts: result.stats.deviatedRollouts,
      rowsAddedPerIter: result.stats.rowsAddedPerIter,
      firstDeviationDepthHist: depthHist,
      passAt1GoalPerIter: result.stats.passAt1PerIter,
    },
    heldout: {
      dagger: { follow_pass1: daggerFollow, goal_pass1: daggerGoal },
      bc_s0: { follow_pass1: bcFollow, goal_pass1: bcGoal },
      delta: { follow: +(daggerFollow - bcFollow).toFixed(4), goal: +(daggerGoal - bcGoal).toFixed(4) },
    },
    interpretation: 'diagnostic only (plan G2.1 row): off-path states before first deviation remain unsupervised; deviation distribution + BC-DAgger held-out diff reported as-is, not a gate',
  },
  runDir,
};
writeFileSync(join(runDir, 'g21_report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  `G21_DONE deviatedRollouts=${result.stats.deviatedRollouts}/${result.stats.rollouts} deviatedSteps=${result.stats.deviatedSteps} ` +
    `rowsAdded=[${result.stats.rowsAddedPerIter.join(',')}] goalPerIter=[${result.stats.passAt1PerIter.map((v) => v?.toFixed(4) ?? 'null').join(',')}] ` +
    `heldout dagger(follow=${daggerFollow.toFixed(4)}/goal=${daggerGoal.toFixed(4)}) vs bc(follow=${bcFollow.toFixed(4)}/goal=${bcGoal.toFixed(4)}) | ${runDir}`,
);
