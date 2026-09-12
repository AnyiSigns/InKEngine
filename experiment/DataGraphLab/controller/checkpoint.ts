/**
 * weights.json 读写——跨语言边界的唯一实现。
 *
 * 这份文件是 TS 推理侧与 Python 训练器之间唯一的权重通道：`data` 为数值数组，
 * 语义上是 float32（Python 侧以 np.float32 重建；JS 的 number 是 f64，写入前由
 * 数值入口保证每个值都是 float32 可精确表示的），结构 = 扁平数组 + shape。
 * `arch` 是“结构版本 + 特征集 + 精确 dims”的合一 pin：任何一侧改动都必须反映到
 * arch 串，加载时重算比对，不符即 fail-fast——禁止跨版本静默加载。
 *
 * `train_meta` 键名沿用跨语言契约的 snake_case（JSON 字段名，非 TS 标识符）；
 * 数值审计（shape×长度、NaN/Inf、dims 自洽）先于任何落盘与任何内存权重生成。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { ACT_DIM, FEATURE_SETS, OBS_DIM, type FeatureSet } from './features.js';
import { H, type HeadTag, type ParamTensor, type PolicyWeights } from './policy.js';

export const ARCH_VERSION = 1;

/** 规范 arch 串：结构版本、特征集、三块 dims、辅助头开关的合一指纹。 */
export function currentArch(featureSet: FeatureSet, head: HeadTag): string {
  return `v${ARCH_VERSION}:${featureSet}:${OBS_DIM[featureSet]}:${ACT_DIM}:${H}:${head}`;
}

export interface WeightsFile {
  readonly arch: string;
  readonly dims: {
    readonly featureSet: FeatureSet;
    readonly obsDim: number;
    readonly actDim: number;
    readonly h: number;
    readonly head: HeadTag;
  };
  readonly params: PolicyWeights;
  readonly train_meta: Record<string, unknown>;
}

const PARAM_KEYS = ['wo', 'bo', 'wa', 'ba', 'ws', 'wp', 'bp'] as const;
type ParamKey = (typeof PARAM_KEYS)[number];

function expectShapes(obsDim: number, head: HeadTag): Readonly<Record<ParamKey, readonly number[]>> {
  const detached = head === 'none';
  return {
    wo: [H, obsDim],
    bo: [H],
    wa: [H, ACT_DIM],
    ba: [H],
    ws: [H],
    wp: detached ? [0] : [H],
    bp: detached ? [0] : [1],
  };
}

function fail(ctx: string, field: string, detail: string): never {
  throw new Error(`weights(${ctx}): 字段 ${field} ${detail}`);
}

function product(shape: readonly number[], ctx: string, key: ParamKey): number {
  let n = 1;
  for (const d of shape) {
    if (!Number.isInteger(d) || d < 0) fail(ctx, `params.${key}.shape`, `含非法维 ${String(d)}`);
    n *= d;
  }
  return n;
}

/** 单个参数张量：shape 非负整数列表、data 全有限数、长度严格等于 shape 乘积。 */
function assertTensor(t: unknown, expect: readonly number[], ctx: string, key: ParamKey): ParamTensor {
  if (t === null || typeof t !== 'object') fail(ctx, `params.${key}`, '缺失或不是对象');
  const rec = t as { shape?: unknown; data?: unknown };
  if (!Array.isArray(rec.shape)) fail(ctx, `params.${key}.shape`, '不是数组');
  const shape = rec.shape as number[];
  if (!Array.isArray(rec.data)) fail(ctx, `params.${key}.data`, '不是数组');
  const data = rec.data as unknown[];
  const want = product(shape, ctx, key);
  if (shape.length !== expect.length || shape.some((d, i) => d !== expect[i])) {
    fail(ctx, `params.${key}.shape`, `为 [${shape}]，期望 [${expect}]`);
  }
  if (data.length !== want) {
    fail(ctx, `params.${key}.data`, `长度 ${data.length} 与 shape 乘积 ${want} 不符`);
  }
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      fail(ctx, `params.${key}.data[${i}]`, `值 ${String(v)} 非有限数`);
    }
  }
  return { shape, data: data as number[] };
}

