/**
 * 复用优先于生成与组合判定（knowledge_signals.py 复用面移植）。
 *
 * AgentFactory 教训的组合入口：先 knowledge_set.search（复用检索），命中
 * = 直接用既有知识（降蒸馏成本、防知识膨胀），蒸馏器不被调用；未命中才
 * 走蒸馏（按需触发后）。未命中且蒸馏无产物 = 两路皆空，note 说明（本次
 * 不沉淀，轨迹噪音不产出空知识）。来源取蒸馏可用信号（insight/
 * user_correction）中最可信者（ENG1-12：SOURCE_RANK 取最高者，user >
 * model > dialog > web；同分取先到达者——旧实现取 signals[0].source 会
 * 掩盖更早到达的更高可信来源）。
 */

import type { JsonRecord } from '../json.js';
import { DEFAULT_SEARCH_LIMIT } from '../knowledge_set/_types.js';
import { KnowledgeSet } from '../knowledge_set/knowledge_set.js';
import type { KnowledgeEntry } from '../knowledge_set/knowledge_entry.js';
import {
  SIGNAL_INSIGHT,
  SIGNAL_USER_CORRECTION,
  SOURCE_RANK,
  _FALLBACK_SOURCE,
} from './_types.js';
import { DistillOutcome, type Distiller } from './distill.js';
import type { ExecutionSignal } from './signals.js';

/**
 * 「复用优先于生成」的组合判定结果（检索命中或蒸馏产物，二选一）。
 *
 * reused_first = 组合断言：检索命中优先于重新蒸馏（命中时无蒸馏产物）。
 */
export class ReuseDecision {
  readonly reused: readonly KnowledgeEntry[];
  readonly distilled: DistillOutcome | null;
  readonly note: string;

  constructor(
    options: {
      reused?: readonly KnowledgeEntry[];
      distilled?: DistillOutcome | null;
      note?: string;
    } = {},
  ) {
    this.reused = options.reused ? [...options.reused] : [];
    this.distilled = options.distilled ?? null;
    this.note = options.note ?? '';
  }

  /** 组合断言：检索命中优先于重新蒸馏（命中时无蒸馏产物）。 */
  get reused_first(): boolean {
    return this.reused.length > 0 && this.distilled === null;
  }

  /** 序列化：条目引用清单（id 列表）+ 蒸馏产物（存在时）。 */
  to_dict(): JsonRecord {
    const data: JsonRecord = { note: this.note };
    if (this.reused.length > 0) data.reused = this.reused.map((e) => e.id);
    if (this.distilled !== null) data.distilled = this.distilled.to_dict();
    return data;
  }
}

/**
 * 复用优先于生成：相似任务先检索已有条目，命中即跳过重新蒸馏。
 *
 * Args:
 *   knowledge_set: 用户知识集（KnowledgeSet，search 协议）。
 *   query: 任务描述（检索关键词来源）。
 *   signals: 蒸馏输入信号（未命中复用时的素材）。
 *   distiller: 蒸馏器（命中复用时不调用——组合断言）。
 *   options.level/kind/limit: 检索过滤与上限（透传 search）。
 *   options.title/tags: 蒸馏产物的标题/标签（默认取查询词，保证可再检索）。
 *
 * Returns:
 *   ReuseDecision：reused = 检索命中条目（蒸馏跳过）；distilled =
 *   蒸馏产物（未命中时）；两者皆空 = 无可沉淀。
 */
export function reuse_or_distill(
  knowledge_set: KnowledgeSet,
  query: string,
  signals: readonly ExecutionSignal[],
  distiller: Distiller,
  options: {
    level?: string | null;
    kind?: string | null;
    limit?: number;
    title?: string;
    tags?: readonly string[];
  } = {},
): ReuseDecision {
  const hits = knowledge_set.search(query, {
    level: options.level ?? null,
    kind: options.kind ?? null,
    limit: options.limit ?? DEFAULT_SEARCH_LIMIT,
  });
  if (hits.length > 0) {
    return new ReuseDecision({
      reused: hits,
      note: `复用检索命中 ${hits.length} 条，跳过重新蒸馏（防知识膨胀）`,
    });
  }
  const data = distiller.distill(signals);
  if (data === null) {
    return new ReuseDecision({ note: '未命中复用且蒸馏无产物（本次不沉淀）' });
  }
  // 来源取蒸馏可用信号（insight/user_correction）中最可信者（ENG1-12）：
  // 旧实现无 user_correction 时取 signals[0].source——首条信号未必是
  // 最可信来源（如 web 先于 user 到达），会掩盖更高可信来源；SOURCE_RANK
  // 取最高者（user > model > dialog > web；同分取先到达者）。蒸馏输入
  // 全为噪音（无 insight/user_correction）时按全部信号取最高来源。
  const ranked = signals
    .filter((s) => s.kind === SIGNAL_INSIGHT || s.kind === SIGNAL_USER_CORRECTION)
    .map((s) => [s, SOURCE_RANK[s.source] ?? 0] as const);
  const rankedAll =
    ranked.length > 0 ? ranked : signals.map((s) => [s, SOURCE_RANK[s.source] ?? 0] as const);
  let source = _FALLBACK_SOURCE;
  let bestRank = -1;
  for (const [signal, rank] of rankedAll) {
    if (rank > bestRank) {
      bestRank = rank;
      source = signal.source;
    }
  }
  return new ReuseDecision({
    distilled: new DistillOutcome({
      data,
      source,
      title: options.title || query,
      tags: options.tags && options.tags.length > 0 ? options.tags : [query],
      note: '未命中复用，蒸馏产出新知识',
    }),
    note: '未命中复用，蒸馏产出新知识',
  });
}