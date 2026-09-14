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
import { occurrencePlan } from '../world/tokenize.js';
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
/** R6 词法顺序槽：按义项首现位置升序取前 ORDER_SLOTS 个算子逐位 one-hot。
 * 把弱扫描（HeuristicArm）能看到的"指令内相对顺序"显式编码——排序比较对
 * 小 MLP 不可分（R6 分层诊断：首步路由仅 0.78、失败集 97.5% 与弱扫描不重叠）。
 * 并列位置（共享义项如 `取反`）按 LEX_OPS_BASE 固定序 tie-break，与弱扫描同源；
 * 模型仍可经 mention/hash 冗余信号学习偏离（类型消歧 = A.1 差额的语义通道）。 */
export const ORDER_SLOTS = 8;
export const ORDER_DIM = ORDER_SLOTS * LEX_OPS_BASE.length;
/**
 * R7 进度对齐槽：下一个待执行算子 one-hot 的段宽（= 义项词表宽度，15 维）。
 * 派生源 = 逐位置义项命中组（occurrencePlan，与弱扫描同源口径，含重复算子）+
 * obs.hist 公开面：hist 按序逐次消耗匹配位置（组内任一算子命中即消耗该位置；
 * 非序列算子如 decoy 干预不消耗），取第一个未消耗位置、按 LEX_OPS_BASE 序编码
 * 组内最小算子；全部消耗 / goal 族无算子义项 → 全零（此时应选 submit/check/exit，
 * 靠原特征）。零泄漏：只读 instruction 与 hist 两个公开面。
 * R7 复评（代码纪律审查）：初版按 op 身份去重跳过，重复算子步（68.6% 骨架 /
 * 14.7% BC 记录）与 oracle 标签冲突（槽位诱导提前 submit / 指向错算子）→ 修正
 * 为 occurrence 指针语义（arch v3→v4，v3 未训练未发布，无证据污染）。
 */
export const NEXT_OP_DIM = LEX_OPS_BASE.length;
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

/** 指令段布局：mention + goal_hint + num + order + hash（段序冻结，见 featurizeInstr）。 */
const INSTR_FULL = MENTION_DIM + GOAL_HINT_DIM + NUM_DIM + ORDER_DIM + HASH_DIM;
/** 进度对齐槽紧随指令段之后（段序冻结：instr + next_op + state + hist + step）。 */
const NEXT_OP_OFF = INSTR_FULL;
const OBS_FULL = INSTR_FULL + NEXT_OP_DIM + STATE_DIM + HIST_DIM + STEP_DIM;
const INSTR_BLOCK: Readonly<Record<FeatureSet, number>> = {
  lang: INSTR_FULL,
  struct: INSTR_FULL,
  hash_only: HASH_DIM,
};

