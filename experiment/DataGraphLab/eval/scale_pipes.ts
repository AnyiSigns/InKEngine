/**
 * scaling 协议的共享数据管道（eval/scale.ts 与 demos/* 共用，公开面经 scale.ts 收敛）：
 * 骨架采样 → oracle 痕迹 → 临时 store（records.jsonl，受控 append/load 口径）→
 * featurize（records.bin v2）→ spawn 训练器（controller/train.py）。
 *
 * 标签纪律（E.13）：训练样本只有 on-path oracle——每条任务先过 `oracleTrace`
 * 的三重自检再 `recordFromStep` 落库，特征一律 `featurizeRecords` 唯一实现；
 * store 根目录固定在每个 run 的独立子目录下（测试注入临时目录），绝不写默认
 * `runs/records/` 公共根。greedy pass@1 每题一次（§11.3）由 eval/metrics 保证，
 * 采样侧同样全走 `makeRng(seed)`（G0.1），无 Math.random。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HELDOUT_SKELETONS,
  SKELETONS,
  STYLES,
  _stratum,
  compareStratum,
  goalEligible,
  instanceTask,
  splitOf,
  type Skel,
} from '../gen/generator.js';
import { codepointCompare } from '../gen/splits.js';
import { isGoalDomain } from '../gen/producibility.js';
import { _skelId } from '../gen/skeletons.js';
import { makeRng } from '../world/rng.js';
import type { Family, Split, Style, Task } from '../schema.js';
import { oracleTrace } from '../teacher/oracle.js';
import { GRAPH } from '../runner/graph.js';
import { append, load, recordFromStep, type StoreRecord } from '../data/store.js';
import { actionFeatureTable, featurizeRecords, writeRecordsBin } from '../data/records.js';
import { OBS_DIM } from '../controller/features.js';

/** 包根 = 本文件上两级（eval/ → DataGraphLab/），与 data/store.ts 同一取法。 */
export const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 仓库根 = 包根上两级（experiment/DataGraphLab → InkEngine），.venv 的锚点。 */
export const REPO_ROOT = dirname(dirname(PKG_ROOT));

/** 默认训练器解释器：仓库 `.venv`（Windows / POSIX 两种落位）。 */
export function defaultTrainerPath(): string {
  return process.platform === 'win32'
    ? join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
    : join(REPO_ROOT, '.venv', 'bin', 'python');
}

/** 某切分下的骨架池（码点序，跨进程稳定，G0.1）。 */
export function skeletonPool(split: Split): Skel[] {
  return SKELETONS.filter((sk) => splitOf(sk) === split).sort((a, b) =>
    codepointCompare(_skelId(a), _skelId(b)),
  );
}

/** held-out 统计集每族配额缺省：min(max(30, |HELDOUT_SKELETONS|), cap)（C.8）。 */
export function defaultHeldoutPerFamily(heldoutCap: number): number {
  return Math.min(Math.max(30, HELDOUT_SKELETONS.size), heldoutCap);
}

/**
 * 分层采样 N 条任务（C.8 训练集构造）：style 按 styleRatio 混合（rng(seed) 确定），
 * family 在 `STYLES[style]` 内随机，目标域族先过适格性闸（R2-P0-2）。每次采样
 * 用派生 seed 调 `instanceTask`，失败换 seed 重试，全局采样上限 N×5——耗尽即抛，
 * 不静默缺行（对齐 demos/generate_demo.ts 的行为）。
 */
export function sampleTasks(n: number, seed: number, pool: readonly Skel[], styleRatio: number): Task[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`sampleTasks: n=${String(n)} 须为正整数`);
  const by = new Map<string, Skel[]>();
  for (const sk of pool) {
    const k = _stratum(sk);
    const cur = by.get(k);
    if (cur === undefined) by.set(k, [sk]);
    else cur.push(sk);
  }
  if (by.size === 0) throw new Error('sampleTasks: 骨架池为空');
  const keys: string[] = [];
  for (const [k, arr] of by) {
    by.set(k, [...arr].sort((a, b) => codepointCompare(_skelId(a), _skelId(b))));
    keys.push(k);
  }
  keys.sort(compareStratum);
  const rng = makeRng(seed);
  const out: Task[] = [];
  let attempts = 0;
  const cap = n * 5;
  for (let i = 0; i < n; i++) {
    const style: Style = rng.uniform(0, 1) < styleRatio ? 'follow' : 'goal';
    let task: Task | null = null;
    while (task === null) {
      attempts++;
      if (attempts > cap) {
        throw new Error(`sampleTasks: ${String(attempts)} 次采样（上限 ${String(cap)}）仍不足 ${String(n)} 条`);
      }
      const fam: Family = rng.choice(STYLES[style]);
      const sk = rng.choice(by.get(rng.choice(keys))!);
      if (isGoalDomain(fam) && !goalEligible(sk.root, sk.plan)) continue;
      const cand = instanceTask(makeRng(seed + i * 1000 + attempts * 100003), sk.root, sk.plan, fam, style);
      if (cand !== null) task = cand;
    }
    out.push(task);
  }
  return out;
}

