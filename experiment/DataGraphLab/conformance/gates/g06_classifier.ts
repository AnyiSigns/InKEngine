/**
 * G0.6 的线性 softmax 分类器（词袋 + 数值的 multinomial logistic regression，
 * 与 pointer 控制器同架构族：线性打分 + argmax）。float32 参数 / float64 梯度
 * 累加；全批（minibatch=512，样本不足即整批）梯度下降；交叉熵带
 * label_smoothing=0.05、weight_decay 仅作用于权重不作用于偏置。早停按 val
 * 硬标签 CE、patience=10，保留最优 epoch 权重——训练完全由 seed 决定
 * （makeRng(seed) 初始化），无任何 Math.random。
 *
 * 特征只用公开指令（红线：spec/goal/expected 绝不入特征，标签由调用方单独
 * 传入）：GOAL_LEX 三类义项命中数/首现 + 指令数值（存在位/最小值/最大值，
 * /20 归一）+ crc32 词袋 256 桶（L2 归一）。不含 MENTION（配方族主信息）。
 */

import { crc32, hashObj } from '../../world/hash.js';
import { makeRng } from '../../world/rng.js';
import { GOAL_LEX } from '../../world/lexicon.js';
import { mentionStats, tokens } from '../../world/tokenize.js';

export const CLASS_KINDS: readonly string[] = ['all', 'gt', 'len', 'parity'];
export const HASH_DIM = 256;
/** 特征维数 = 6（GOAL_LEX hits/first ×3）+ 3（NUM）+ 256（hash 词袋）。 */
export const FEATURE_DIM = 265;

export interface HyperParams {
  readonly lr: number;
  readonly batch: number;
  readonly maxEpochs: number;
  readonly patience: number;
  readonly labelSmoothing: number;
  readonly weightDecay: number;
}

export const DEFAULT_HP: HyperParams = Object.freeze({
  lr: 3e-3,
  batch: 512,
  maxEpochs: 200,
  patience: 10,
  labelSmoothing: 0.05,
  weightDecay: 1e-4,
});

/**
 * 目标族公开指令 → 265 维 float32 特征（口径唯一，训练/评估共用）。
 *
 * 前 9 维标量特征乘 `SCALAR_GAIN` 标定：hash 词袋 L2 归一后单维典型幅度
 * ~0.1，而原始义项命中（0..2）与 /20 数值（0..1）在 lr=3e-3、batch=512 的
 * epoch 预算内梯度贡献过小，模型欠拟合到判据之下；同幅标定让信息维与词袋
 * 维在同一收敛尺度上（线性模型仅等价缩放，不引入非线性——这是该轮编码器
 * 迭代的唯一改动，首轮未标定实测见门禁 notes）。
 */
const SCALAR_GAIN = 6;

export function goalFeatures(instruction: string): Float32Array {
  const toks = tokens(instruction);
  const x = new Float32Array(FEATURE_DIM);
  const kinds = ['parity', 'gt', 'len'] as const;
  kinds.forEach((kind, i) => {
    const stats = mentionStats(toks, [...(GOAL_LEX[kind] ?? [])]);
    x[i * 2] = stats.hits * SCALAR_GAIN;
    x[i * 2 + 1] = (stats.first >= 0 && toks.length > 1 ? stats.first / (toks.length - 1) : 0) * SCALAR_GAIN;
  });
  // NUM：正则只扫指令文本字面数字（goal 句数值 = 阈值/端点，公开面）。
  const nums: number[] = [];
  for (const m of instruction.matchAll(/\d+(?:\.\d+)?/g)) nums.push(Number(m[0]));
  x[6] = (nums.length > 0 ? 1 : 0) * SCALAR_GAIN;
  if (nums.length > 0) {
    x[7] = (Math.min(...nums) / 20) * SCALAR_GAIN;
    x[8] = (Math.max(...nums) / 20) * SCALAR_GAIN;
  }
  // hash 词袋：crc32(token)%256 计数，L2 归一（词袋幅度不影响线性可分性判读）。
  const bag = new Float64Array(HASH_DIM);
  for (const tok of toks) bag[crc32(tok) % HASH_DIM] = (bag[crc32(tok) % HASH_DIM] ?? 0) + 1;
  let norm = 0;
  for (const v of bag) norm += v * v;
  norm = Math.sqrt(norm);
  const off = 9;
  for (let i = 0; i < HASH_DIM; i++) x[off + i] = norm > 0 ? bag[i]! / norm : 0;
  return x;
}

