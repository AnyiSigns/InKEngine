/**
 * 可微控制器推理面：factorized bilinear pointer 前向 + 动作选择。
 *
 * 打分式：`h = tanh(Wo·o + bo)`，每候选 `z_i = tanh(Wa·a_i + ba)`，分数
 * `s_i = w_s·(h ⊙ z_i)`，候选集内 softmax。指针用逐元素乘法交互而非拼接后接
 * MLP：候选数可变（动态动作集），乘法交互让每候选打分严格 O(H)，且对候选置换
 * 等变——分数只依赖 (obs, 该候选契约)，不存在“先见到谁”的顺序偏置；拼接 MLP 会
 * 把 obs 段重复 m 份乘进第一层参数，规模随候选数平方涨。
 *
 * 并列取最小下标：本实现为精确并列取最小下标；「并列窗口判等」（|top1 − top2|
 * 小于阈值即视为并列）尚未实现，属 F2 conformance 比对侧职责，届时实现——
 * 推理侧只保证两侧对精确并列可用同一条确定规则复现同一 argmax。
 *
 * 反向（grad/Adam）不在这里——训练器是 Python 唯一实现，本文件只做推理。
 * 前向一律 float64 累加、末尾 cast float32：判“数学等价”用高精度路径（F1 口径），
 * 推理输出仍是 float32。权重内部只存不可变副本，动作嵌入按图缓存是安全的。
 */

import { ROUTING, type Graph } from '../world/operators.js';
import { makeRng, type Rng } from '../world/rng.js';
import {
  ACT_DIM,
  OBS_DIM,
  featurizeAction,
  featurizeObs,
  type FeatureSet,
  type ObsView,
} from './features.js';
import {
  assertParams,
  currentArch,
  readWeightsJson,
  writeWeightsJson,
  type WeightsFile,
} from './checkpoint.js';

export const H = 128;

export type HeadTag = 'progress' | 'none';

export interface ParamTensor {
  readonly shape: readonly number[];
  readonly data: readonly number[];
}

/**
 * 参数布局（data 为 row-major 展平）：wo [H,obsDim]、bo [H]、wa [H,ACT_DIM]、
 * ba [H]、ws [H]；进度 critic 头 wp [H]、bp [1]（head='none' 时两者为空 [0]）。
 */
export interface PolicyWeights {
  readonly wo: ParamTensor;
  readonly bo: ParamTensor;
  readonly wa: ParamTensor;
  readonly ba: ParamTensor;
  readonly ws: ParamTensor;
  readonly wp: ParamTensor;
  readonly bp: ParamTensor;
}

export class Policy {
  readonly featureSet: FeatureSet;
  readonly head: HeadTag;
  readonly obsDim: number;
  readonly params: PolicyWeights;

  private readonly wo: Float64Array;
  private readonly bo: Float64Array;
  private readonly wa: Float64Array;
  private readonly ba: Float64Array;
  private readonly ws: Float64Array;
  private readonly wp: Float64Array;
  private readonly bp0: number;
  private readonly embedCache = new WeakMap<Graph, ReadonlyMap<string, Float64Array>>();

  constructor(w: PolicyWeights, featureSet: FeatureSet, head: HeadTag) {
    const obsDim = OBS_DIM[featureSet];
    this.params = assertParams(w, obsDim, head, 'Policy');
    this.featureSet = featureSet;
    this.head = head;
    this.obsDim = obsDim;
    this.wo = new Float64Array(this.params.wo.data);
    this.bo = new Float64Array(this.params.bo.data);
    this.wa = new Float64Array(this.params.wa.data);
    this.ba = new Float64Array(this.params.ba.data);
    this.ws = new Float64Array(this.params.ws.data);
    this.wp = new Float64Array(this.params.wp.data);
    this.bp0 = head === 'progress' ? this.params.bp.data[0]! : 0;
  }

