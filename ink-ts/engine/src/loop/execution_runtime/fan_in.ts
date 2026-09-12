/**
 * fan-in 归并与汇聚点合成（纯函数：提交契约 full/best/decision_only 的归并 +
 * 汇聚点唯一最终产物的合成）。
 *
 * 执行模型（§二/§四）：fan-in = 多路子执行归并（N→1）；提交契约三值——全量
 * 回传 / 择优回传 / 仅回传决策。归并产物经**汇聚点（ESTUARY，唯一面向用户的
 * 收敛通道）**合成一次：子执行产物 + 摘要投影成单份最终产物；降级/失败子执行
 * 只产摘要，不进主载荷（用户语境不被后台污染）。
 *
 * 择优信号（确定性）：产物载荷带 `_quality`（数值，高者胜）时按其择优；否则按
 * 成本（低者胜）；再平 = 保持子执行完成顺序取先。decision_only 的采纳判定 = 至
 * 少一路成功（否决 = 全失败/全降级）；落选/试跑轨迹保留但隔离（不进主载荷）。
 * 失败子执行不产可采纳产物只贡献摘要；降级（部分产物）可采纳但摘要仍上浮。
 */

import type { ChannelCommit } from '../../model/channels/channel_spec.js';
import { CHANNEL_COMMIT_BEST, CHANNEL_COMMIT_DECISION_ONLY, CHANNEL_COMMIT_FULL } from '../../model/channels/channel_spec.js';
import type { ChildRunOutcome } from './runtime_types.js';

/** 载荷中的质量信号保留键（best 择优；缺席回落成本择优）。 */
export const MERGE_QUALITY_KEY = '_quality';

/** fan-in 归并结果（父执行把 adopted 产物并入自身载荷继续加工）。 */
export interface FanInMerged {
  contract: ChannelCommit;
  /** 全量/择优契约采纳的产物（decision_only = 空）。 */
  adopted: ChildRunOutcome[];
  /** 择优落选（保留但隔离：有轨迹不并入父载荷）。 */
  losers: ChildRunOutcome[];
  /** decision_only 的采纳决策（null = 非仅决策契约）。 */
  decision: boolean | null;
  /** 降级/失败子执行的可见摘要。 */
  degraded_summaries: string[];
}

/** 择优选胜者（确定性：质量信号 > 成本 > 完成序；无候选 = null）。 */
export function pick_best(children: readonly ChildRunOutcome[]): ChildRunOutcome | null {
  const candidates = children.filter((c) => c.outcome === 'success' || c.outcome === 'degraded');
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const cand = candidates[i]!;
    if (better_than(cand, best)) best = cand;
  }
  return best;
}

/** 质量/成本择优比较（true = a 胜于 b）。 */
export function better_than(a: ChildRunOutcome, b: ChildRunOutcome): boolean {
  const qa = quality_of(a.payload);
  const qb = quality_of(b.payload);
  if (qa !== null || qb !== null) {
    const sa = qa ?? -Infinity;
    const sb = qb ?? -Infinity;
    if (sa !== sb) return sa > sb;
  }
  const ca = cost_value(a.cost);
  const cb = cost_value(b.cost);
  if (ca !== cb) return ca < cb;
  return false;
}

function quality_of(payload: Record<string, unknown>): number | null {
  const raw = payload[MERGE_QUALITY_KEY];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function cost_value(cost: ChildRunOutcome['cost']): number {
  return typeof cost.cost === 'number' ? cost.cost : Infinity;
}

function summaries_of(children: readonly ChildRunOutcome[]): string[] {
  const out: string[] = [];
  for (const child of children) {
    if (child.outcome !== 'success' && child.summary !== null && child.summary !== '') {
      out.push(child.summary);
    }
  }
  return out;
}

/**
 * fan-in 归并（提交契约三值）。
 *
 * - full：全部可采纳产物（非失败）收齐（意见全收，主持人裁决）；
 * - best：只收最优；其余落选标记 adopted=false（有轨迹保留、隔离不入载荷）；
 * - decision_only：产物全部不采纳，只产采纳决策（fork_trial 试跑语义）。
 * 失败子执行任何契约下都不产可采纳产物，只贡献摘要；降级（有部分产物）在
 * full/best 下可采纳但摘要仍上浮。
 */
export function fan_in_merge(
  children: readonly ChildRunOutcome[],
  contract: ChannelCommit,
): FanInMerged {
  const degraded = summaries_of(children);
  const viable = (child: ChildRunOutcome): boolean => child.outcome !== 'failure';
  if (contract === CHANNEL_COMMIT_FULL) {
    return {
      contract,
      adopted: children.filter(viable),
      losers: [],
      decision: null,
      degraded_summaries: degraded,
    };
  }
  if (contract === CHANNEL_COMMIT_BEST) {
    const winner = pick_best(children);
    const adopted = winner === null ? [] : [winner];
    const losers = children
      .filter((child) => child !== winner)
      .map((child) => ({ ...child, adopted: false }));
    return {
      contract,
      adopted,
      losers,
      decision: null,
      degraded_summaries: degraded,
    };
  }
  if (contract === CHANNEL_COMMIT_DECISION_ONLY) {
    const decision = children.some((child) => child.outcome === 'success');
    return {
      contract,
      adopted: [],
      losers: [],
      decision,
      degraded_summaries: degraded,
    };
  }
  return fan_in_merge(children, CHANNEL_COMMIT_FULL);
}

/**
 * 汇聚点产物合成（唯一面向用户的单份产物）：
 * - 无采纳子产物 → 主持人自身载荷（直答/收口）；
 * - 单份采纳 → 合并进主持人载荷（后台产物并入主语境一次）；
 * - 多份采纳 → 收进 `results` 清单（不做多执行体各答一次）；
 * - 降级/失败子执行 → 摘要（degraded 键，用户可见面；原始产物不外泄）。
 */
export function estuary_synthesize(
  own_payload: Record<string, unknown>,
  adopted: readonly ChildRunOutcome[],
  degraded_summaries: readonly string[],
): Record<string, unknown> {
  const product: Record<string, unknown> = {};
  if (adopted.length === 0) {
    Object.assign(product, own_payload);
  } else if (adopted.length === 1) {
    const only = adopted[0]!;
    Object.assign(product, { ...only.payload });
    Object.assign(product, own_payload);
  } else {
    Object.assign(product, own_payload);
    product['results'] = adopted.map((child) => ({ ...child.payload }));
  }
  if (degraded_summaries.length > 0) {
    product['degraded'] = [...degraded_summaries];
  }
  return product;
}

/** 产物载荷剔除内部声明键（`__next` 路由 / `__amend` 改授权 / `__board` 写板；
 *  旧产物不残留的声明面清洗）。`_quality` 择优信号保留（fan_in 归并前需要它；
 *  注入主载荷时由调用方剥离）。 */
export function clean_payload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === '__next') continue;
    if (key === '__amend') continue;
    if (key === '__board') continue;
    out[key] = value;
  }
  return out;
}

/** 剥离载荷内部质量信号（归并采纳后注入主载荷前调用）。 */
export function strip_quality(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === MERGE_QUALITY_KEY) continue;
    out[key] = value;
  }
  return out;
}