export interface Dataset {
  readonly X: readonly Float32Array[];
  readonly y: readonly number[];
}

export interface Model {
  readonly w: Float32Array;
  readonly b: Float32Array;
  readonly nClasses: number;
}

/**
 * 权重初始化。gates.md 超参只钉 lr/batch/epochs/patience/smoothing/wd/seed，
 * 未钉初始尺度：`initScale=0` 即零初始化（确定性由 seed 保证，与初始化无关）；
 * 缺省按 1/sqrt(D) 均匀小初值。
 */
export function initModel(seed: number, nClasses: number, initScale?: number): Model {
  const rng = makeRng(seed);
  const scale = initScale ?? 1 / Math.sqrt(FEATURE_DIM);
  const w = new Float32Array(FEATURE_DIM * nClasses);
  if (scale > 0) {
    for (let i = 0; i < w.length; i++) w[i] = rng.uniform(-scale, scale);
  }
  return { w, b: new Float32Array(nClasses), nClasses };
}

function logits(model: Model, x: Float32Array, out: Float64Array): void {
  const { w, b, nClasses } = model;
  out.fill(0);
  for (let c = 0; c < nClasses; c++) out[c] = b[c]!;
  for (let d = 0; d < FEATURE_DIM; d++) {
    const xv = x[d]!;
    if (xv === 0) continue;
    const base = d * nClasses;
    for (let c = 0; c < nClasses; c++) out[c] = out[c]! + xv * w[base + c]!;
  }
}

/** 数值稳定 softmax → 概率写回 out（就地）。 */
function softmax(out: Float64Array): number {
  let mx = Number.NEGATIVE_INFINITY;
  for (const v of out) if (v > mx) mx = v;
  let sum = 0;
  for (let c = 0; c < out.length; c++) {
    const e = Math.exp(out[c]! - mx);
    out[c] = e;
    sum += e;
  }
  for (let c = 0; c < out.length; c++) out[c] = out[c]! / sum;
  return mx;
}

/** 硬标签平均交叉熵（val 早停口径，不含平滑与正则）。 */
export function crossEntropy(model: Model, data: Dataset): number {
  if (data.X.length === 0) return 0;
  const probs = new Float64Array(model.nClasses);
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < data.X.length; i++) {
    logits(model, data.X[i]!, probs);
    softmax(probs);
    const p = probs[data.y[i]!]!;
    if (p <= 0 || !Number.isFinite(p)) {
      bad++;
      continue;
    }
    sum += -Math.log(p);
  }
  if (bad > 0) throw new Error(`classifier: ${String(bad)} 个样本 CE 数值非法（NaN/Inf fail-fast）`);
  return sum / data.X.length;
}

/** 单批梯度（float64 累加）→ 更新 float32 参数；返回该批平均平滑 CE。 */
function trainBatch(model: Model, data: Dataset, from: number, to: number, hp: HyperParams): number {
  const { w, b, nClasses } = model;
  const gradW = new Float64Array(w.length);
  const gradB = new Float64Array(nClasses);
  const probs = new Float64Array(nClasses);
  const n = to - from;
  let loss = 0;
  for (let i = from; i < to; i++) {
    const x = data.X[i]!;
    const y = data.y[i]!;
    logits(model, x, probs);
    softmax(probs);
    const eps = hp.labelSmoothing;
    for (let c = 0; c < nClasses; c++) {
      const target = c === y ? 1 - eps + eps / nClasses : eps / nClasses;
      gradB[c] = gradB[c]! + probs[c]! - target;
    }
    const py = probs[y]!;
    loss += -Math.log(py > 0 ? py : Number.EPSILON);
    for (let d = 0; d < FEATURE_DIM; d++) {
      const xv = x[d]!;
      if (xv === 0) continue;
      const base = d * nClasses;
      for (let c = 0; c < nClasses; c++) {
        gradW[base + c] = gradW[base + c]! + (probs[c]! - (c === y ? 1 - eps + eps / nClasses : eps / nClasses)) * xv;
      }
    }
  }
  const inv = 1 / n;
  for (let c = 0; c < nClasses; c++) b[c] = b[c]! - hp.lr * gradB[c]! * inv;
  for (let i = 0; i < w.length; i++) {
    w[i] = w[i]! - hp.lr * (gradW[i]! * inv + hp.weightDecay * w[i]!);
  }
  return loss / n;
}

