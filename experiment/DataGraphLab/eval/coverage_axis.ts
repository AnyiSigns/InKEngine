/**
 * 组合覆盖度副轴（C.8「k% 曲线」，公开面经 eval/scale.ts 收敛）：训练骨架随机
 * 取 k%（每层同比例），剩余同源骨架产出的任务作组合测试集，画「组合成功率 ×
 * 训练骨架覆盖度」。主指标（N 实例曲线）不在此文件、两轴分列不互顶。
 *
 * 精简口径（相对主网格）：每 k 只训一个模型（coverageN 条、固定派生 seed），
 * 终点直接取 `params`（跳过末 K 快照选点）。测试集按「剩余骨架 × style × family
 * 覆盖构造、同骨架重试 ≤20 次」组装——train 域不像 heldout 那样有 UNPRODUCIBLE
 * 注册表背书，个别骨架（如全小写字母表下 `lower` 恒触发捷径守卫）天然产不出，
 * 如实跳过并计数返回，绝不让副轴整体崩。k=100 时剩余池按构造为空、n=0 如实
 * 上报（全覆盖下不存在未训组合）。所有随机一律 makeRng(seed)，禁 Math.random。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { _skelId, type Skel } from '../gen/skeletons.js';
import { codepointCompare } from '../gen/splits.js';
import { STYLES, _stratum, goalEligible, instanceTask } from '../gen/generator.js';
import { isGoalDomain } from '../gen/producibility.js';
import { makeRng } from '../world/rng.js';
import { crc32 } from '../world/hash.js';
import type { Style, Task } from '../schema.js';
import { Policy } from '../controller/policy.js';
import { readWeightsJson } from '../controller/checkpoint.js';
import { GRAPH } from '../runner/graph.js';
import { passAt1 } from './metrics.js';
import {
  buildSplitBin,
  runTrainer,
  sampleTasks,
  skeletonPool,
  type TrainerCall,
} from './scale_pipes.js';
import type { KcRow } from './scale_report.js';

export interface CoverageAxisInput {
  readonly coverageKs: readonly number[];
  readonly coverageN: number;
  readonly styleRatio: number;
  readonly runDir: string;
  readonly valBin: string;
  /** 训练器与选点无关的透传件（每 k 现场注入 train/bin 路径）。 */
  readonly trainer: string;
  readonly saveLastK: number;
  readonly extraArgs?: readonly string[];
  readonly timeoutMs?: number;
  /** 断点续跑：bin 与 weights 都在时跳过该 k 的构建与训练（口径与主网格一致）。 */
  readonly resume?: boolean;
}

export interface CoverageAxisResult {
  readonly rows: KcRow[];
  /** 每 k 因「产不出就跳过」损失的 (骨架×style×family) 组合数（sanity 透明化）。 */
  readonly skippedByK: Readonly<Record<number, number>>;
}

/** 每层同比例截取：层键定序稳定，shuffle 后取前 round(ratio·|层|)（k<100 兜底 1）。 */
function selectByRatio(pool: readonly Skel[], ratio: number, seed: number): Skel[] {
  const rng = makeRng(seed);
  const by = new Map<string, Skel[]>();
  for (const sk of pool) {
    const k = _stratum(sk);
    const cur = by.get(k);
    if (cur === undefined) by.set(k, [sk]);
    else cur.push(sk);
  }
  const keys = [...by.keys()].sort(codepointCompare);
  const out: Skel[] = [];
  for (const key of keys) {
    const members = by.get(key)!;
    const take = Math.min(members.length, Math.max(1, Math.round(ratio * members.length)));
    const shuffled = rng.shuffle(members);
    out.push(...shuffled.slice(0, take));
  }
  return out.sort((a, b) => codepointCompare(_skelId(a), _skelId(b)));
}

/**
 * 剩余骨架的覆盖测试集：每（骨架 × style × family）至多 1 条，同骨架派生 seed
 * 重试 ≤20 次；不适格组合按构造跳过（不计 skipped——那是注册表口径），产不出
 * 才计。seed 由 `crc32(骨架id‖style‖family)` 派生，跨进程可复现。
 */
function buildAxisTestTasks(pool: readonly Skel[]): { tasks: Task[]; skipped: number } {
  const tasks: Task[] = [];
  let skipped = 0;
  for (const sk of pool) {
    const cid = _skelId(sk);
    for (const style of ['follow', 'goal'] as const) {
      for (const fam of STYLES[style]) {
        if (isGoalDomain(fam) && !goalEligible(sk.root, sk.plan)) continue;
        const base = crc32(`${cid}|${style}|${String(fam)}`);
        let task: Task | null = null;
        for (let attempt = 0; attempt < 20 && task === null; attempt++) {
          const cand = instanceTask(makeRng(base + attempt * 100003), sk.root, sk.plan, fam, style);
          if (cand !== null && cand.split === 'train') task = cand;
        }
        if (task === null) skipped++;
        else tasks.push(task);
      }
    }
  }
  return { tasks, skipped };
}

/** k% 轴全流程：每 k 训一评二（两 style）；行数恒 2×|ks|（空集如实 n=0）。 */
export function runCoverageAxis(input: CoverageAxisInput): CoverageAxisResult {
  const all = skeletonPool('train');
  const allIds = new Set(all.map((sk) => _skelId(sk)));
  const rows: KcRow[] = [];
  const skippedByK: Record<number, number> = {};
  for (const k of input.coverageKs) {
    if (!Number.isInteger(k) || k < 1 || k > 100) {
      throw new Error(`runCoverageAxis: k=${String(k)} 须为 [1,100] 整数`);
    }
    const axisSeed = (k * 1000003 + 7919) >>> 0;
    const sub = selectByRatio(all, k / 100, axisSeed);
    const subIds = new Set(sub.map((sk) => _skelId(sk)));
    const rest = all.filter((sk) => allIds.has(_skelId(sk)) && !subIds.has(_skelId(sk)));
    const built = buildAxisTestTasks(rest);
    skippedByK[k] = built.skipped;
    const trainTasks = sampleTasks(input.coverageN, axisSeed, sub, input.styleRatio);
    const storeRoot = join(input.runDir, 'store', `k${String(k)}`);
    const trainBin = join(input.runDir, `cov_k${String(k)}.bin`);
    const weights = join(input.runDir, `cov_k${String(k)}_weights.json`);
    if (!(input.resume === true && existsSync(trainBin) && existsSync(weights))) {
      buildSplitBin(trainTasks, storeRoot, trainBin);
      runTrainer({
        trainer: input.trainer,
        trainBin,
        valBin: input.valBin,
        outWeights: weights,
        saveLastK: input.saveLastK,
        extraArgs: input.extraArgs,
        timeoutMs: input.timeoutMs,
      });
    }
    const file = readWeightsJson(weights);
    const policy = new Policy(file.params, file.dims.featureSet, file.dims.head);
    for (const style of ['follow', 'goal'] as const) {
      const report = passAt1(policy, GRAPH, built.tasks.filter((t) => t.style === style));
      rows.push({ k, style: style as Style, pass1: report.passRate, n: report.total });
    }
  }
  return { rows, skippedByK };
}
