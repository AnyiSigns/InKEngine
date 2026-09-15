/**
 * 原始 obs（`records.jsonl`）→ 派生稀疏缓存（`records.bin`）的 featurize 层。
 *
 * 这一层是 F.3「特征单源」的形态保证之一：obs 只由 `data/store.ts` 落盘的公开字段
 * 投影而来——`{x, answer, verdict, hist}` 加 `instruction`，特征函数 `featurizeObs`
 * 的入参签名即审计面（见 controller/features.ts），多出来的字段不会被读取；而
 * `StoreRecord` 顶层根本没有 `expected`/`spec`/`plan_hidden`，隐藏量在写入阶段就被
 * 白名单投影挡在门外，这里既无从读、也绝不去读。分组进度唯一用到的 meta 字段是
 * `task_hash`（分组键）与 `step_index`（本步序号），二者都非隐藏语义、只是坐标。
 * 稀疏编码只落在这派生层（§6）：原始 obs 存紧凑 JSONL，稠密特征改了不必重生成数据。
 *
 * v2 的 header 动作特征表（`actionFeatureTable`）是 F.2「候选特征由 node id 确定、
 * 不重复存」的唯一落地：每个候选的 a_i 就是 `featurizeAction(GRAPH, nid)`，同 id 处处
 * 相同，故整张表按 ROUTING 序在 header 存一份，行内只留 22 位全局位掩码指回表序；
 * Python 训练器由位序查表重建 a_i，无需求复刻特征（F.3 不破）。
 *
 * v3 的 `targetMask` 是标签软化（Phase 2 门禁，§6）的派生编码：目标族记录带
 * `safeTargets`（oracle 判定「仍通向验收的动作集」，gold 强制在内），按候选本地下标
 * 转 u32 位掩码；配方族无 safeTargets，退化单点（恰一位 = gold）。Python 由 mask
 * 重建均匀软目标 y，配合 label smoothing 摊到有效位。
 *
 * 二进制读写字节契约与 `writeRecordsBin`/`readRecordsBin` 实现同文件承载，本模块只
 * re-export 到公开面（保持 records.ts 是 featurize 的唯一入口），见 records_bin.ts 头注。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT, ROUTING } from '../world/operators.js';
import type { Family, Split, Style } from '../schema.js';
import {
  FEATURE_SETS,
  OBS_DIM,
  featurizeAction,
  featurizeObs,
  type FeatureSet,
  type ObsView,
} from '../controller/features.js';
import { GRAPH, MAX_STEPS } from '../runner/graph.js';
import { defaultOutRoot, load, type StoreRecord } from './store.js';
import { SPLIT_VALUES } from './store_schema.js';
// 二进制读写与其承载的 BinRow 类型拆分到 records_bin.ts，公开面仍收敛在本模块。
import { type BinFile, type BinRow, readRecordsBin, writeRecordsBin } from './records_bin.js';

export { readRecordsBin, writeRecordsBin };
export type { BinFile, BinRow };

/** family 语义序固定为 value/verify/goal/goal_verify，与 F.2 单字节编码一一对应。 */
const FAMILY_CODE: Readonly<Record<Family, 0 | 1 | 2 | 3>> = {
  value: 0,
  verify: 1,
  goal: 2,
  goal_verify: 3,
};

/**
 * 候选全局位掩码：位 j ↔ ROUTING[j] 在该步候选内（基础世界 22 位收在 u32）。
 * 候选 id 必须全为 ROUTING 成员且互异（重复候选会令置位数 < 候选数、破坏「第 i 个
 * 置位 ↔ 候选 i」映射，即标签错位）——越界/重复一律 fail-fast，不静默截断。
 */
function candidateMask(candidates: readonly string[]): number {
  if (ROUTING.length > 32) {
    throw new Error(`featurize: ROUTING 宽度 ${String(ROUTING.length)} 超出 u32 位掩码（需变长 bitset，见 I.2）`);
  }
  let mask = 0;
  for (const nid of candidates) {
    const j = ROUTING.indexOf(nid);
    if (j < 0) {
      throw new Error(`featurize: 候选 ${nid} 非 ROUTING 成员（v2 动作表覆盖不了该节点，fail-fast）`);
    }
    if (mask & (1 << j)) {
      throw new Error(`featurize: 候选 ${nid} 重复出现（位掩码与本地下标错位，fail-fast）`);
    }
    mask |= 1 << j;
  }
  return mask >>> 0;
}

/**
 * v2 header 动作特征表：按 ROUTING 序逐一 featurizeAction(GRAPH, nid)。这是
 * 「候选特征由 node id 确定、不重复存」的唯一落地——同一 nid 在任何一步的 a_i 都
 * 等于表内该行，所以行内只需位掩码。纯依赖基础世界契约，进程内 memo 一次。
 */