export interface TrainResult {
  readonly model: Model;
  readonly bestEpoch: number;
  readonly bestValCe: number;
  readonly finalValCe: number;
}

/**
 * 训练：epoch 内按 batch=512 连续分块（确定性序，无 shuffle——全批口径下
 * 顺序唯一）；每 epoch 末算 val 硬 CE，创新低即快照权重、patience 归零，
 * 连续 patience 次不降则早停并回滚最优快照。`initScale` 透传给 initModel。
 */
export function trainClassifier(
  train: Dataset,
  val: Dataset,
  hp: HyperParams,
  seed: number,
  nClasses: number,
  initScale?: number,
): TrainResult {
  const model = initModel(seed, nClasses, initScale);
  let best: Model = { w: model.w.slice(), b: model.b.slice(), nClasses };
  let bestValCe = Number.POSITIVE_INFINITY;
  let bestEpoch = 0;
  let sinceBest = 0;
  let finalValCe = Number.POSITIVE_INFINITY;
  for (let epoch = 1; epoch <= hp.maxEpochs; epoch++) {
    for (let from = 0; from < train.X.length; from += hp.batch) {
      trainBatch(model, train, from, Math.min(from + hp.batch, train.X.length), hp);
    }
    finalValCe = crossEntropy(model, val);
    if (finalValCe < bestValCe - 1e-12) {
      bestValCe = finalValCe;
      bestEpoch = epoch;
      best = { w: model.w.slice(), b: model.b.slice(), nClasses };
      sinceBest = 0;
    } else {
      sinceBest++;
      if (sinceBest >= hp.patience) break;
    }
  }
  return { model: best, bestEpoch, bestValCe, finalValCe };
}

/** argmax 预测；并列按类索引小者（F.2 同口径的离散化）。 */
export function predict(model: Model, x: Float32Array): number {
  const probs = new Float64Array(model.nClasses);
  logits(model, x, probs);
  let bestC = 0;
  for (let c = 1; c < model.nClasses; c++) if (probs[c]! > probs[bestC]!) bestC = c;
  return bestC;
}

export interface EvalReport {
  readonly acc: number;
  readonly confusion: number[][];
}

export function evaluate(model: Model, data: Dataset): EvalReport {
  const c = model.nClasses;
  const confusion: number[][] = Array.from({ length: c }, () => new Array<number>(c).fill(0));
  let ok = 0;
  for (let i = 0; i < data.X.length; i++) {
    const pred = predict(model, data.X[i]!);
    confusion[data.y[i]!]![pred]!++;
    if (pred === data.y[i]) ok++;
  }
  return { acc: data.X.length > 0 ? ok / data.X.length : 0, confusion };
}

/** 混淆矩阵规范序列化（证据 csv 的行口径唯一）。 */
export function confusionCsv(seed: number, acc: number, confusion: readonly number[][]): string {
  const rows = [`seed=${String(seed)} acc=${acc.toFixed(6)} fp8=${hashObj(confusion).slice(0, 8)}`];
  for (let r = 0; r < confusion.length; r++) {
    rows.push(`${CLASS_KINDS[r]},` + confusion[r]!.map((v) => String(v)).join(','));
  }
  return rows.join('\n');
}
