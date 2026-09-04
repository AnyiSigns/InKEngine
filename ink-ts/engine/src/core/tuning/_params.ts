/**
 * 调参数据形态（tuning.py TunableParams / ParameterSnapshot / TuneResult
 * dataclass 段移植）。
 *
 * - TunableParams：meta 节点的调参对象（机制参数 + 权重/阈值表）；
 * - ParameterSnapshot：参数快照（随评估记录落库：推演回放/审计按快照
 *   重算——快照冻结当时标尺，调参不改变历史推演的可回放性）；
 * - TuneResult：一次调参结果（新参数 + 变更说明 + 快照 + 显式拒绝语义）。
 *
 * Python frozen dataclass 语义由 readonly 字段 + Object.freeze 表达；
 * to_dict/from_dict 序列化对齐 Python（缺省字段不落盘/缺省兜底回填）。
 */

import { GraphDefinitionError } from '../errors.js';
import type { JsonRecord } from '../json.js';
import { isRecord, typeName } from '../json.js';
import { _DEFAULT_NOW } from './_constants.js';

// ── 可调参数集合（TunableParams）──

/** TunableParams 构造选项（Python dataclass 默认字段的 TS 映射）。 */
export interface TunableParamsInit {
  divergence_width?: number;
  retry_budget?: number;
  web_verify_threshold?: number;
  weights?: Readonly<Record<string, number>>;
  thresholds?: Readonly<Record<string, number>>;
}

/**
 * 可调参数集合（meta 节点的调参对象：机制参数 + 权重/阈值）。
 *
 * divergence_width：探索宽度（探索收敛的探索候选数）；retry_budget：
 * 重试预算（节点/调用的重试次数上限）；web_verify_threshold：web 验证
 * 触发阈值（存疑声明的置信度门槛）；weights：评审维度权重表（维度名 →
 * 权重；与 WeightedScorer 同构）；thresholds：校验/评审阈值表（阈值名 →
 * 数值；与规则集/打分器同构）。
 */
export class TunableParams {
  readonly divergence_width: number;
  readonly retry_budget: number;
  readonly web_verify_threshold: number;
  readonly weights: Record<string, number>;
  readonly thresholds: Record<string, number>;

  constructor(init: TunableParamsInit = {}) {
    this.divergence_width = init.divergence_width ?? 3;
    this.retry_budget = init.retry_budget ?? 1;
    this.web_verify_threshold = init.web_verify_threshold ?? 0.5;
    this.weights = init.weights ? { ...init.weights } : {};
    this.thresholds = init.thresholds ? { ...init.thresholds } : {};
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    return {
      divergence_width: this.divergence_width,
      retry_budget: this.retry_budget,
      web_verify_threshold: this.web_verify_threshold,
      weights: { ...this.weights },
      thresholds: { ...this.thresholds },
    };
  }

  static from_dict(data: unknown): TunableParams {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `可调参数声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const weights: Record<string, number> = {};
    const rawWeights = data['weights'];
    if (isRecord(rawWeights)) {
      for (const [key, value] of Object.entries(rawWeights)) {
        weights[String(key)] = Number(value);
      }
    }
    const thresholds: Record<string, number> = {};
    const rawThresholds = data['thresholds'];
    if (isRecord(rawThresholds)) {
      for (const [key, value] of Object.entries(rawThresholds)) {
        thresholds[String(key)] = Number(value);
      }
    }
    return new TunableParams({
      divergence_width: Math.trunc(Number(data['divergence_width'] ?? 3)),
      retry_budget: Math.trunc(Number(data['retry_budget'] ?? 1)),
      web_verify_threshold: Number(data['web_verify_threshold'] ?? 0.5),
      weights,
      thresholds,
    });
  }
}

// ── 参数快照（ParameterSnapshot）──

/** ParameterSnapshot 构造选项（Python dataclass 默认字段的 TS 映射）。 */
export interface ParameterSnapshotInit {
  rule_version?: string | null;
  params?: TunableParams;
  created_at?: number;
}

/**
 * 参数快照（随评估记录落库：推演回放/审计按快照重算）。
 *
 * 语义：评估时记录所用规则版本 + 权重/阈值快照——调参不改变历史推演
 * 的可回放性（「标尺在动」问题：快照冻结当时标尺）。created_at 为时间
 * seam（缺省确定性 0——core 零 IO 不依赖真实时钟）。
 */
export class ParameterSnapshot {
  readonly rule_version: string | null; // 规则集版本标识（null = 未关联版本）
  readonly params: TunableParams;
  readonly created_at: number;

  constructor(init: ParameterSnapshotInit = {}) {
    this.rule_version = init.rule_version ?? null;
    this.params = init.params ?? new TunableParams();
    this.created_at = init.created_at ?? _DEFAULT_NOW();
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    const data: JsonRecord = {
      params: this.params.to_dict(),
      created_at: this.created_at,
    };
    if (this.rule_version !== null) {
      data['rule_version'] = this.rule_version;
    }
    return data;
  }

  static from_dict(data: unknown): ParameterSnapshot {
    if (!isRecord(data) || !isRecord(data['params'])) {
      throw new GraphDefinitionError('参数快照声明非法（缺 params 结构）');
    }
    return new ParameterSnapshot({
      rule_version:
        data['rule_version'] === undefined || data['rule_version'] === null
          ? null
          : String(data['rule_version']),
      params: TunableParams.from_dict(data['params']),
      created_at: Number(data['created_at'] ?? _DEFAULT_NOW()),
    });
  }
}

// ── 一次调参结果（TuneResult）──

/** TuneResult 构造选项（Python dataclass 默认字段的 TS 映射）。 */
export interface TuneResultInit {
  params: TunableParams;
  changes?: readonly string[];
  snapshot?: ParameterSnapshot | null;
  note?: string;
  rejected?: boolean;
}

/**
 * 一次调参结果（新参数 + 变更说明 + 快照 + 可选说明）。
 *
 * params：生效参数（回归拒绝时 = 原参数，变更不落地）；changes：变更
 * 说明（空 = 无参数变化或变更被拒绝）；snapshot：参数快照（规则版本 +
 * 新参数；回归拒绝时 = null）；note：附加说明（回归未通过原因等）；
 * rejected：显式拒绝语义——True = 本次调参建议被回归拒绝（changes 为
 * 空不代表「无变化」——调用方据 rejected 区分「无参数变化」与「有建议
 * 但被拒绝」）。
 */
export class TuneResult {
  readonly params: TunableParams;
  readonly changes: readonly string[];
  readonly snapshot: ParameterSnapshot | null;
  readonly note: string;
  readonly rejected: boolean;

  constructor(init: TuneResultInit) {
    this.params = init.params;
    this.changes = init.changes ? [...init.changes] : [];
    this.snapshot = init.snapshot ?? null;
    this.note = init.note ?? '';
    this.rejected = init.rejected ?? false;
    Object.freeze(this);
  }

  to_dict(): JsonRecord {
    return {
      params: this.params.to_dict(),
      changes: [...this.changes],
      snapshot: this.snapshot ? this.snapshot.to_dict() : null,
      note: this.note,
      rejected: this.rejected,
    };
  }
}
