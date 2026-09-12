/**
 * 门禁共享契约（docs/gates.md §0）：唯一输出形状 `GateResult`、阈值复核口径与
 * 构造器。判据只引用实测 metrics 与写死 thresholds，二者必须机器可对账——
 * `evaluateThresholds` 把 `thresholds` 的键约定钉死为 `<metric>:eq|:min|:max`：
 * eq 判逐字相等、min/max 判数值上下界；无对应阈值键的 metric 视为报告项（不判）。
 * 缺 metric 键、未知比较符都直接算违规（fail-fast，不静默放行）；passed 由
 * harness 与各测试用同一函数复核，杜绝「写了 passed=true 就自证通过」。
 */

import type { Family, Split, Style, Task } from '../../schema.js';

export type GateId = 'G0.1' | 'G0.2' | 'G0.3' | 'G0.4' | 'G0.5' | 'G0.6';

/** gates.md §0.2 唯一输出 JSON 形状（键名逐字对齐，机器可读证据）。 */
export interface GateResult {
  readonly gate: GateId;
  readonly version: number;
  readonly world_version: string;
  readonly seeds: number[];
  readonly inputs_hash: string;
  readonly metrics: Record<string, number>;
  readonly thresholds: Record<string, number>;
  readonly passed: boolean;
  readonly artifacts: string[];
  readonly notes?: string;
}

/** 生成批次规格（跨门禁共享同一确定性数据集的唯一入口类型）。 */
export interface BatchSpec {
  readonly split: Split;
  readonly perFamily: number;
  readonly seed: number;
}

/** 门禁上下文：输入指纹、fixture 冻结值、确定性数据批次缓存与证据落盘目录。 */
export interface GateContext {
  readonly worldVersion: string;
  /** world_version + 数据集 manifest hash + fixture hash 的合成指纹（§0.3.4）。 */
  readonly inputsHash: string;
  readonly manifestHash: string;
  readonly fixturesHash: string;
  /** 冻结 fixture 中 G0.1 需复算的三段（rng/crc32/canonical），唯一读取入口。 */
  readonly fixtures: GateFixtures;
  /** 生成批次缓存：同 (split, perFamily, seed) 全 run 只生成一次（秒级预算）。 */
  readonly genTasks: (spec: BatchSpec) => Task[];
  /** 定义时把证据/结果落盘（harness 主入口）；测试传 undefined 不落仓库 runs/。 */
  readonly outDir: string | undefined;
  /** 结果/证据文件在仓库根下的相对路径前缀（artifacts 口径统一、正斜杠）。 */
  readonly artifactPrefix: string;
}

/** fixtures.json 中 G0.1 需复算的三段冻结值的形状（其余段与本门禁无关）。 */
export interface RngFixture {
  readonly seed: number;
  readonly first8: number[];
}
export interface Crc32Fixture {
  readonly s: string;
  readonly crc32: number;
}
export interface CanonicalFixture {
  readonly label: string;
  readonly json: string;
  readonly hash: string;
}
export interface GateFixtures {
  readonly rng: readonly RngFixture[];
  readonly crc32: readonly Crc32Fixture[];
  readonly canonical: readonly CanonicalFixture[];
}

/** makeTask 跨进程复算用例表（G0.1 worker 与门禁共用同一张表的唯一真源）。 */
export interface DeterminismCase {
  readonly seed: number;
  readonly style: Style;
  readonly family?: Family;
  readonly split?: Split;
}

/**
 * 批次参数（各门禁写死）：base* 三批是 G0.2/G0.4/G0.5 共用的确定性数据集；
 * g06* 三批为可分性分类器的拟合/早停/评估集（heldout 每类 ≥30 的证据规模）。
 * 数值语义：makeSplit 每 (style, family) perFamily 条、seed 显式；配额不足会
 * fail-fast 抛错而不是静默降级，所以这里只许给可复算的保守值。
 */
export const BATCH = Object.freeze({
  baseTrain: Object.freeze({ split: 'train', perFamily: 60, seed: 11 } as BatchSpec),
  baseVal: Object.freeze({ split: 'val', perFamily: 60, seed: 12 } as BatchSpec),
  baseHeldout: Object.freeze({ split: 'heldout', perFamily: 60, seed: 13 } as BatchSpec),
  g02DirectCount: 8,
  g02DirectSeedBase: 1001,
  g06Train: Object.freeze({ split: 'train', perFamily: 250, seed: 21 } as BatchSpec),
  g06Val: Object.freeze({ split: 'val', perFamily: 80, seed: 22 } as BatchSpec),
  g06Heldout: Object.freeze({ split: 'heldout', perFamily: 250, seed: 23 } as BatchSpec),
});

