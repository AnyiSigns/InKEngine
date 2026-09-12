/**
 * 协作裁决数据面（设计稿 agent_execution_design.md §7.4.4 归并契约与裁决）：
 * ①去重 → ②冲突检测 → ③综合输入 → ④仲裁，四步全为确定性纯函数。
 *
 * 职责边界：本模块只做结构化——冲突「不裁决内容」，综合由 main 的 LLM turn
 * 消费 SynthesisInput 完成；仲裁只按优先序给冲突对建议方向（纯确定性规则，
 * 不调模型）。语义决策（定案，测试锚定）：
 * - 同主题 = 同一批 fan-in 意见集合（open 圆桌一次归并对应唯一任务块），
 *   冲突对在批内两两判定；「同 owner 自相矛盾」不入冲突对；
 * - 去重合并 = 规范化文本全等或包含；例外：包含关系且恰一边带显式反对标记
 *   → 不合并（反对意见针对被包含意见，属冲突信号，交 ② 检出）；
 * - 冲突双路径：verdict/stance 显式结论不同 = 冲突（主，逐条两两——同组同文
 *   不同显式结论也须检出）；无显式结论时按内容显式「反对/否决」标记 + 文本
 *   相同/包含定位被反对对象（次，在去重组代表间两两——同声重复折叠为一票）；
 * - 两路径对同对不重复报：双方均有显式结论时由 verdict 路径独占（字段标记
 *   优先于内容标记），结论全等 = 同结论不冲突。
 *
 * 纯数据面（JSON 进 JSON 出、零 IO、零宿主词）。
 */

import { isRecord } from '../../model/json.js';
import type { ScopeIoContract } from '../../model/scopes/scope_spec.js';
import { normalize_opinion_text, texts_related } from './normalize.js';
import {
  parse_opinion_entry,
  validate_opinion_schema,
  type OpinionEntry,
  type RejectedOpinion,
} from './opinion.js';

// ── 仲裁优先序（§7.4.4 ④：用户 > 质量信号 > 先验；命名常量单一真源）──

export const ARBITRATION_USER = 'user';
export const ARBITRATION_QUALITY = 'quality';
export const ARBITRATION_PRIOR = 'prior';

/** 仲裁优先序（缺省 = 用户 > 质量信号 > 先验；调用方可传序重排）。 */
export const ARBITRATION_PRIORITY = [ARBITRATION_USER, ARBITRATION_QUALITY, ARBITRATION_PRIOR] as const;

export type ArbitrationPriority = (typeof ARBITRATION_PRIORITY)[number];
/** 仲裁依据；'tie' = 各级均无决定性信号，交 main 拍板。 */
export type ArbitrationBasis = ArbitrationPriority | 'tie';

/** 前台用户作用域 id（白板 grants 默认 userScope，见 core/whiteboard/grants.ts）。 */
export const USER_SCOPE = 'user';

/** 显式反对标记词表（无 verdict 时按内容标记检测冲突；§7.4.4 ②）。 */
export const OPPOSE_MARKERS = ['反对', '否决'] as const;

/** 冲突建议方向（side=null = 建议不了，交 main）。 */
export interface ConflictSuggestion {
  side: 'a' | 'b' | null;
  basis: ArbitrationBasis;
}

/** 冲突对（a/b 为批内两条意见；kind = 检出路径）。 */
export interface ConflictPair {
  a: OpinionEntry;
  b: OpinionEntry;
  kind: 'verdict' | 'marker';
  suggestion: ConflictSuggestion;
}

/** 去重组：代表 = 组内规范化文本最长者（包含者胜出，全等取先到）。 */
export interface DedupeGroup {
  representative: OpinionEntry;
  /** 成员清单（含代表，保序）。 */
  members: OpinionEntry[];
}

export interface ArbitrationOptions {
  /** 质量信号（owner → 分值；双方都有有限分值且不等才有信号）。 */
  quality?: Record<string, number> | null;
  /** 优先序重排（缺省 = ARBITRATION_PRIORITY）。 */
  priority?: readonly ArbitrationPriority[];
}

export interface AdjudicationOptions {
  /** 协作方 scope 资产 produces 契约（意见块无自带 schema 时的门禁回退）。 */
  contract?: ScopeIoContract | null;
  /** 质量信号（透传 ④ 仲裁）。 */
  quality?: Record<string, number> | null;
}

/** ③ 综合输入：单点（去重组代表 + 成员 owner）。 */
export interface SynthesisPoint {
  owner: string;
  content: string;
  seq: number;
  members: { owner: string; seq: number }[];
}