/** 各特征集的完整 obs 宽度（struct 含 goal 编码段，由诊断侧自行拼接）。 */
export const OBS_DIM: Readonly<Record<FeatureSet, number>> = {
  lang: OBS_FULL,
  hash_only: INSTR_BLOCK.hash_only + STATE_DIM + HIST_DIM + STEP_DIM,
  struct: OBS_FULL + GOAL_STRUCT_DIM,
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
  if (
    MENTION_DIM !== 45 || GOAL_HINT_DIM !== 8 || NUM_DIM !== 8 || HASH_DIM !== 256 ||
    ORDER_DIM !== 120 || NEXT_OP_DIM !== 15
  ) {
    throw new Error(
      `features: 指令段 dims 漂移 m=${MENTION_DIM} g=${GOAL_HINT_DIM} n=${NUM_DIM} h=${HASH_DIM} order=${ORDER_DIM} next=${NEXT_OP_DIM}`,
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
 * 设计语义（勿改）：非整数 number 与空值同样落 [0,0,0]，在「值摘要」面不可分——
 * 特征层只承诺整数值状态，world `t()` 亦把非整数排除在 Int 义项外；该信息损失已由
 * 测试断言钉死。
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
 * R6 顺序槽单一排序口径：义项首现位置升序（并列按 LEX_OPS_BASE 固定序 tie-break），
 * 返回**去重**算子下标序列。只服务词法顺序槽（静态指令编码）；R7 进度对齐槽走
 * `occurrencePlan`（含重复，与弱扫描同源）——两者口径不同属设计语义，见各注释。
 */
function rankOrder(toks: readonly string[]): readonly number[] {
  const firsts = new Map<number, number>();
  for (let k = 0; k < LEX_OPS_BASE.length; k++) {
    const { first } = mentionStats(toks, LEX_OPS_BASE[k]!);
    if (first >= 0) firsts.set(k, first);
  }
  return [...firsts.entries()].sort((p, q) => p[1] - q[1] || p[0] - q[0]).map((p) => p[0]);
}

/**
 * 公开指令特征（语言优先）：逐算子义项提及 + 目标类别义项 + 数值端点 + 词法顺序槽
 * + 哈希兜底。段序冻结：mention(0..45) + goal_hint(45..53) + num(53..61) +
 * order(61..181) + hash(181..437)——新增顺序槽不改 goal/num/hash 偏移。
 * `hash_only` 消融臂把前三段与顺序槽整块丢弃、只留 256 维哈希袋——同一段字符串
 * 在两套 arch 下的向量长度不同，权重天然不互通，由 arch fail-fast 兜底。
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
  // R6 词法顺序槽：rankOrder（义项首现升序、并列按 LEX_OPS_BASE 序 tie-break，与
  // 弱扫描同源口径）取前 ORDER_SLOTS 个算子，逐位 one-hot。goal 族指令无算子义项
  // → 全零。
  const orderOff = MENTION_DIM + GOAL_HINT_DIM + NUM_DIM;
  const ranked = rankOrder(toks);
  for (let j = 0; j < Math.min(ORDER_SLOTS, ranked.length); j++) {
    a[orderOff + j * LEX_OPS_BASE.length + ranked[j]!] = 1;
  }
  a.set(hashed, orderOff + ORDER_DIM);
  return a;
}

/**
 * R7 进度对齐槽：下一个待执行算子 one-hot（NEXT_OP_DIM=15）。occurrence 指针
 * 语义：occurrencePlan 逐位置推进，hist 按序消耗匹配位置（组内任一算子命中即
 * 消耗；decoy 等非序列算子不消耗），取第一个未消耗位置按 LEX_OPS_BASE 序编码
 * 组内最小算子；全部消耗 / goal 族无算子义项 → 全零。零泄漏。
 * `hash_only` 消融臂不含本段。
 */
export function nextOpFeatures(instruction: string, hist: readonly string[]): Float32Array {
  const a = new Float32Array(NEXT_OP_DIM);
  const plan = occurrencePlan(tokens(instruction));
  let p = 0;
  for (const h of hist) {
    if (p >= plan.length) break;
    if (plan[p]!.includes(LEX_OPS_BASE.indexOf(h))) p++;
  }
  if (p < plan.length) a[plan[p]![0]!] = 1;
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
 * 完整 obs：指令段 + 进度对齐槽 + 状态 + 历史 + 步进度（段序冻结）。`lang` 输出
 * 867 维整段；`hash_only` 只留哈希袋（无进度槽，671）；`struct` 产出 867 维基座，
 * 8 维 goal 编码由诊断侧调 `featurizeGoalStruct` 自行追加——本函数不接收 spec，
 * 白名单在签名层封死。
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
  const nextOp = nextOpFeatures(instruction, obs.hist);
  const state = featurizeState(obs);
  const hist = histFeatures(obs.hist);
  const out = new Float32Array(
    instr.length + (featureSet === 'hash_only' ? 0 : NEXT_OP_DIM) + STATE_DIM + HIST_DIM + STEP_DIM,
  );
  let o = 0;
  out.set(instr, o);
  o += instr.length;
  if (featureSet !== 'hash_only') {
    out.set(nextOp, NEXT_OP_OFF);
    o += NEXT_OP_DIM;
  }
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
