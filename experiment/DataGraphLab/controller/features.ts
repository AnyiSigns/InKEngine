/**
 * 唯一特征源：obs 与 action 特征（pointer 式动态候选集打分的输入侧）。
 *
 * 白名单是硬红线：`expected`、`spec`、`plan_hidden`、`plan_hash`、`seed` 绝不进
 * 本文件的任何输出——`featurizeObs` 的入参只有公开指令与 x/answer/verdict/hist，
 * 签名即审计面。唯一例外是 `struct` 诊断 arch 的 `featurizeGoalStruct`（独立文件、
 * 只读公开 `spec.goal`），它是上界诊断臂，绝不进主臂训练信号；`hash_only` 是消融
 * 臂。三套 arch 的 OBS_DIM 不同，权重按 arch fail-fast，不混用；`struct` 臂的整段
 * obs 由诊断侧把本文件的基座特征与 8 维 goal 编码自行拼接，本文件不接收 spec。
 *
 * 维度全部由常量推导（词表、类型格、槽位表各只有一份定义），测试用字面量断言
 * 恒等防漂移。结构进化新增节点不改这里任何 dims：mention 冻结在基础词表，
 * hist 用追加式稳定槽位，动作特征走契约派生 + 哈希桶。
 */

import { EXIT, LEX_OPS_BASE, emod, type Graph } from '../world/operators.js';
import { TYPE_INDEX, TYPE_LIST, t } from '../world/types.js';
import { GOAL_CONNECTORS, GOAL_LEX, mentionStats, tokens } from '../world/grammar.js';
import { crc32 } from '../world/hash.js';
import { MAX_STEPS } from '../runner/graph.js';
import { HIST_SLOTS, NODE_SLOT } from './slots.js';
import { featurizeGoalStruct, GOAL_STRUCT_DIM } from './features_struct.js';

export { featurizeGoalStruct, GOAL_STRUCT_DIM };
export { LEX_OPS_BASE };
export type { Graph };

export type FeatureSet = 'lang' | 'struct' | 'hash_only';
export const FEATURE_SETS: readonly FeatureSet[] = ['lang', 'struct', 'hash_only'];

/** 公开可观测状态：白名单三字段（+ 历史），不含 spec/expected 的任何形态。 */
export interface ObsFields {
  readonly x: unknown;
  readonly answer: unknown;
  readonly verdict: unknown;
}
export interface ObsView extends ObsFields {
  readonly hist: readonly string[];
}

/** 义项词表冻结在 op+terminal 基础序上，每 op 3 维（命中数/首现/序位）。 */
export const MENTION_DIM = LEX_OPS_BASE.length * 3;
/** parity/gt/len 三类目标义项 + 合取连接词，共 4 组 × 2 维。 */
const GOAL_GROUPS: readonly (readonly string[])[] = [
  ...Object.values(GOAL_LEX),
  GOAL_CONNECTORS,
];
export const GOAL_HINT_DIM = GOAL_GROUPS.length * 2;
export const NUM_DIM = 8;
export const HASH_DIM = 256;
/** 白名单字段序冻结；每字段 present + 类型 onehot + 三维值摘要 = 10。 */
export const FIELD_ORDER: readonly (keyof ObsFields)[] = ['x', 'answer', 'verdict'];
export const STATE_DIM = FIELD_ORDER.length * (1 + TYPE_LIST.length + 3);
/** 滚窗 = 单条 rollout 的最大步数：最长 gold 路径的历史一条不丢。 */
export const HIST_LEN = MAX_STEPS;
export const HIST_DIM = HIST_LEN * HIST_SLOTS;
export const STEP_DIM = 1;

/** instruction 段宽度：hash_only 消融臂只保留哈希词袋。 */
const INSTR_FULL = MENTION_DIM + GOAL_HINT_DIM + NUM_DIM + HASH_DIM;
const INSTR_BLOCK: Readonly<Record<FeatureSet, number>> = {
  lang: INSTR_FULL,
  struct: INSTR_FULL,
  hash_only: HASH_DIM,
};

/** 各特征集的完整 obs 宽度（struct 含 goal 编码段，由诊断侧自行拼接）。 */
export const OBS_DIM: Readonly<Record<FeatureSet, number>> = {
  lang: INSTR_BLOCK.lang + STATE_DIM + HIST_DIM + STEP_DIM,
  hash_only: INSTR_BLOCK.hash_only + STATE_DIM + HIST_DIM + STEP_DIM,
  struct: INSTR_BLOCK.struct + STATE_DIM + HIST_DIM + STEP_DIM + GOAL_STRUCT_DIM,
};