export type BatchKey = keyof typeof BATCH;

const COMPARATORS = ['eq', 'min', 'max'] as const;
type Comparator = (typeof COMPARATORS)[number];

function splitThresholdKey(key: string): { metric: string; cmp: Comparator } | null {
  const i = key.lastIndexOf(':');
  if (i < 0) return null;
  const cmp = key.slice(i + 1);
  if (!(COMPARATORS as readonly string[]).includes(cmp)) return null;
  return { metric: key.slice(0, i), cmp: cmp as Comparator };
}

/** 全部阈值满足才为 true；任何形状违规（未知比较符/缺 metric）都返回 false。 */
export function evaluateThresholds(
  metrics: Readonly<Record<string, number>>,
  thresholds: Readonly<Record<string, number>>,
): boolean {
  let ok = true;
  for (const [key, limit] of Object.entries(thresholds)) {
    const parsed = splitThresholdKey(key);
    if (parsed === null || !Number.isFinite(limit)) {
      ok = false;
      continue;
    }
    const value = metrics[parsed.metric];
    if (value === undefined || !Number.isFinite(value)) {
      ok = false;
      continue;
    }
    if (parsed.cmp === 'eq' && value !== limit) ok = false;
    if (parsed.cmp === 'min' && value < limit) ok = false;
    if (parsed.cmp === 'max' && value > limit) ok = false;
  }
  return ok;
}

/** GateResult 的必备键清单（测试按 it 断言形状的唯一口径）。 */
export function gateShapeKeys(): string[] {
  return [
    'gate',
    'version',
    'world_version',
    'seeds',
    'inputs_hash',
    'metrics',
    'thresholds',
    'passed',
    'artifacts',
  ];
}

export interface BuildResultArgs {
  readonly gate: GateId;
  readonly version: number;
  readonly ctx: GateContext;
  readonly seeds: readonly number[];
  readonly metrics: Record<string, number>;
  readonly thresholds: Record<string, number>;
  readonly artifacts?: readonly string[];
  readonly notes?: string;
}

/** 构造 GateResult：passed 一律由 evaluateThresholds 复算，不接受手写布尔值。 */
export function buildResult(args: BuildResultArgs): GateResult {
  const base: GateResult = {
    gate: args.gate,
    version: args.version,
    world_version: args.ctx.worldVersion,
    seeds: [...args.seeds],
    inputs_hash: args.ctx.inputsHash,
    metrics: args.metrics,
    thresholds: args.thresholds,
    passed: evaluateThresholds(args.metrics, args.thresholds),
    artifacts: [...(args.artifacts ?? [])],
  };
  return args.notes === undefined ? base : { ...base, notes: args.notes };
}

const MEMO = new WeakMap<GateContext, Map<GateId, GateResult>>();

/**
 * 按上下文记忆门禁结果：GateResult 不可变（harness 落盘时只做浅拷贝扩展
 * artifacts），同 ctx 重复 run() 直接复用——tests 的逐门禁断言与 runAll
 * 复算因此零重复开销（子进程生成/分类器训练这类秒级重算只跑一次）。
 */
export function memoized(
  gate: GateId,
  ctx: GateContext,
  compute: () => GateResult,
): GateResult {
  let byGate = MEMO.get(ctx);
  if (byGate === undefined) {
    byGate = new Map();
    MEMO.set(ctx, byGate);
  }
  const hit = byGate.get(gate);
  if (hit !== undefined) return hit;
  const res = compute();
  byGate.set(gate, res);
  return res;
}

/** 门禁意外抛错时的兜底结果：如实标 failed，错误进 notes，绝不静默跳过。 */
export function failureResult(gate: GateId, ctx: GateContext, err: unknown): GateResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    gate,
    version: 0,
    world_version: ctx.worldVersion,
    seeds: [],
    inputs_hash: ctx.inputsHash,
    metrics: {},
    thresholds: {},
    passed: false,
    artifacts: [],
    notes: `run() 抛错（fail-fast 兜底）: ${message}`,
  };
}