let actionTableCache: readonly Float32Array[] | undefined;
export function actionFeatureTable(): readonly Float32Array[] {
  if (actionTableCache === undefined) {
    actionTableCache = ROUTING.map((nid) => featurizeAction(GRAPH, nid));
  }
  return actionTableCache;
}

/** 只取稀疏非零项打包：obs 每行非零项远小于总维度，落 int16 下标省一半体积。 */
function packSparse(dense: Float32Array): { idx: Uint16Array; val: Float32Array } {
  const idx: number[] = [];
  const val: number[] = [];
  for (let i = 0; i < dense.length; i++) {
    const v = dense[i]!;
    if (v !== 0) {
      if (i >= 65536) throw new Error(`featurize: 特征下标 ${String(i)} 超出 uint16`);
      idx.push(i);
      val.push(v);
    }
  }
  return { idx: Uint16Array.from(idx), val: Float32Array.from(val) };
}

/** 公开字段 → obs 视图（F.3 形态保证）：只投影白名单三字段 + hist，绝不触碰隐藏量。 */
function obsView(rec: StoreRecord): ObsView {
  return { x: rec.x, answer: rec.state.answer, verdict: rec.state.verdict, hist: [...rec.hist] };
}

/**
 * 单行稀疏化：不依赖同任务其它步，故不产出分组进度（progressLabel/Weight 留零，
 * 由 `featurizeRecords` 按 task_hash 分组回填）。target 不在 candidates 即 fail-fast。
 * `targetMask` 位 i = 候选 i 在目标动作集内：记录带 `safeTargets`（目标族软化）时按
 * 该集合置位（必须含 gold、且全为 candidates 成员，否则 fail-fast）；缺省（配方族
 * 单解）退化为 gold 单点位。
 */
export function featurizeRecord(
  rec: StoreRecord,
  featureSet: FeatureSet = 'lang',
): Omit<BinRow, 'taskHash' | 'stepIndex'> {
  const dense = featurizeObs(rec.instruction, obsView(rec), featureSet);
  if (dense.length !== OBS_DIM[featureSet]) {
    throw new Error(
      `featurize: 特征集 ${featureSet} 行宽 ${String(dense.length)} ≠ OBS_DIM ${String(OBS_DIM[featureSet])}（宽度不变量，fail-fast；` +
        `struct 的 8 维 goal 段由诊断侧拼接、基座不进 records.bin）`,
    );
  }
  const { idx, val } = packSparse(dense);
  const targetIdx = rec.candidates.indexOf(rec.target);
  if (targetIdx < 0) {
    throw new Error(`featurize: target ${rec.target} 不在 candidates（步级标签错位，fail-fast）`);
  }
  let targetMask = 1 << targetIdx;
  let targetDepths = 0;
  if (rec.safeTargets !== undefined) {
    if (rec.safeTargets.length === 0) {
      throw new Error('featurize: safeTargets 为空（软化标签不可为空，fail-fast）');
    }
    if (!rec.safeTargets.includes(rec.target)) {
      throw new Error(`featurize: safeTargets 不含 gold ${rec.target}（软化标签丢失 gold，fail-fast）`);
    }
    if (rec.safeDepths === undefined || rec.safeDepths.length !== rec.safeTargets.length) {
      throw new Error('featurize: safeDepths 必须与 safeTargets 等长（软化标签深度缺失，fail-fast）');
    }
    targetMask = 0;
    const order: Array<{ i: number; depth: number }> = [];
    for (let k = 0; k < rec.safeTargets.length; k++) {
      const id = rec.safeTargets[k]!;
      const i = rec.candidates.indexOf(id);
      if (i < 0) {
        throw new Error(`featurize: safeTargets 含非候选 ${id}（软化标签越界，fail-fast）`);
      }
      const depth = rec.safeDepths[k]!;
      if (!Number.isInteger(depth) || depth < 0 || depth > 63) {
        throw new Error(`featurize: safeDepths[${String(k)}]=${String(depth)} 越界（须 [0,63] 整数，fail-fast）`);
      }
      targetMask |= 1 << i;
      order.push({ i, depth });
    }
    if (targetMask === 0) {
      throw new Error('featurize: safeTargets 为空（软化标签不可为空，fail-fast）');
    }
    // targetDepths 6bit/置位打包：按候选位序（i 升序）对应；JS 位运算得带符号
    // 32 位整数，统一 >>> 0 归到无符号（与 bin 读侧 readUInt32LE 口径一致）。
    order.sort((a, b) => a.i - b.i);
    for (let k = 0; k < order.length; k++) {
      targetDepths |= order[k]!.depth << (k * 6);
    }
    targetDepths >>>= 0;
  }
  return {
    style: (rec.style === 'goal' ? 1 : 0) as 0 | 1,
    family: FAMILY_CODE[rec.family],
    idx,
    val,
    candMask: candidateMask(rec.candidates),
    targetMask,
    targetDepths,
    progressLabel: 0,
    progressWeight: 0,
  };
}