/** 动作特征 = 契约派生（provides/kind/accepts/returns）+ 哈希算子桶。 */
export const PROVIDES_LIST: readonly string[] = ['x', 'answer', 'verdict'];
export const KIND_LIST: readonly string[] = ['op', 'terminal', 'decoy', 'exit'];
export const OP_BUCKETS = 64;
export const P_OFF = 0;
export const K_OFF = P_OFF + PROVIDES_LIST.length;
export const T_OFF = K_OFF + KIND_LIST.length;
export const E_OFF = T_OFF + 2 * TYPE_LIST.length;
export const ACT_DIM = E_OFF + OP_BUCKETS;

/** 词表扩容会平移 dims 却不改 arch 写法，启动即核对，防静默错位。 */
function assertFeatureDims(): void {
  if (MENTION_DIM !== 45 || GOAL_HINT_DIM !== 8 || NUM_DIM !== 8 || HASH_DIM !== 256) {
    throw new Error(
      `features: 指令段 dims 漂移 m=${MENTION_DIM} g=${GOAL_HINT_DIM} n=${NUM_DIM} h=${HASH_DIM}`,
    );
  }
  if (STATE_DIM !== 30 || HIST_DIM !== 384 || ACT_DIM !== 83) {
    throw new Error(
      `features: 状态/历史/动作 dims 漂移 s=${STATE_DIM} hist=${HIST_DIM} act=${ACT_DIM}`,
    );
  }
}
assertFeatureDims();

/**
 * 白名单字段值摘要（带符号值 / 幅度 / 奇偶）。Int 必须保留符号与奇偶：abs 抹号会让
 * 严格大于（gt）与 cond_even 类目标在特征层面系统性盲视，这是原设计的特征级缺陷；
 * 奇偶一律走 `emod`——JS 裸 `%` 对负数返回负余数，与 Python 不一致。非有限数记零。
 */
export function stateStats(v: unknown): readonly [number, number, number] {
  if (v === null || v === undefined) return [0, 0, 0];
  if (typeof v === 'boolean') return [v ? 1 : 0, 0, 0];
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return [0, 0, 0];
    if (!Number.isInteger(v)) return [0, 0, 0];
    return [Math.tanh(v / 50), Math.min(1, Math.abs(v) / 100), emod(v, 2)];
  }
  if (typeof v === 'string') return [Math.min(1, v.length / 16), 0, 0];
  return [0, 0, 0];
}

/** L2 归一的哈希词袋；空指令范数为 0，保持全零不除。 */
function hashBag(toks: readonly string[]): Float32Array {
  const hashed = new Float32Array(HASH_DIM);
  for (const tok of toks) {
    const b = crc32(tok) % HASH_DIM;
    hashed[b] = (hashed[b] ?? 0) + 1;
  }
  let nrm = 0;
  for (const v of hashed) nrm += v * v;
  nrm = Math.sqrt(nrm);
  if (nrm > 0) for (let i = 0; i < HASH_DIM; i++) hashed[i] = hashed[i]! / nrm;
  return hashed;
}

/**
 * 公开指令特征（语言优先）：逐算子义项提及 + 目标类别义项 + 数值端点 + 哈希兜底。
 * `hash_only` 消融臂把前三段整块丢弃、只留 256 维哈希袋——同一段字符串在两套
 * arch 下的向量长度不同，权重天然不互通，由 arch fail-fast 兜底。
 */
export function featurizeInstr(instruction: string, featureSet: FeatureSet = 'lang'): Float32Array {
  const toks = tokens(instruction);
  const hashed = hashBag(toks);
  if (featureSet === 'hash_only') return hashed;
  const a = new Float32Array(INSTR_BLOCK[featureSet]);
  const tokLen = Math.max(1, toks.length);
  for (let k = 0; k < LEX_OPS_BASE.length; k++) {
    const { hits, first, rank } = mentionStats(toks, LEX_OPS_BASE[k]!);
    a[3 * k] = Math.min(1, hits / 3);
    a[3 * k + 1] = first >= 0 ? 1 - first / tokLen : 0;
    a[3 * k + 2] = 1 - rank / Math.max(1, LEX_OPS_BASE.length);
  }
  for (let g = 0; g < GOAL_GROUPS.length; g++) {
    const { hits, first } = mentionStats(toks, GOAL_GROUPS[g]!);
    a[MENTION_DIM + 2 * g] = Math.min(1, hits / 3);
    a[MENTION_DIM + 2 * g + 1] = first >= 0 ? 1 - first / tokLen : 0;
  }
  const raw = instruction.match(/-?\d+/g);
  if (raw) {
    const nums = raw.slice(0, NUM_DIM / 2);
    for (let j = 0; j < nums.length; j++) {
      const v = Number(nums[j]);
      if (!Number.isFinite(v)) continue;
      const o = MENTION_DIM + GOAL_HINT_DIM + 2 * j;
      a[o] = 1;
      a[o + 1] = Math.max(-1, Math.min(1, v / 50));
    }
  }
  a.set(hashed, MENTION_DIM + GOAL_HINT_DIM + NUM_DIM);
  return a;
}

