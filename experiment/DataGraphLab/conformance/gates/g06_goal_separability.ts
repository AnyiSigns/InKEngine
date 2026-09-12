/**
 * G0.6 目标可分性（docs/gates.md G0.6，Phase 0 硬门禁）：只用公开指令特征
 * （GOAL_LEX 命中/首现 + NUM 数值 + crc32 词袋，绝不读 spec/goal/expected/MENTION）
 * 训练线性 softmax 分类器区分目标类别 {parity, gt, len, all}。数据来自
 * makeSplit 实际生成流的 goal 族任务：拟合=train 池、早停=val 池、评估=heldout 池，
 * 三池骨架（composition_id）互斥，heldout 与 train 零重叠当场复核；
 * 分类器固定超参、seed ∈ {0..4} 各训一次取均值（gates.md G0.6 五均值口径），
 * 5 seed 均值 top1 ≥ 0.90 判过、不达标只报失败模式不改阈值。
 * gold 类别标签（task.spec.goal.kind）仅作训练/评估标签，绝不进特征通道。
 */

import { writeFileSync } from 'node:fs';

import type { Goal } from '../../world/goal.js';
import type { Task } from '../../schema.js';
import { BATCH, buildResult, memoized, type GateContext, type GateResult } from './common.js';
import {
  CLASS_KINDS,
  DEFAULT_HP,
  confusionCsv,
  evaluate,
  goalFeatures,
  trainClassifier,
  type Dataset,
} from './g06_classifier.js';

const VERSION = 1;
const SEEDS: readonly number[] = [0, 1, 2, 3, 4];
const HELDOUT_PER_CLASS_MIN = 30;
/**
 * 编码器迭代轮次 M：轮 1（GOAL_LEX/NUM 原始幅度）实测 5-seed 均值 top1=0.7856
 * @epochs=200（欠拟合、all 类 26/111），未达 0.90；轮 2 = 标量维 ×6 与词袋
 * 同幅（见 goalFeatures），仍为线性 softmax 公开指令口径。A.2 预注册升级梯：
 * M 轮仍不达标 → `lang` 容量旋钮（H 128→256）→ `learned` 诊断臂 → 最后才
 * `struct` 并列主臂；本门禁只报失败模式与当前 M，不静默换臂、不改阈值。
 */
const ENCODER_ITERATION = 2;

const KIND_INDEX = new Map<string, number>(CLASS_KINDS.map((k, i) => [k, i]));

/** goal 族任务（goal 与 goal_verify 两 family，标签取公开侧 spec.goal.kind）。 */
function goalTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => t.style === 'goal');
}

function labelOf(task: Task): number {
  const goal = task.spec.goal as Goal | undefined;
  if (goal === undefined) throw new Error(`g06: goal 族任务缺 spec.goal（数据面破坏）`);
  const idx = KIND_INDEX.get(goal.kind);
  if (idx === undefined) throw new Error(`g06: 未知目标类别 ${goal.kind}`);
  return idx;
}

function toDataset(tasks: readonly Task[]): Dataset {
  return { X: tasks.map((t) => goalFeatures(t.instruction)), y: tasks.map(labelOf) };
}

function overlapCount(a: readonly Task[], b: readonly Task[]): number {
  const sa = new Set(a.map((t) => t.composition_id));
  let n = 0;
  for (const id of new Set(b.map((t) => t.composition_id))) if (sa.has(id)) n++;
  return n;
}

function perClass(tasks: readonly Task[]): number[] {
  const c = CLASS_KINDS.map(() => 0);
  for (const t of tasks) c[labelOf(t)]!++;
  return c;
}

