/**
 * 蒸馏协议与确定性基线（knowledge_signals.py 蒸馏面移植）。
 *
 * 蒸馏（华为云任务反思语义）：把轨迹压缩为结构化知识——丢弃试错分支，
 * 仅保留成功步骤/分支判断/异常修复；对已有知识的修正走精准补丁（replace
 * 语义，只改对应段落，不重写整条知识，见 reuse.ts 的 build_precise_patch
 * 契约点）。本文件承载蒸馏器协议（Distiller）、蒸馏产物（DistillOutcome）、
 * 蒸馏配置（DistillConfig）与零 LLM 的确定性基线（DeterministicDistiller）；
 * 蒸馏的挡位建链（resolve_distill_chain）与挡位蒸馏器（TieredDistiller）
 * 落 tiered.ts。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, type JsonRecord, typeName } from '../json.js';
import { KIND_INSIGHT } from '../knowledge_set/_types.js';
import {
  DEFAULT_COMPLEXITY_THRESHOLD,
  DEFAULT_DISTILL_TIER,
  DEFAULT_INTERVENTION_THRESHOLD,
  SIGNAL_INSIGHT,
  SIGNAL_PITFALL,
  SIGNAL_USER_CORRECTION,
  SOURCE_MODEL,
  SOURCE_RANK,
} from './_types.js';
import type { ExecutionSignal } from './signals.js';

/**
 * 蒸馏器协议：信号序列 → 结构化知识条目数据（丢弃试错分支）。
 *
 * 引擎规定「输入信号、输出知识数据」的契约；具体压缩策略（保留成功
 * 步骤/分支判断/异常修复，丢弃试错分支）由实现方决定——确定性基线
 * 见 DeterministicDistiller，LLM 蒸馏为可选扩展。
 */
export interface Distiller {
  distill(signals: readonly ExecutionSignal[]): JsonRecord | null;
}

/**
 * 一次蒸馏的产物（知识数据 + 来源/标签/说明，供闸门与沉淀）。
 *
 * frozen 语义由 readonly 表达；data 拷贝进入（防调用方复用改写）。
 */
export class DistillOutcome {
  readonly data: JsonRecord;
  readonly source: string;
  readonly tags: readonly string[];
  readonly title: string;
  readonly note: string;

  constructor(options: {
    data: JsonRecord;
    source: string;
    tags?: readonly string[];
    title?: string;
    note?: string;
  }) {
    this.data = { ...options.data };
    this.source = options.source;
    this.tags = options.tags ? [...options.tags] : [];
    this.title = options.title ?? '';
    this.note = options.note ?? '';
  }

  /** 序列化：省略默认值的紧凑形态（标签列表化，往返无损）。 */
  to_dict(): JsonRecord {
    const data: JsonRecord = { data: this.data, source: this.source };
    if (this.tags.length > 0) data.tags = [...this.tags];
    if (this.title) data.title = this.title;
    if (this.note) data.note = this.note;
    return data;
  }

  /** 反序列化（单点校验：data 必为 dict、tags 为字符串清单）。 */
  static from_dict(data: unknown): DistillOutcome {
    if (!isRecord(data) || !isRecord(data.data)) {
      throw new GraphDefinitionError(
        `蒸馏产物声明非法: 期望 {data: dict, ...}，收到 ${typeName(data)}`,
      );
    }
    const tags: unknown = data.tags ? data.tags : [];
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
      throw new GraphDefinitionError(
        `蒸馏产物 tags 须为字符串清单，收到 ${typeName(tags)}`,
      );
    }
    return new DistillOutcome({
      data: data.data,
      source: data.source === undefined || data.source === null ? SOURCE_MODEL : String(data.source),
      tags: tags as string[],
      title: data.title === undefined || data.title === null ? '' : String(data.title),
      note: data.note === undefined || data.note === null ? '' : String(data.note),
    });
  }
}

/**
 * 蒸馏配置（引擎配置开关 + 建链挡位）。
 *
 * 属性：
 * - enabled: distill_enabled 引擎配置开关（False = 关闭蒸馏——
 *   should_distill 恒 False、distill 恒 null，一键回到「无蒸馏」）。
 * - tier: 蒸馏建链挡位（默认 router 挡位；该挡位配置缺失回落
 *   main_config——挡位机制统一语义）。
 */