/**
 * 批量稀疏化并回填进度 critic 辅助头标签（C.5）：先按 `meta.task_hash`（必须 string，
 * 否则分组键不可构造即抛）分组，组内最大 `step_index` 为终点。口径钉死在——组内存在
 * `target === 'exit'` 的行才视为完整 oracle 轨迹（全组权重 1），否则不完整、整组不进
 * 进度回归（权重 0），避免把半截轨迹的「距终点步数」当成真标签训练。行序随入参、无分组重排。
 */
export function featurizeRecords(
  records: readonly StoreRecord[],
  featureSet: FeatureSet = 'lang',
): BinRow[] {
  const feats: Omit<BinRow, 'taskHash' | 'stepIndex'>[] = [];
  const taskHashes: string[] = [];
  const stepIndexes: number[] = [];
  const maxStep = new Map<string, number>();
  const complete = new Set<string>();
  for (const rec of records) {
    const th = rec.meta.task_hash;
    const si = rec.meta.step_index;
    if (typeof th !== 'string') {
      throw new Error('featurizeRecords: meta.task_hash 非字符串（分组键不可构造，fail-fast）');
    }
    if (typeof si !== 'number' || !Number.isInteger(si)) {
      throw new Error(`featurizeRecords: meta.step_index 非整数（进度标签不可算，task_hash=${th}）`);
    }
    feats.push(featurizeRecord(rec, featureSet));
    taskHashes.push(th);
    stepIndexes.push(si);
    const prev = maxStep.get(th);
    if (prev === undefined || si > prev) maxStep.set(th, si);
    if (rec.target === EXIT) complete.add(th);
  }
  return feats.map((feat, i) => {
    const th = taskHashes[i]!;
    return {
      ...feat,
      taskHash: th,
      stepIndex: stepIndexes[i]!,
      progressLabel: (maxStep.get(th)! - stepIndexes[i]!) / MAX_STEPS,
      progressWeight: complete.has(th) ? 1 : 0,
    };
  });
}

// —— 以下为 featurize CLI：records.jsonl → records.bin，供离线批量派生（Python 训练器只读 bin）。

export interface FeaturizeOptions {
  readonly split: Split;
  readonly out: string;
  readonly outRoot: string;
  readonly featureSet: FeatureSet;
  readonly limit?: number;
  readonly style: Style | 'both';
}

const USAGE =
  '用法：npx tsx data/records.ts --split <train|val|heldout> --out <bin路径> ' +
  '[--feature-set lang|hash_only（struct 为诊断 arch，不进 records.bin）] ' +
  '[--out-root <records根>] [--limit N] [--style follow|goal|both]';

/** CLI 参数校验：必填缺失或值域越界即抛 `UsageError`（main 转「打印用法 + 退出码 1」）。 */
export function parseArgs(argv: readonly string[]): FeaturizeOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const usage = (msg: string): never => {
    throw new Error(msg);
  };
  const split = get('--split');
  const out = get('--out');
  if (split === undefined || out === undefined) usage('缺少 --split 或 --out');
  if (!SPLIT_VALUES.includes(split!)) usage(`非法 split=${String(split)}`);
  const featureSet = get('--feature-set') ?? 'lang';
  if (!FEATURE_SETS.includes(featureSet as FeatureSet)) usage(`非法 feature-set=${featureSet}`);
  if (featureSet === 'struct') {
    usage(
      'struct 不进 records.bin：goal 段由诊断侧拼接，行宽(867)≠OBS_DIM.struct(875)，仅供诊断 arch 复核',
    );
  }
  const style = get('--style') ?? 'both';
  if (style !== 'both' && style !== 'follow' && style !== 'goal') usage(`非法 style=${style}`);
  let limit: number | undefined;
  const limitRaw = get('--limit');
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) usage(`非法 --limit=${limitRaw}`);
  }
  return {
    split: split as Split,
    out: resolve(out!),
    outRoot: get('--out-root') ?? defaultOutRoot(),
    featureSet: featureSet as FeatureSet,
    limit,
    style: style as Style | 'both',
  };
}

/** 入口包装返回退出码：库调用方直取返回值，CLI 壳落 process.exitCode；写盘/派生异常直抛。 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  let opts: FeaturizeOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(USAGE);
    console.error(`records: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let records = load(opts.split, { outRoot: opts.outRoot });
  if (opts.style !== 'both') records = records.filter((r) => r.style === opts.style);
  if (opts.limit !== undefined) records = records.slice(0, opts.limit);
  const rows = featurizeRecords(records, opts.featureSet);
  const obsDim = OBS_DIM[opts.featureSet];
  writeRecordsBin(opts.out, rows, obsDim, actionFeatureTable());
  console.log(`records: ${String(rows.length)} rows -> ${opts.out} (obsDim=${String(obsDim)})`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