/** ③ 综合输入：冲突对（含 ④ 仲裁建议方向）。 */
export interface SynthesisConflict {
  a: { owner: string; content: string; seq: number };
  b: { owner: string; content: string; seq: number };
  kind: 'verdict' | 'marker';
  suggestion: ConflictSuggestion;
}

/** main 裁决（LLM turn）消费的结构化摘要。 */
export interface SynthesisInput {
  points: SynthesisPoint[];
  conflicts: SynthesisConflict[];
  /** 逐条来源（accepted 全量，owner + seq）。 */
  sources: { owner: string; seq: number }[];
  /** 失败清单（schema 门禁剔除记录，main 应知悉）。 */
  rejected: RejectedOpinion[];
}

export interface AdjudicationResult {
  accepted: OpinionEntry[];
  rejected: RejectedOpinion[];
  groups: DedupeGroup[];
  conflicts: ConflictPair[];
  synthesis: SynthesisInput;
}

// ── ①去重 ──

/** 内容是否带显式反对/否决标记（规范化后按 OPPOSE_MARKERS 词表判定）。 */
export function is_oppose_marked(content: string): boolean {
  const text = normalize_opinion_text(content);
  return OPPOSE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * ①去重：规范化文本相同或包含 → 合并为组（保留代表 + 成员清单）。
 * 例外：包含关系且恰一边反对标记 → 不合并（反对信号，交 ②）。
 * 保序贪心：与既有组任一成员相关即入组；代表 = 组内规范化文本最长者，
 * 全等取先到。
 */
export function dedupe_opinions(entries: readonly OpinionEntry[]): DedupeGroup[] {
  const groups: DedupeGroup[] = [];
  for (const entry of entries) {
    const text = normalize_opinion_text(entry.content);
    const marked = is_oppose_marked(entry.content);
    const target = groups.find((g) =>
      g.members.some((m) => {
        const memberText = normalize_opinion_text(m.content);
        if (!texts_related(text, memberText)) return false;
        if (text === memberText) return true;
        return marked === is_oppose_marked(m.content);
      }),
    );
    if (target !== undefined) {
      target.members.push(entry);
      if (text.length > normalize_opinion_text(target.representative.content).length) {
        target.representative = entry;
      }
    } else {
      groups.push({ representative: entry, members: [entry] });
    }
  }
  return groups;
}

// ── ④仲裁 ──

/** 显式结论值（verdict 主、stance 次；皆缺 = null）。 */
export function explicit_value(entry: OpinionEntry): string | null {
  return entry.verdict ?? entry.stance ?? null;
}

/**
 * ④仲裁：按优先序给冲突对建议方向（纯确定性规则，逐级取第一个有信号者）。
 * user = 用户作用域意见直取；quality = 双方质量分俱在且不等取高分；
 * prior = 先验先到（seq 小者）；各级皆无信号 → side=null（交 main 拍板）。
 */
export function arbitrate_conflict(a: OpinionEntry, b: OpinionEntry, options: ArbitrationOptions = {}): ConflictSuggestion {
  const order = options.priority ?? ARBITRATION_PRIORITY;
  for (const level of order) {
    if (level === ARBITRATION_USER) {
      if (a.owner === USER_SCOPE && b.owner !== USER_SCOPE) return { side: 'a', basis: ARBITRATION_USER };
      if (b.owner === USER_SCOPE && a.owner !== USER_SCOPE) return { side: 'b', basis: ARBITRATION_USER };
    } else if (level === ARBITRATION_QUALITY) {
      const qa = options.quality?.[a.owner];
      const qb = options.quality?.[b.owner];
      if (
        typeof qa === 'number' && Number.isFinite(qa) &&
        typeof qb === 'number' && Number.isFinite(qb) && qa !== qb
      ) {
        return qa > qb ? { side: 'a', basis: ARBITRATION_QUALITY } : { side: 'b', basis: ARBITRATION_QUALITY };
      }
    } else if (level === ARBITRATION_PRIOR) {
      if (a.seq !== b.seq) {
        return a.seq < b.seq ? { side: 'a', basis: ARBITRATION_PRIOR } : { side: 'b', basis: ARBITRATION_PRIOR };
      }
    }
  }
  return { side: null, basis: 'tie' };
}

// ── ②冲突检测 ──

/**
 * ②冲突检测：输出冲突对清单，不裁决内容。
 * verdict 路径（主）：逐条两两——双方显式结论（verdict ?? stance）规范化后
 * 不同 = 冲突（同组同文不同显式结论也须检出）；全等 = 同结论不冲突。
 * marker 路径（次）：在去重组代表间两两——恰一边内容带反对标记且两文本
 * 相同/包含 = 冲突（定位被反对对象；同声重复折叠为一票）。
 * 同 owner 两两不计（自相矛盾非协作冲突）。
 */
export function detect_conflicts(entries: readonly OpinionEntry[], options: ArbitrationOptions = {}): ConflictPair[] {
  const pairs: ConflictPair[] = [];
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j];
      if (b === undefined) continue;
      if (a.owner === b.owner) continue;
      const va = explicit_value(a);
      const vb = explicit_value(b);
      if (va !== null && vb !== null && normalize_opinion_text(va) !== normalize_opinion_text(vb)) {
        pairs.push({ a, b, kind: 'verdict', suggestion: arbitrate_conflict(a, b, options) });
      }
    }
  }
  const reps = dedupe_opinions(entries).map((g) => g.representative);
  for (let i = 0; i < reps.length; i++) {
    const a = reps[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < reps.length; j++) {
      const b = reps[j];
      if (b === undefined) continue;
      if (a.owner === b.owner) continue;
      if (explicit_value(a) !== null && explicit_value(b) !== null) continue;
      const markedA = is_oppose_marked(a.content);
      const markedB = is_oppose_marked(b.content);
      if (markedA !== markedB && texts_related(normalize_opinion_text(a.content), normalize_opinion_text(b.content))) {
        pairs.push({ a, b, kind: 'marker', suggestion: arbitrate_conflict(a, b, options) });
      }
    }
  }
  return pairs;
}