export class DistillConfig {
  readonly enabled: boolean;
  readonly tier: string;

  constructor(options: { enabled?: boolean; tier?: string } = {}) {
    this.enabled = options.enabled ?? true;
    this.tier = options.tier ?? DEFAULT_DISTILL_TIER;
  }

  to_dict(): JsonRecord {
    return { enabled: this.enabled, tier: this.tier };
  }

  static from_dict(data: unknown): DistillConfig {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `蒸馏配置声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    return new DistillConfig({
      enabled:
        data.enabled === undefined || data.enabled === null ? true : Boolean(data.enabled),
      tier: data.tier ? String(data.tier) : DEFAULT_DISTILL_TIER,
    });
  }
}

/**
 * 确定性蒸馏基线：信号 → 结构化知识（零 LLM 调用，可测试可断言）。
 *
 * 压缩语义：
 * - 只保留「成功路径结论」（insight 的成功经验 + user_correction 的
 *   修正反例——反例是「别这么做」的教训素材）；踩坑信号作为失败原因
 *   汇总进 note（教训来源），不直接成为知识内容（试错分支丢弃）；
 * - 输出 data = {"kind": KIND_INSIGHT, "insight": {message, context,
 *   note}}（insight 教训条目的声明形态——教训是经验文本而非可执行规则：
 *   无谓词实现，执行件不进知识集；闸门 L1 注入扫描+形式校验照常，L2 对
 *   无执行语义的教训条目跳过规则执行）；
 * - 来源取信号中最可信者（user > model > dialog > web 的确定性基准，
 *   与 SOURCE_RANK 模块级单一来源一致）。
 *
 * 蒸馏触发条件（按需非每回合）由使用方判定（复杂度/干预阈值），本实现
 * 只负责「触发后的压缩」。
 */
export class DeterministicDistiller implements Distiller {
  // 来源可信度基准（数值仅供排序，不产出可信度字段）——模块级
  // SOURCE_RANK 是唯一来源（ENG1-12 起模块级收口）
  static _SOURCE_RANK: Record<string, number> = SOURCE_RANK;

  readonly complexity_threshold: number;
  readonly intervention_threshold: number;

  constructor(
    options: {
      complexity_threshold?: number;
      intervention_threshold?: number;
    } = {},
  ) {
    this.complexity_threshold = options.complexity_threshold ?? DEFAULT_COMPLEXITY_THRESHOLD;
    this.intervention_threshold = options.intervention_threshold ?? DEFAULT_INTERVENTION_THRESHOLD;
  }

  /** 按需触发判定（华为云任务反思语义：复杂度或干预超过阈值才蒸馏）。
   *
   * 双阈值保守：两项都低 = 普通回合，不蒸馏（防「蒸馏垃圾进垃圾出」）。
   */
  should_distill(options: { complexity?: number; interventions?: number } = {}): boolean {
    const complexity = options.complexity ?? 0;
    const interventions = options.interventions ?? 0;
    return (
      complexity >= this.complexity_threshold || interventions >= this.intervention_threshold
    );
  }

  /** 信号 → 知识数据（无可沉淀信号返回 null）。
   *
   * Returns:
   *   知识条目 data（{"kind": "insight", "insight": {message, context,
   *   note}} 教训条目声明形态），或 null（全部为噪音/无成功路径结论——
   *   不产出空知识）。
   */
  distill(signals: readonly ExecutionSignal[]): JsonRecord | null {
    const usable = signals.filter(
      (s) => s.kind === SIGNAL_INSIGHT || s.kind === SIGNAL_USER_CORRECTION,
    );
    if (usable.length === 0) return null;
    // 修正反例优先（用户反例 = 最可靠规则素材），洞见次之
    const primary =
      usable.find((s) => s.kind === SIGNAL_USER_CORRECTION) ?? usable[0] as ExecutionSignal;
    const pitfalls = signals.filter((s) => s.kind === SIGNAL_PITFALL);
    const note = pitfalls.slice(0, 3).map((p) => p.message).join('; ');
    return {
      kind: KIND_INSIGHT,
      insight: {
        message: primary.message,
        context: { ...primary.context },
        note,
      },
    };
  }
}