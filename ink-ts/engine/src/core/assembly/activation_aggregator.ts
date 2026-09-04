/**
 * 激活留痕利用率聚合（MoE 辅助损失借鉴的观测件，assembly.py 移植）：
 * 输入 = 逐轮激活记录，输出 = 利用率快照（过热/过冷提示 + 逐条目明细）。
 *
 * 过热 = 激活失衡/粒度不当（提示检视激活规则与预算分级）；过冷 = 长期零
 * 激活的归档候选（衔接知识集归档机制与进化工厂「长期未调用」优先级）。
 * 本件只做聚合不新增裁剪机制——调试/审计/调参共用同一份「本次激活了
 * 什么」的聚合视图。
 */

import { MODE_DROP } from '../context/context_types.js';
import { GraphDefinitionError } from '../errors.js';
import type { ActivationRecord } from './assembly_types.js';

/** 利用率聚合默认阈值（MoE 辅助损失借鉴：数值为经验基线，宿主可注入）。 */
export const DEFAULT_OVERHEATED_RATE = 0.8;
/** 过冷窗口（最近 N 次调用内零激活 → 归档候选）。 */
export const DEFAULT_COLD_WINDOW = 10;

/** EntryActivationStats 构造选项。 */
export interface EntryActivationStatsInit {
  entry_ref: string;
  activations: number;
  total_weight: number;
  total_chars: number;
  last_activated_call: number;
  activation_rate: number;
}

/** 单个知识条目的激活聚合（利用率观测的最小单元）。 */
export class EntryActivationStats {
  readonly entry_ref: string;
  readonly activations: number; // 窗口内激活次数
  readonly total_weight: number; // 激活强度累计（weight 求和）
  readonly total_chars: number; // 分配字符累计
  readonly last_activated_call: number; // 最近一次激活所在的调用序号
  readonly activation_rate: number; // 激活次数 / 窗口调用数（0-1）

  constructor(init: EntryActivationStatsInit) {
    this.entry_ref = init.entry_ref;
    this.activations = init.activations;
    this.total_weight = init.total_weight;
    this.total_chars = init.total_chars;
    this.last_activated_call = init.last_activated_call;
    this.activation_rate = init.activation_rate;
  }

  /** 序列化为数据形态（落库契约）。 */
  to_dict(): Record<string, unknown> {
    return {
      entry_ref: this.entry_ref,
      activations: this.activations,
      total_weight: this.total_weight,
      total_chars: this.total_chars,
      last_activated_call: this.last_activated_call,
      activation_rate: this.activation_rate,
    };
  }

  /** 从数据形态还原（缺省兜底镜像 Python or 语义）。 */
  static from_dict(data: unknown): EntryActivationStats {
    const d = is_dict(data) ? data : {};
    return new EntryActivationStats({
      entry_ref: String(d['entry_ref'] ?? ''),
      activations: Math.trunc(Number(d['activations'] ?? 0)),
      total_weight: Number(d['total_weight'] ?? 0.0),
      total_chars: Math.trunc(Number(d['total_chars'] ?? 0)),
      last_activated_call: Math.trunc(Number(d['last_activated_call'] ?? 0)),
      activation_rate: Number(d['activation_rate'] ?? 0.0),
    });
  }
}

/** ActivationSummary 构造选项。 */
export interface ActivationSummaryInit {
  calls: number;
  total_refs: number;
  active_refs: number;
  utilization: number;
  overheated: readonly string[];
  cold: readonly string[];
  per_entry?: readonly EntryActivationStats[];
}

/**
 * 激活利用率聚合快照（MoE 辅助损失借鉴：过热/过冷提示）。
 *
 * - calls：聚合窗口内的调配调用数；
 * - total_refs：窗口内出现过的条目引用总数；
 * - active_refs：近期窗口内有激活的条目数；
 * - utilization：活跃条目 / 总条目（0-1；负载均衡观察）；
 * - overheated：过热条目（激活率 ≥ 阈值——激活失衡/粒度不当）；
 * - cold：过冷条目（曾激活但窗口内长期零激活——进归档候选）；
 * - per_entry：逐条目聚合明细（排序稳定，可断言）。
 */
export class ActivationSummary {
  readonly calls: number;
  readonly total_refs: number;
  readonly active_refs: number;
  readonly utilization: number;
  readonly overheated: readonly string[];
  readonly cold: readonly string[];
  readonly per_entry: readonly EntryActivationStats[];

  constructor(init: ActivationSummaryInit) {
    this.calls = init.calls;
    this.total_refs = init.total_refs;
    this.active_refs = init.active_refs;
    this.utilization = init.utilization;
    this.overheated = [...init.overheated];
    this.cold = [...init.cold];
    this.per_entry = init.per_entry ? [...init.per_entry] : [];
  }

  /** 序列化为数据形态（元组 → list，镜像 Python to_dict）。 */
  to_dict(): Record<string, unknown> {
    return {
      calls: this.calls,
      total_refs: this.total_refs,
      active_refs: this.active_refs,
      utilization: this.utilization,
      overheated: [...this.overheated],
      cold: [...this.cold],
      per_entry: this.per_entry.map((s) => s.to_dict()),
    };
  }

