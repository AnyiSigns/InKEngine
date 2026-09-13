/**
 * F 门禁共享的纯数值件：权重校验、向量装配与 C.6 前向的 f64 重算路径。
 *
 * 本文件只做数学与形状校验、零 IO——fixture 读取与子进程编排在 f_gates.ts；
 * 前向公式照 C.6 逐式实现，与 controller/train_nn.py 的 policy_forward 同式
 * （f64 累加；BLAS 与 JS 循环的求和顺序差约 1e-14，远低于 F1 的 1e-6 门槛）。
 * 密集/稀疏向量与动作特征行表都从冻结 fixture 直读，本模块不做任何特征计算。
 */

/** F2 并列窗口（与 conformance/py_forward.py 的 TIE_WINDOW 同值）。 */
export const TIE_WINDOW = 1e-4;

export interface TensorLike {
  readonly shape: readonly number[];
  readonly data: readonly number[];
}

/** weights.json params 的跨语言子集：只含前向五张量（wp/bp 由 head=none 免载）。 */
export interface WeightsSubset {
  readonly wo: TensorLike;
  readonly bo: TensorLike;
  readonly wa: TensorLike;
  readonly ba: TensorLike;
  readonly ws: TensorLike;
}

/** 一维张量校验：shape 长度 1、data 长度与 shape 乘积一致、全有限数。 */
function oneDimOf(t: unknown, label: string): TensorLike {
  if (t === null || typeof t !== 'object') throw new Error(`${label}: 张量缺失`);
  const rec = t as TensorLike;
  if (!Array.isArray(rec.shape) || rec.shape.length !== 1) throw new Error(`${label}: 须为 1 维张量`);
  if (!Array.isArray(rec.data) || rec.data.length !== rec.shape[0]) {
    throw new Error(`${label}: data 长度与 shape 不符`);
  }
  for (const v of rec.data) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label}: data 含非有限数`);
  }
  return rec;
}

/** 多维张量校验：shape 与期望逐维相等、data 长度等于 shape 乘积、全有限数。 */
function tensorOf(t: unknown, label: string, shape: readonly number[]): TensorLike {
  if (t === null || typeof t !== 'object') throw new Error(`${label}: 张量缺失`);
  const rec = t as TensorLike;
  if (!Array.isArray(rec.shape) || !Array.isArray(rec.data)) throw new Error(`${label}: 缺 shape/data`);
  if (rec.shape.length !== shape.length || rec.shape.some((d, i) => d !== shape[i])) {
    throw new Error(`${label}: shape ${JSON.stringify(rec.shape)} 期望 ${JSON.stringify(shape)}`);
  }
  let n = 1;
  for (const d of shape) n *= d;
  if (rec.data.length !== n) {
    throw new Error(`${label}: data 长度 ${String(rec.data.length)} 与 shape 乘积 ${String(n)} 不符`);
  }
  for (const v of rec.data) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label}: data 含非有限数`);
  }
  return rec;
}

/** weights 段 → 五张量子集：以 bo 长度定 H，其余形状由 obsDim/actDim 交叉验证。 */
export function subsetOf(weights: unknown, obsDim: number, actDim: number, label: string): WeightsSubset {
  if (weights === null || typeof weights !== 'object') throw new Error(`${label}: weights 段缺失`);
  const rec = weights as Record<string, unknown>;
  const bo = oneDimOf(rec['bo'], `${label}/bo`);
  const h = bo.shape[0]!;
  const wo = tensorOf(rec['wo'], `${label}/wo`, [h, obsDim]);
  const wa = tensorOf(rec['wa'], `${label}/wa`, [h, actDim]);
  const ba = oneDimOf(rec['ba'], `${label}/ba`);
  const ws = oneDimOf(rec['ws'], `${label}/ws`);
  if (ba.shape[0] !== h || ws.shape[0] !== h) {
    throw new Error(`${label}: bo/ba/ws 维数不一致`);
  }
  return { wo, bo, wa, ba, ws };
}