// ── ③综合输入 ──

/** 按去重组 + 冲突标记生成 main 裁决用结构化摘要（代表/冲突对/逐条来源/失败清单）。 */
export function build_synthesis(
  groups: readonly DedupeGroup[],
  conflicts: readonly ConflictPair[],
  accepted: readonly OpinionEntry[],
  rejected: readonly RejectedOpinion[],
): SynthesisInput {
  return {
    points: groups.map((g) => ({
      owner: g.representative.owner,
      content: g.representative.content,
      seq: g.representative.seq,
      members: g.members.map((m) => ({ owner: m.owner, seq: m.seq })),
    })),
    conflicts: conflicts.map((c) => ({
      a: { owner: c.a.owner, content: c.a.content, seq: c.a.seq },
      b: { owner: c.b.owner, content: c.b.content, seq: c.b.seq },
      kind: c.kind,
      suggestion: c.suggestion,
    })),
    sources: accepted.map((e) => ({ owner: e.owner, seq: e.seq })),
    rejected: [...rejected],
  };
}

// ── 门面：四步编排（JSON 进 → 结构化结果出，不抛错）──

function _canonical_order(x: OpinionEntry, y: OpinionEntry): number {
  return x.seq - y.seq || (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0);
}

function _raw_field(data: unknown, key: string): string | number {
  if (!isRecord(data)) return key === 'seq' ? 0 : '';
  const value = data[key];
  if (key === 'seq') return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return typeof value === 'string' ? value : '';
}

/**
 * 裁决门面：①schema 门禁剔除记失败 → ②去重组 → ③冲突检测+仲裁 → ④综合输入。
 * 输入为原始 JSON 清单（形状/契约不符剔除并记失败，绝不抛错）；accepted 按
 * (seq, owner) 规范序排列，结果全为可 JSON 序列化的纯数据（round-trip 稳定）。
 */
export function adjudicate(opinions: readonly unknown[], options: AdjudicationOptions = {}): AdjudicationResult {
  const rejected: RejectedOpinion[] = [];
  const accepted: OpinionEntry[] = [];
  const contract = options.contract ?? null;
  for (const raw of opinions) {
    const parsed = parse_opinion_entry(raw);
    if (!parsed.ok) {
      rejected.push({
        owner: _raw_field(raw, 'owner') as string,
        seq: _raw_field(raw, 'seq') as number,
        content: _raw_field(raw, 'content') as string,
        reasons: parsed.reasons,
      });
      continue;
    }
    const violations = validate_opinion_schema(parsed.entry, contract);
    if (violations.length > 0) {
      rejected.push({
        owner: parsed.entry.owner,
        seq: parsed.entry.seq,
        content: parsed.entry.content,
        reasons: violations,
      });
      continue;
    }
    accepted.push(parsed.entry);
  }
  accepted.sort(_canonical_order);
  const groups = dedupe_opinions(accepted);
  const conflicts = detect_conflicts(accepted, { quality: options.quality ?? null });
  return {
    accepted,
    rejected,
    groups,
    conflicts,
    synthesis: build_synthesis(groups, conflicts, accepted, rejected),
  };
}