/**
 * 三元白名单字段（x/answer/verdict）的 30 维编码：present + 类型 onehot + 值摘要。
 * 入参类型即审计面——多出来的字段（哪怕调用方塞了 spec）不会被读取。
 */
export function featurizeState(st: ObsFields): Float32Array {
  const a = new Float32Array(STATE_DIM);
  for (let f = 0; f < FIELD_ORDER.length; f++) {
    const val = st[FIELD_ORDER[f]!];
    const o = f * (1 + TYPE_LIST.length + 3);
    a[o] = val === null || val === undefined ? 0 : 1;
    a[o + 1 + TYPE_INDEX[t(val)]] = 1;
    const stats = stateStats(val);
    a[o + 1 + TYPE_LIST.length] = stats[0];
    a[o + 2 + TYPE_LIST.length] = stats[1];
    a[o + 3 + TYPE_LIST.length] = stats[2];
  }
  return a;
}

/**
 * 滚窗历史独热：最近动作占 j=0。无槽位节点跳过；槽位越界 fail-fast，
 * 提示扩 `HIST_SLOTS` 并 bump arch——静默丢历史会让“用过哪些算子”失真。
 */
export function histFeatures(hist: readonly string[]): Float32Array {
  const a = new Float32Array(HIST_DIM);
  const recent = hist.slice(-HIST_LEN).reverse();
  for (let j = 0; j < recent.length; j++) {
    const s = NODE_SLOT.get(recent[j]!);
    if (s === undefined) continue;
    if (s >= HIST_SLOTS) {
      throw new Error(`histFeatures: 节点 ${recent[j]} 槽位 ${s} 超出 HIST_SLOTS，需扩容量并升 arch`);
    }
    a[j * HIST_SLOTS + s] = 1;
  }
  return a;
}

/**
 * 完整 obs 基座：指令段 + 状态 + 历史 + 步进度。`lang`/`hash_only` 的输出即整段
 * obs；`struct` 只产出 732 维基座，8 维 goal 编码由诊断侧调 `featurizeGoalStruct`
 * 自行追加——本函数不接收 spec，白名单在签名层封死。
 */
export function featurizeObs(
  instruction: string,
  obs: ObsView,
  featureSet: FeatureSet = 'lang',
): Float32Array {
  const instr = featurizeInstr(instruction, featureSet);
  if (instr.length !== INSTR_BLOCK[featureSet]) {
    throw new Error(`featurizeObs: 指令段长度 ${instr.length} 与 arch ${featureSet} 不符`);
  }
  const state = featurizeState(obs);
  const hist = histFeatures(obs.hist);
  const out = new Float32Array(instr.length + STATE_DIM + HIST_DIM + STEP_DIM);
  let o = 0;
  out.set(instr, o);
  o += instr.length;
  out.set(state, o);
  o += STATE_DIM;
  out.set(hist, o);
  o += HIST_DIM;
  out[o] = Math.min(1, obs.hist.length / MAX_STEPS);
  return out;
}

/**
 * 动作特征：契约派生 + 哈希算子桶。同契约算子靠哈希桶区分，替换/新增同契约算子
 * 不改 ACT_DIM。`entry` 永不作为候选，直接调用视为编程错误；`exit` 是结构节点、
 * 只置 kind 位；`"any"` 不是类型格成员，accepts/returns 两侧一律不置位。
 */
export function featurizeAction(graph: Graph, nid: string): Float32Array {
  const a = new Float32Array(ACT_DIM);
  if (nid === EXIT) {
    a[K_OFF + KIND_LIST.indexOf('exit')] = 1;
    return a;
  }
  if (nid === 'entry') {
    throw new Error('featurizeAction: entry 不可作为动作特征化');
  }
  const node = graph.nodes[nid];
  if (!node) throw new Error(`featurizeAction: 图中不存在节点 ${nid}`);
  const p = PROVIDES_LIST.indexOf(node.provides ?? '');
  if (p >= 0) a[P_OFF + p] = 1;
  const k = KIND_LIST.indexOf(node.kind);
  if (k >= 0) a[K_OFF + k] = 1;
  for (const ty of node.requires_types) {
    const i = TYPE_LIST.indexOf(ty);
    if (i >= 0) a[T_OFF + i] = 1;
  }
  const oi = (TYPE_LIST as readonly string[]).indexOf(node.out_type);
  if (oi >= 0) a[T_OFF + TYPE_LIST.length + oi] = 1;
  a[E_OFF + (crc32(nid) % OP_BUCKETS)] = 1;
  return a;
}