function compute(ctx: GateContext): GateResult {
  const trainTasks = goalTasks(ctx.genTasks(BATCH.g06Train));
  const valTasks = goalTasks(ctx.genTasks(BATCH.g06Val));
  const heldoutTasks = goalTasks(ctx.genTasks(BATCH.g06Heldout));
  const train = toDataset(trainTasks);
  const val = toDataset(valTasks);
  const heldout = toDataset(heldoutTasks);

  const counts = perClass(heldoutTasks);
  const minPerClass = Math.min(...counts);
  const skeletonOverlap = overlapCount(trainTasks, heldoutTasks);

  const accs: number[] = [];
  const epochs: number[] = [];
  const valCes: number[] = [];
  const evals: { acc: number; confusion: number[][] }[] = [];
  for (const seed of SEEDS) {
    const t0 = trainClassifier(train, val, DEFAULT_HP, seed, CLASS_KINDS.length);
    const ev = evaluate(t0.model, heldout);
    accs.push(ev.acc);
    epochs.push(t0.bestEpoch);
    valCes.push(t0.bestValCe);
    evals.push(ev);
  }
  const lastConfusion = evals[evals.length - 1]!.confusion;
  const mean = accs.reduce((s, v) => s + v, 0) / accs.length;
  const variance = accs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / accs.length;
  const std = Math.sqrt(variance);

  const artifacts: string[] = [];
  if (ctx.outDir !== undefined) {
    const rows = [
      'seed,top1_acc,val_ce_best,best_epoch',
      ...SEEDS.map((seed, i) => `${String(seed)},${accs[i]!.toFixed(6)},${valCes[i]!.toFixed(6)},${String(epochs[i])}`),
      '',
      // 逐 seed 混淆矩阵（行=真实类，列=预测类，行头带 seed/acc/矩阵指纹）。
      ...SEEDS.map((seed, i) => confusionCsv(seed, accs[i]!, evals[i]!.confusion)),
    ];
    writeFileSync(`${ctx.outDir}/G0.6-top1.csv`, `${rows.join('\n')}\n`, 'utf8');
    artifacts.push(`${ctx.artifactPrefix}/G0.6-top1.csv`);
  }

  const failModes: string[] = [];
  if (mean < 0.9) {
    const perClassAcc = CLASS_KINDS.map((kind, c) => {
      const truth = lastConfusion[c]!.reduce((s, v) => s + v, 0);
      const hit = lastConfusion[c]![c]!;
      return `${kind} ${String(hit)}/${String(truth)}`;
    });
    failModes.push(`失败模式（seed=${String(SEEDS[SEEDS.length - 1])} 混淆：真实→命中）：${perClassAcc.join('; ')}`);
  }
  if (minPerClass < HELDOUT_PER_CLASS_MIN) {
    failModes.push(`heldout 每类 ${CLASS_KINDS.map((k, i) => `${k}=${String(counts[i])}`).join('/')} 不足 ${String(HELDOUT_PER_CLASS_MIN)}`);
  }

  return buildResult({
    gate: 'G0.6',
    version: VERSION,
    ctx,
    seeds: [...SEEDS, BATCH.g06Train.seed, BATCH.g06Val.seed, BATCH.g06Heldout.seed],
    metrics: {
      top1_acc_mean: mean,
      top1_acc_std: std,
      n_classes: CLASS_KINDS.length,
      heldout_per_class: minPerClass,
      encoder_iteration: ENCODER_ITERATION,
      train_n: trainTasks.length,
      heldout_n: heldoutTasks.length,
      skeleton_overlap_count: skeletonOverlap,
      best_epoch_mean: epochs.reduce((s, v) => s + v, 0) / epochs.length,
    },
    thresholds: {
      'top1_acc_mean:min': 0.9,
      'n_classes:eq': 4,
      'heldout_per_class:min': HELDOUT_PER_CLASS_MIN,
      'skeleton_overlap_count:eq': 0,
      'train_n:min': HELDOUT_PER_CLASS_MIN,
    },
    artifacts,
    notes: failModes.length === 0
      ? `5 seed top1=${accs.map((a) => a.toFixed(4)).join('/')}，均值 ${mean.toFixed(4)}；特征 265 维（GOAL_LEX+NUM+hash 词袋），不含 MENTION/spec/goal/expected；编码器第 ${String(ENCODER_ITERATION)} 轮（第 1 轮未标定实测 top1 均值 0.7856 不达标，失败模式=all 类欠拟合）`
      : `不达标不改阈值。${failModes.join(' ')}；当前编码器第 ${String(ENCODER_ITERATION)} 轮，按预注册梯级：M 轮上限内改编码器 → lang H128→256 → learned 臂 → struct 并列主臂（显式标注，禁静默替换）`,
  });
}

/** 公开入口：分类器训练昂贵，同一上下文只训一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G0.6', ctx, () => compute(ctx));
}