/** 稀疏 {idx,val} 或稠密数组 → 稠密 f64 向量；下标越界 fail-fast，不静默截断。 */
export function denseOf(vec: unknown, dim: number, label: string): Float64Array {
  const out = new Float64Array(dim);
  if (vec === null || typeof vec !== 'object') throw new Error(`${label}: 向量缺失`);
  if (Array.isArray(vec)) {
    if (vec.length !== dim) throw new Error(`${label}: 稠密长度 ${String(vec.length)} != ${String(dim)}`);
    for (let i = 0; i < dim; i++) out[i] = Number(vec[i]);
    return out;
  }
  const rec = vec as { idx?: unknown; val?: unknown };
  if (!Array.isArray(rec.idx) || !Array.isArray(rec.val) || rec.idx.length !== rec.val.length) {
    throw new Error(`${label}: 稀疏缺 idx/val 或长度不一致`);
  }
  for (let k = 0; k < rec.idx.length; k++) {
    const i = rec.idx[k];
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= dim) {
      throw new Error(`${label}: 稀疏下标 ${String(i)} 越界 [0, ${String(dim)})`);
    }
    out[i] = Number(rec.val[k]);
  }
  return out;
}

/** 候选动作特征行表 → f64 行数组；行宽与 actDim 不符即 fail-fast。 */
export function actsOf(feats: unknown, actDim: number, label: string): Float64Array[] {
  if (!Array.isArray(feats) || feats.length === 0) throw new Error(`${label}: 候选特征缺失或为空`);
  return feats.map((row, i) => {
    if (!Array.isArray(row) || row.length !== actDim) {
      throw new Error(
        `${label}[${String(i)}]: 特征行长度 ${String(Array.isArray(row) ? row.length : '缺')} != ${String(actDim)}`,
      );
    }
    const a = new Float64Array(actDim);
    for (let c = 0; c < actDim; c++) a[c] = Number(row[c]);
    return a;
  });
}

/**
 * C.6 前向的 f64 重算路径（与 train_nn.policy_forward 同式）：h = tanh(Wo·o+bo)、
 * z_i = tanh(Wa·a_i+ba)、s_i = w_s·(h⊙z_i)、候选集内 softmax（减 max 再指数）。
 * 全掩码为真时该 softmax 即标准 softmax，无掩码分支。
 */
export function forward64(w: WeightsSubset, obs: Float64Array, acts: readonly Float64Array[]): Float64Array {
  const h = w.ws.data.length;
  const obsDim = obs.length;
  const actDim = w.wa.shape[1]!;
  const hidden = new Float64Array(h);
  for (let r = 0; r < h; r++) {
    let acc = w.bo.data[r]!;
    const base = r * obsDim;
    for (let c = 0; c < obsDim; c++) acc += w.wo.data[base + c]! * obs[c]!;
    hidden[r] = Math.tanh(acc);
  }
  const zs: Float64Array[] = new Array(acts.length);
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]!;
    const z = new Float64Array(h);
    for (let r = 0; r < h; r++) {
      let acc = w.ba.data[r]!;
      const base = r * actDim;
      for (let c = 0; c < actDim; c++) acc += w.wa.data[base + c]! * a[c]!;
      z[r] = Math.tanh(acc);
    }
    zs[i] = z;
  }
  const s = new Float64Array(acts.length);
  for (let i = 0; i < acts.length; i++) {
    const z = zs[i]!;
    let acc = 0;
    for (let r = 0; r < h; r++) acc += w.ws.data[r]! * hidden[r]! * z[r]!;
    s[i] = acc;
  }
  let mx = s[0]!;
  for (let i = 1; i < s.length; i++) if (s[i]! > mx) mx = s[i]!;
  const p = new Float64Array(s.length);
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const e = Math.exp(s[i]! - mx);
    p[i] = e;
    sum += e;
  }
  if (!(sum > 0)) {
    p.fill(1 / s.length);
    return p;
  }
  for (let i = 0; i < s.length; i++) p[i] = p[i]! / sum;
  return p;
}

/** 前两名（并列取小下标为 i1，与 Python stable argsort 的 order[0] 同口径）。 */
export function topTwo(p: Float64Array): { i1: number; i2: number; v1: number; v2: number } {
  if (p.length < 2) throw new Error('F2: 候选数不足 2，无法判定 top2');
  let i1 = 0;
  let i2 = -1;
  let v1 = p[0]!;
  let v2 = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < p.length; i++) {
    const v = p[i]!;
    if (v > v1) {
      i2 = i1;
      v2 = v1;
      i1 = i;
      v1 = v;
    } else if (v > v2) {
      i2 = i;
      v2 = v;
    }
  }
  return { i1, i2, v1, v2 };
}