  /**
   * 确定性初始化：wo ~ U(±1/√obsDim)，wa ~ U(±1/√ACT_DIM)，ws/wp ~ U(±1/√H)，
   * bo/ba/bp 全零；逐值经 Float32Array 落数（舍入到最近 float32），满足
   * checkpoint 的 f32 执法（同 seed 同特征集下两个实例参数逐位相同，作
   * REINFORCE 同 seed 随机 init 对照时用）。
   */
  static random(seed: number, featureSet: FeatureSet = 'lang', head: HeadTag = 'progress'): Policy {
    const obsDim = OBS_DIM[featureSet];
    const rng = makeRng(seed);
    const uniformFill = (n: number, scale: number): number[] => {
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = rng.uniform(-scale, scale);
      return Array.from(f);
    };
    const zeros = (n: number): number[] => new Array<number>(n).fill(0);
    return new Policy(
      {
        wo: { shape: [H, obsDim], data: uniformFill(H * obsDim, 1 / Math.sqrt(obsDim)) },
        bo: { shape: [H], data: zeros(H) },
        wa: { shape: [H, ACT_DIM], data: uniformFill(H * ACT_DIM, 1 / Math.sqrt(ACT_DIM)) },
        ba: { shape: [H], data: zeros(H) },
        ws: { shape: [H], data: uniformFill(H, 1 / Math.sqrt(H)) },
        wp: { shape: head === 'none' ? [0] : [H], data: head === 'none' ? [] : uniformFill(H, 1 / Math.sqrt(H)) },
        bp: { shape: head === 'none' ? [0] : [1], data: head === 'none' ? [] : zeros(1) },
      },
      featureSet,
      head,
    );
  }

  private assertVec(v: Float32Array, want: number, field: string): void {
    if (v.length !== want) {
      throw new Error(`Policy: ${field} 长度 ${v.length}，期望 ${want}（arch ${this.featureSet}）`);
    }
    for (let i = 0; i < v.length; i++) {
      const x = v[i]!;
      if (!Number.isFinite(x)) throw new Error(`Policy: ${field}[${i}] 非有限数 ${String(x)}`);
    }
  }

  /** h = tanh(Wo·o + bo)，row-major 展平、f64 累加。 */
  private hiddenOf(o: Float32Array): Float64Array {
    this.assertVec(o, this.obsDim, 'obs');
    const h = new Float64Array(H);
    for (let r = 0; r < H; r++) {
      const base = r * this.obsDim;
      let acc = this.bo[r]!;
      for (let c = 0; c < this.obsDim; c++) acc += this.wo[base + c]! * o[c]!;
      h[r] = Math.tanh(acc);
    }
    return h;
  }

  /** z = tanh(Wa·a + ba)。 */
  private zOf(a: Float32Array): Float64Array {
    this.assertVec(a, ACT_DIM, 'action');
    const z = new Float64Array(H);
    for (let r = 0; r < H; r++) {
      const base = r * ACT_DIM;
      let acc = this.ba[r]!;
      for (let c = 0; c < ACT_DIM; c++) acc += this.wa[base + c]! * a[c]!;
      z[r] = Math.tanh(acc);
    }
    return z;
  }

