/**
 * open 圆桌收敛判据（设计稿 agent_execution_design.md §7.4.3 的纯数据面）：
 * judge_round 判定一轮过后圆桌是否收敛——「无新实质意见」或「≥k 方确认」→ 收；
 * 轮次上限 R 触顶仍不收敛 → 停止加轮，移交 main 拍板或降级（成本封顶）。
 *
 * 语义决策（定案，测试锚定）：
 * - digest = 意见实质指纹（规范化文本 + owner，不含 seq——seq 是簿记不是实质），
 *   与上一轮全等 = 无新实质意见；
 * - 确认 = 内容或显式结论值带确认标记，按去重 owner 计数；
 * - 三判据检查序：无新实质 → ≥k 确认 → 轮次触顶（正向判据优先）；
 * - converged=true ⇢ 自然收敛；converged=false + rounds_exhausted ⇢ 触顶不收敛
 *   （停止加轮，非共识）；reason='ongoing' ⇢ 未触发判据，圆桌继续。
 *
 * 纯数据面（JSON 进 JSON 出、零 IO、零宿主词）。
 */

import { normalize_opinion_text } from './normalize.js';
import type { OpinionEntry } from './opinion.js';

/** 轮次上限缺省（R 封顶，§7.4.3：缺省 8）。 */
export const DEFAULT_ROUNDS_CAP = 8;

/** 确认人数缺省（≥k 方确认；k=2 = 三席圆桌的多数下限）。 */
export const DEFAULT_CONFIRM_K = 2;

/** 确认标记词表（§7.4.3「≥k 方确认」的标记统计口径）。 */
export const CONFIRM_MARKERS = ['确认', '同意', '认可'] as const;

export interface ConvergenceConfig {
  /** 当前轮次（1 起，缺省 1）。 */
  round?: number;
  /** 轮次上限 R（缺省 8）。 */
  rounds_cap?: number;
  /** 确认人数下限 k（缺省 2）。 */
  confirm_k?: number;
}

export type ConvergenceReason = 'no_new_substantive' | 'confirmed_by_k' | 'rounds_exhausted' | 'ongoing';

export interface ConvergenceVerdict {
  /** true = 圆桌自然收敛；false = 继续或触顶移交（看 reason）。 */
  converged: boolean;
  reason: ConvergenceReason;
}

/**
 * 本轮意见实质指纹：规范化文本按 (owner, text) 规范序拼串。
 * 不含 seq（簿记非实质）；同轮重复意见按原样保留（重复条目 = 重复实质）。
 */
export function opinions_digest(opinions: readonly OpinionEntry[]): string {
  return opinions
    .map((o) => ({ owner: o.owner, text: normalize_opinion_text(o.content) }))
    .sort((x, y) => (x.owner === y.owner ? (x.text < y.text ? -1 : x.text > y.text ? 1 : 0) : x.owner < y.owner ? -1 : 1))
    .map((o) => `${o.owner}:${o.text}`)
    .join('\n');
}

/** 带确认标记的去重 owner 清单（内容或显式结论值含 CONFIRM_MARKERS 即计）。 */
export function confirmers(opinions: readonly OpinionEntry[]): string[] {
  const owners = new Set<string>();
  for (const o of opinions) {
    const text = normalize_opinion_text(o.content);
    const verdict = normalize_opinion_text(o.verdict ?? o.stance ?? '');
    const hit = CONFIRM_MARKERS.some((m) => text.includes(m) || (verdict !== '' && verdict.includes(m)));
    if (hit) owners.add(o.owner);
  }
  return [...owners].sort();
}

/**
 * 收敛判据（§7.4.3）：无新实质意见（digest 全等）或 ≥k 方确认 → 收；
 * 触及轮次上限 R 仍不收敛 → 停止加轮（成本封顶，移交 main）；
 * 其余 = ongoing（圆桌继续）。配置值非法时按缺省收敛到安全档。
 */
export function judge_round(
  previousDigest: string | null,
  opinions: readonly OpinionEntry[],
  config: ConvergenceConfig = {},
): ConvergenceVerdict {
  const cap = _finite_at_least(config.rounds_cap, 1) ? (config.rounds_cap as number) : DEFAULT_ROUNDS_CAP;
  const k = _finite_at_least(config.confirm_k, 1) ? (config.confirm_k as number) : DEFAULT_CONFIRM_K;
  const round = _finite_at_least(config.round, 1) ? (config.round as number) : 1;
  if (
    previousDigest !== null &&
    previousDigest !== undefined &&
    previousDigest === opinions_digest(opinions)
  ) {
    return { converged: true, reason: 'no_new_substantive' };
  }
  if (confirmers(opinions).length >= k) {
    return { converged: true, reason: 'confirmed_by_k' };
  }
  if (round >= cap) {
    return { converged: false, reason: 'rounds_exhausted' };
  }
  return { converged: false, reason: 'ongoing' };
}

function _finite_at_least(value: unknown, floor: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= floor;
}