/** 权重集整体校验：逐参数对照 dims 推出的期望 shape。obsDim 由 arch 层另行钉死。 */
export function assertParams(
  params: unknown,
  obsDim: number,
  head: HeadTag,
  ctx: string,
): PolicyWeights {
  if (params === null || typeof params !== 'object') fail(ctx, 'params', '缺失或不是对象');
  const rec = params as Record<string, unknown>;
  const shapes = expectShapes(obsDim, head);
  const out = {} as Record<ParamKey, ParamTensor>;
  for (const key of PARAM_KEYS) {
    out[key] = assertTensor(rec[key], shapes[key], ctx, key);
  }
  return out as PolicyWeights;
}

function headOf(v: unknown): HeadTag {
  if (v === 'progress' || v === 'none') return v;
  throw new Error(`weights: head 取值 ${String(v)} 不在 progress/none 之内`);
}

/** 文件级自检：字段齐、dims 与 arch 自洽、train_meta 为对象、params 逐张量校验。 */
function assertWeightsFile(file: unknown, ctx: string): WeightsFile {
  if (file === null || typeof file !== 'object') fail(ctx, 'root', '不是对象');
  const rec = file as Record<string, unknown>;
  if (typeof rec.arch !== 'string') fail(ctx, 'arch', '缺失或不是字符串');
  if (rec.dims === null || typeof rec.dims !== 'object') fail(ctx, 'dims', '缺失或不是对象');
  const dims = rec.dims as Record<string, unknown>;
  if (typeof dims.featureSet !== 'string' || !FEATURE_SETS.includes(dims.featureSet as FeatureSet)) {
    fail(ctx, 'dims.featureSet', `取值 ${String(dims.featureSet)} 非法`);
  }
  const featureSet = dims.featureSet as FeatureSet;
  const head = headOf(dims.head);
  if (dims.obsDim !== OBS_DIM[featureSet]) {
    fail(ctx, 'dims.obsDim', `为 ${String(dims.obsDim)}，特征集 ${featureSet} 应为 ${OBS_DIM[featureSet]}`);
  }
  if (dims.actDim !== ACT_DIM) fail(ctx, 'dims.actDim', `为 ${String(dims.actDim)}，应为 ${ACT_DIM}`);
  if (dims.h !== H) fail(ctx, 'dims.h', `为 ${String(dims.h)}，应为 ${H}`);
  const arch = rec.arch as string;
  const want = currentArch(featureSet, head);
  if (arch !== want) {
    fail(ctx, 'arch', `为 ${arch}，重算应为 ${want}（结构版本/dims/特征集不符，禁止跨版本静默加载）`);
  }
  if (rec.train_meta === null || typeof rec.train_meta !== 'object' || Array.isArray(rec.train_meta)) {
    fail(ctx, 'train_meta', '缺失或不是对象');
  }
  const params = assertParams(rec.params, dims.obsDim as number, head, ctx);
  return {
    arch,
    dims: { featureSet, obsDim: dims.obsDim as number, actDim: dims.actDim as number, h: dims.h as number, head },
    params,
    train_meta: rec.train_meta as Record<string, unknown>,
  };
}

/** 先自检后落盘，参数重塑为纯 JSON 数组；可读优先（缩进 2）。 */
export function writeWeightsJson(path: string, file: WeightsFile): void {
  const checked = assertWeightsFile(file, path);
  const params = checked.params as unknown as Record<ParamKey, ParamTensor>;
  const flat = {} as Record<ParamKey, { shape: number[]; data: number[] }>;
  for (const key of PARAM_KEYS) {
    flat[key] = { shape: [...params[key].shape], data: Array.from(params[key].data) };
  }
  const text = JSON.stringify(
    { arch: checked.arch, dims: checked.dims, params: flat, train_meta: checked.train_meta },
    null,
    2,
  );
  writeFileSync(path, text, 'utf8');
}

/** 读回即全量校验；`expect` 给定时按字段比对，不符 fail-fast。 */
export function readWeightsJson(
  path: string,
  expect?: { featureSet?: FeatureSet; head?: HeadTag },
): WeightsFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`weights(${path}): 读取失败 —— ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`weights(${path}): JSON 解析失败 —— ${e instanceof Error ? e.message : String(e)}`);
  }
  const file = assertWeightsFile(parsed, path);
  if (expect?.featureSet !== undefined && file.dims.featureSet !== expect.featureSet) {
    throw new Error(`weights(${path}): featureSet 为 ${file.dims.featureSet}，期望 ${expect.featureSet}`);
  }
  if (expect?.head !== undefined && file.dims.head !== expect.head) {
    throw new Error(`weights(${path}): head 为 ${file.dims.head}，期望 ${expect.head}`);
  }
  return file;
}
