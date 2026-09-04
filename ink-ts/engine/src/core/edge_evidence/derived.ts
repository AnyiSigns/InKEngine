/**
 * 边证据存储与派生指标（多径触发 / 冷启动指数）。
 *
 * 设计要点：
 * - 评分公式与档位推导 = tier_model（纯函数，本文件不重复实现）
 * - 持久化 = EdgeEvidenceStore（注入 seam，本目录零 sqlite/IO）
 * - 干预（downgrade / restore）落受控通道（EvolutionWriter + emit_audit）
 *
 * 多径触发（与评分公式同源派生，不另定阈值）：
 *   - top-1/top-2 任一 N<5 → 触发（样本不足）
 *   - N≥5 但分差<0.15 → 触发（证据不足/方差高）
 *   - 候选不足两条（含零条）→ 触发
 *
 * 冷启动指数 = 有证据边数 / 候选边数（0-1；候选为 0 时按 0 处理）；<0.3
 * 即探索模式（默认参数引擎钉死，宿主仅覆盖）。
 */

import {
  EXPLORATION_INDEX_THRESHOLD,
  MULTIPATH_GAP,
  MULTIPATH_MIN_N,
} from './_types.js';
import type { EdgeEvidence } from './_types.js';
import { edge_score } from './tier_model.js';

/**
 * 多径触发判据：top1/top2 任一缺失、N<5、或分差<MULTIPATH_GAP → 触发；
 * 仅提供判据信号，触发决策归使用方（本步只记录不裁决）。
 */
export function multi_path_trigger(
  top1: EdgeEvidence | null,
  top2: EdgeEvidence | null,
  opts: { now?: number | null } = {},
): boolean {
  if (top1 === null || top2 === null) return true;
  const n1 = top1.success_count + top1.fail_count;
  const n2 = top2.success_count + top2.fail_count;
  if (n1 < MULTIPATH_MIN_N || n2 < MULTIPATH_MIN_N) return true;
  const gap = Math.abs(
    edge_score(top1, { now: opts.now ?? null }).score -
    edge_score(top2, { now: opts.now ?? null }).score,
  );
  return gap < MULTIPATH_GAP;
}

/** 冷启动指数：有证据边数 / 候选边数（0-1；候选为 0 时按 0 处理）。 */
export function cold_start_index(evidenced_edges: number, candidate_edges: number): number {
  if (candidate_edges <= 0) return 0.0;
  return Math.min(1.0, evidenced_edges / candidate_edges);
}

/** 探索模式判定：冷启动指数 < 阈值 = 探索模式。 */
export function is_exploration_mode(index: number): boolean {
  return index < EXPLORATION_INDEX_THRESHOLD;
}