/** oracle 痕迹 → F.2 记录（逐任务逐步；`oracleTrace` 自带三重自检，坏标签当场抛）。 */
export function oracleRecords(tasks: readonly Task[]): StoreRecord[] {
  const out: StoreRecord[] = [];
  for (const task of tasks) {
    for (const step of oracleTrace(task, GRAPH)) out.push(recordFromStep(task, step));
  }
  return out;
}

/**
 * 任务集 → records.bin 派生缓存：先 append 进该 run 专属 store（走步级去重与
 * c_hash 审计的受控通道），再 load 回来 `featurizeRecords` 写 bin（与 CLI
 * `npx tsx data/records.ts` 同一实现路径，省去子进程；口径不变）。
 */
export function buildSplitBin(tasks: readonly Task[], storeRoot: string, outBin: string): void {
  if (tasks.length === 0) throw new Error('buildSplitBin: 任务集为空（train.py 对 nrows=0 拒训）');
  mkdirSync(storeRoot, { recursive: true });
  mkdirSync(dirname(outBin), { recursive: true });
  const split = tasks[0]!.split;
  append(oracleRecords(tasks), { outRoot: storeRoot });
  const rows = featurizeRecords(load(split, { outRoot: storeRoot }), 'lang');
  writeRecordsBin(outBin, rows, OBS_DIM.lang, actionFeatureTable());
}

export interface TrainerCall {
  readonly trainer: string;
  readonly trainBin: string;
  readonly valBin: string;
  readonly outWeights: string;
  readonly saveLastK: number;
  readonly extraArgs?: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * spawn 训练器（同进程 CLI 入口，train.py 的 `bc_train` 内外两层唯一口径）：
 * `trainer` 为解释器时按固定 argv 跑 `controller/train.py`；为 `.py` 桩脚本时
 * 用默认解释器执行该桩（fake-trainer 测试通道），其余 argv 同构。非 0 退出码
 * 抛错附 stderr 尾部，超时/无法启动（error）同样显式抛，不静默降级。
 */
export function runTrainer(call: TrainerCall): void {
  const isPyScript = call.trainer.toLowerCase().endsWith('.py');
  const argv = [
    '--train', call.trainBin,
    '--val', call.valBin,
    '--out', call.outWeights,
    '--save-last-k', String(call.saveLastK),
    ...(call.extraArgs ?? []),
  ];
  const [cmd, args] = isPyScript
    ? [defaultTrainerPath(), [call.trainer, ...argv]]
    : [call.trainer, ['controller/train.py', ...argv]];
  if (!existsSync(cmd)) throw new Error(`runTrainer: 解释器不存在 ${cmd}`);
  if (!existsSync(isPyScript ? call.trainer : join(PKG_ROOT, 'controller', 'train.py'))) {
    throw new Error('runTrainer: 训练脚本不存在（controller/train.py 或注入的桩）');
  }
  const res = spawnSync(cmd, args, {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    timeout: (call.timeoutMs ?? 0) > 0 ? call.timeoutMs : undefined,
    windowsHide: true,
  });
  if (res.error !== undefined) {
    throw new Error(`runTrainer: 进程启动失败 —— ${res.error.message}`);
  }
  if (res.status !== 0) {
    const tail = String(res.stderr ?? '').slice(-600);
    throw new Error(`runTrainer: 退出码 ${String(res.status)}（${cmd}）stderr 尾：\n${tail}`);
  }
}

/** 缺省 run 标识时间戳（UTC 紧凑格式，仅作目录名；报告内时间戳另记 ISO）。 */
export function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').split('.')[0]!;
}