  /** 从数据形态还原（缺省兜底镜像 Python or 语义）。 */
  static from_dict(data: unknown): ActivationSummary {
    const d = is_dict(data) ? data : {};
    const raw_overheated = d['overheated'];
    const raw_cold = d['cold'];
    const raw_per_entry = d['per_entry'];
    return new ActivationSummary({
      calls: Math.trunc(Number(d['calls'] ?? 0)),
      total_refs: Math.trunc(Number(d['total_refs'] ?? 0)),
      active_refs: Math.trunc(Number(d['active_refs'] ?? 0)),
      utilization: Number(d['utilization'] ?? 0.0),
      overheated: Array.isArray(raw_overheated) ? raw_overheated.map(String) : [],
      cold: Array.isArray(raw_cold) ? raw_cold.map(String) : [],
      per_entry: Array.isArray(raw_per_entry)
        ? raw_per_entry.map((s) => EntryActivationStats.from_dict(s))
        : [],
    });
  }
}

/** ActivationAggregator 构造选项（Python kw-only 参数映射）。 */
export interface ActivationAggregatorOptions {
  overheated_rate?: number;
  cold_window?: number;
}

/**
 * 激活留痕利用率聚合（MoE 负载均衡借鉴的观测件）。
 *
 * 输入 = 逐轮激活记录（record，与 InputAssembler 的留痕同源），输出 =
 * 利用率快照（snapshot）：过热条目提示激活规则失衡/粒度不当（检视预算分
 * 级），过冷条目 = 长期零激活的归档候选——调试/审计/调参共用同一份
 * 「本次激活了什么」的聚合视图，不新增裁剪机制。
 */
export class ActivationAggregator {
  readonly overheated_rate: number;
  readonly cold_window: number;
  private _calls = 0;
  private _stats = new Map<string, [number, number, number, number]>();

  constructor(options: ActivationAggregatorOptions = {}) {
    const overheated_rate = options.overheated_rate ?? DEFAULT_OVERHEATED_RATE;
    const cold_window = options.cold_window ?? DEFAULT_COLD_WINDOW;
    if (!(overheated_rate > 0 && overheated_rate <= 1)) {
      throw new GraphDefinitionError(
        `过热激活率阈值必须在 (0, 1] 内: ${overheated_rate}`,
      );
    }
    if (cold_window < 1) {
      throw new GraphDefinitionError(`过冷窗口必须为正: ${cold_window}`);
    }
    this.overheated_rate = overheated_rate;
    this.cold_window = cold_window;
  }

  /**
   * 聚合一次调配留痕（逐源累积激活计数/强度/最近激活序号）。
   *
   * 被丢弃的源不计激活：char_limit<=0（分配为 0 = 本调用未纳入）或
   * mode=drop（预算/上限丢弃）的条目若计入激活，预算丢弃会反向推高
   * 「过热」判定、过冷归档候选失真——只有真正进入装配文本的源才算激活。
   */
  record(record: ActivationRecord): void {
    this._calls += 1;
    for (const source of record.sources) {
      const ref = source.entry_ref;
      if (!ref) continue; // 无条目引用的源（上下文/工具）不参与知识利用率
      if (source.char_limit <= 0 || source.mode === MODE_DROP) {
        continue; // 丢弃/零分配源不计激活
      }
      let stats = this._stats.get(ref);
      if (stats === undefined) {
        stats = [0, 0.0, 0, 0];
        this._stats.set(ref, stats);
      }
      stats[0] += 1; // 激活次数
      stats[1] += source.weight; // 激活强度累计
      stats[2] += source.char_limit; // 分配字符累计
      stats[3] = this._calls; // 最近激活调用序号
    }
  }

  /**
   * 汇出利用率快照（过热/过冷提示 + 逐条目明细，可落库审计）。
   *
   * 过热判定：激活率 ≥ 阈值（且窗口调用数 ≥ 2，单次调用不判定——无失衡
   * 语义）；过冷判定：曾激活但最近 cold_window 次调用内零激活（窗口调用
   * 数须超过冷窗，否则样本不足不判定）。
   */
  snapshot(): ActivationSummary {
    if (this._calls === 0) {
      return new ActivationSummary({
        calls: 0,
        total_refs: 0,
        active_refs: 0,
        utilization: 0.0,
        overheated: [],
        cold: [],
        per_entry: [],
      });
    }
    const stats: EntryActivationStats[] = [];
    for (const [ref, raw] of this._stats) {
      const [activations, weight, chars, last] = raw;
      stats.push(
        new EntryActivationStats({
          entry_ref: ref,
          activations,
          total_weight: weight,
          total_chars: chars,
          last_activated_call: last,
          activation_rate: activations / this._calls,
        }),
      );
    }
    stats.sort((a, b) => (a.entry_ref < b.entry_ref ? -1 : a.entry_ref > b.entry_ref ? 1 : 0));
    const active = stats.filter(
      (s) => s.last_activated_call > this._calls - this.cold_window,
    );
    const overheated = stats
      .filter(
        (s) => this._calls >= 2 && s.activation_rate >= this.overheated_rate,
      )
      .map((s) => s.entry_ref);
    const cold = stats
      .filter(
        (s) =>
          this._calls > this.cold_window &&
          s.last_activated_call <= this._calls - this.cold_window,
      )
      .map((s) => s.entry_ref);
    return new ActivationSummary({
      calls: this._calls,
      total_refs: stats.length,
      active_refs: active.length,
      utilization: stats.length > 0 ? active.length / stats.length : 0.0,
      overheated,
      cold,
      per_entry: stats,
    });
  }
}

/** dict 判定（本文件 from_dict 的形态门禁）。 */
function is_dict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