  /** 由 (h, z 列表) 出 softmax 概率：减 max 再 exp；分母非正时退回均匀。 */
  private probsOf(h: Float64Array, zs: readonly Float64Array[]): Float32Array {
    const m = zs.length;
    if (m === 0) throw new Error('Policy: 候选集为空，softmax 无定义');
    const s = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const z = zs[i]!;
      let acc = 0;
      for (let r = 0; r < H; r++) acc += this.ws[r]! * h[r]! * z[r]!;
      s[i] = acc;
    }
    let max = s[0]!;
    for (let i = 1; i < m; i++) if (s[i]! > max) max = s[i]!;
    const p = new Float32Array(m);
    let sum = 0;
    for (let i = 0; i < m; i++) {
      const e = Math.exp(s[i]! - max);
      p[i] = e;
      sum += e;
    }
    if (!(sum > 0)) {
      p.fill(1 / m);
      return p;
    }
    for (let i = 0; i < m; i++) p[i] = p[i]! / sum;
    return p;
  }

  /** 前向全链：obs 特征 + 候选动作特征 → 归一化概率（和为 1）。 */
  scoresFromObs(obsFeat: Float32Array, actFeats: readonly Float32Array[]): Float32Array {
    const h = this.hiddenOf(obsFeat);
    return this.probsOf(h, actFeats.map((a) => this.zOf(a)));
  }

  /** 择action：greedy 取 argmax 且并列取最小下标（跨语言口径）；采样需显式 rng。 */
  actFromObs(
    obsFeat: Float32Array,
    actFeats: readonly Float32Array[],
    greedy = true,
    rng?: Rng,
  ): number {
    return this.pick(this.scoresFromObs(obsFeat, actFeats), greedy, rng);
  }

  private pick(p: Float32Array, greedy: boolean, rng?: Rng): number {
    const m = p.length;
    if (greedy) {
      let best = 0;
      for (let i = 1; i < m; i++) if (p[i]! > p[best]!) best = i;
      return best;
    }
    if (!rng) throw new Error('Policy: 非 greedy 采样必须显式给 seed 化的 rng');
    const u = rng.uniform(0, 1);
    let acc = 0;
    for (let i = 0; i < m; i++) {
      acc += p[i]!;
      if (u < acc) return i;
    }
    return m - 1;
  }

  /** 每节点动作嵌入 z 的批量预计算；权重不可变，按图实例缓存复用。 */
  embedActions(graph: Graph): ReadonlyMap<string, Float64Array> {
    const hit = this.embedCache.get(graph);
    if (hit) return hit;
    const map = new Map<string, Float64Array>();
    for (const nid of ROUTING) map.set(nid, this.zOf(featurizeAction(graph, nid)));
    this.embedCache.set(graph, map);
    return map;
  }

  /**
   * 便捷决策面：obs + 候选 id 列表 → 选中候选 id。`struct` 臂整段 obs 需含
   * goal 编码段（spec 只有诊断侧可见，不经这个白名单口），故此处 fail-fast。
   */
  act(
    instruction: string,
    obs: ObsView,
    cand: readonly string[],
    graph: Graph,
    greedy = true,
    rng?: Rng,
  ): string {
    if (cand.length === 0) throw new Error('Policy.act: 候选集为空');
    if (this.featureSet === 'struct') {
      throw new Error('Policy.act: struct 为诊断 arch，须由调用方拼好含 goal 段的全 obs 后走 scoresFromObs');
    }
    const o = featurizeObs(instruction, obs, this.featureSet);
    const embed = this.embedActions(graph);
    const zs = cand.map((nid) => embed.get(nid) ?? this.zOf(featurizeAction(graph, nid)));
    const idx = this.pick(this.probsOf(this.hiddenOf(o), zs), greedy, rng);
    return cand[idx]!;
  }

  /** 进度 critic 头：ĝ = wp·h + bp，回归“距 gold 终点剩余步数”，推理不消费、仅供诊断。 */
  progressHead(obsFeat: Float32Array): number {
    if (this.head === 'none') {
      throw new Error('Policy: 本权重未启用进度头（arch head=none）');
    }
    const h = this.hiddenOf(obsFeat);
    let acc = this.bp0;
    for (let r = 0; r < H; r++) acc += this.wp[r]! * h[r]!;
    return acc;
  }

  /** 序列化转调 checkpoint：文件形态、arch 串、数值审计全在那份实现。 */
  save(path: string, trainMeta: Record<string, unknown> = {}): void {
    const file: WeightsFile = {
      arch: currentArch(this.featureSet, this.head),
      dims: {
        featureSet: this.featureSet,
        obsDim: this.obsDim,
        actDim: ACT_DIM,
        h: H,
        head: this.head,
      },
      params: this.params,
      train_meta: trainMeta,
    };
    writeWeightsJson(path, file);
  }

  static load(path: string, expect?: { featureSet?: FeatureSet; head?: HeadTag }): Policy {
    const f = readWeightsJson(path, expect);
    return new Policy(f.params, f.dims.featureSet, f.dims.head);
  }
}
