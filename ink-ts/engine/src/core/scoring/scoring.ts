/**
 * 加权打分器（维度 + 权重 + 阈值配置，纯确定性机制）——scoring.py 移植。
 *
 * 评审打分/校验判定「维度权重阈值」全部配置化：配置即数据
 * （ScoreDimension / ScoringConfig 可序列化，随补丁链版本化/回退；
 * 自适应调优直接改写权重/阈值数据，机制不变）。
 *
 * 语义：
 * - ScoreDimension：一个打分维度（名称 + 权重 + 可选达标线）；
 * - ScoringConfig：维度集合 + 总分达标线（配置校验在构造期暴露）；
 * - WeightedScorer：加权均值打分（按权重归一，0-1 区间）+ 维度达标判定 +
 *   总分门槛判定——纯函数式，无状态，可作模块级单例。
 *
 * 与评审-收敛原语的关系：评审器产出的质量分是「怎么评」（领域策略），
 * 打分器产出的总分/达标判定是「怎么算」（机制）。
 *
 * TS seam 差异：
 * - Python 侧在抛错前 logger.warning 留痕（调用方漏捕获时错误至少进日志，
 *   不静默炸链路）属可观测性副作用——core 纯函数零 IO 不落，抛错语义
 *   （fail-closed）照旧保留；
 * - Python 运行时抛 ValueError 的按既有移植口径分档：得分越界（数值区间
 *   类）映射 RangeError（同 patch_chain 裁剪点越界先例），口径漂移/未知
 *   缺失维度（语义标识类）映射 Error（同 tiers 声明校验先例）；
 * - 本机制纯确定性，无时间/随机依赖，无需 seam 注入。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';

/** Python str(list) 口径的清单渲染（错误消息携带名单，便于定位）。 */
function listRepr(items: readonly string[]): string {
  return `[${items.map((item) => `'${item}'`).join(', ')}]`;
}

/**
 * 单个打分维度（配置数据，可序列化）。
 *
 * name：维度名（配置内唯一）；weight：权重（>0，加权均值的归一依据）；
 * threshold：维度达标线（0-1，低于 = 该维度不达标，null = 不判定）。
 */
export class ScoreDimension {
  readonly name: string;
  readonly weight: number;
  readonly threshold: number | null;

  constructor(name: string, weight = 1.0, threshold: number | null = null) {
    this.name = name;
    this.weight = weight;
    this.threshold = threshold;
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = { name: this.name, weight: this.weight };
    if (this.threshold !== null) data['threshold'] = this.threshold;
    return data;
  }

  static from_dict(data: unknown): ScoreDimension {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `打分维度声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const name = data['name'];
    if (!name || typeof name !== 'string') {
      throw new GraphDefinitionError('打分维度缺 name（字符串）');
    }
    const rawWeight = data['weight'];
    const weight = rawWeight === undefined || rawWeight === null ? 1.0 : Number(rawWeight);
    if (weight <= 0) {
      throw new GraphDefinitionError(`维度 ${name} 的权重必须为正: ${weight}`);
    }
    const rawThreshold = data['threshold'];
    let threshold: number | null = null;
    if (rawThreshold !== undefined && rawThreshold !== null) {
      threshold = Number(rawThreshold);
      if (threshold < 0 || threshold > 1) {
        throw new GraphDefinitionError(
          `维度 ${name} 的达标线必须在 [0, 1] 内: ${threshold}`,
        );
      }
    }
    return new ScoreDimension(name, weight, threshold);
  }
}

/**
 * 打分配置（维度 + 权重 + 达标线，可序列化数据形态）。
 *
 * dimensions：打分维度序列（名称唯一，构造期校验）；
 * overall_threshold：总分达标线（0-1，null = 不做总分门槛判定）。
 */
export class ScoringConfig {
  readonly dimensions: readonly ScoreDimension[];
  readonly overall_threshold: number | null;

  constructor(
    dimensions: readonly ScoreDimension[] = [],
    overall_threshold: number | null = null,
  ) {
    this.dimensions = [...dimensions];
    this.overall_threshold = overall_threshold;
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      dimensions: this.dimensions.map((dim) => dim.to_dict()),
    };
    if (this.overall_threshold !== null) {
      data['overall_threshold'] = this.overall_threshold;
    }
    return data;
  }

  static from_dict(data: unknown): ScoringConfig {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `打分配置声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const rawDimensions = data['dimensions'] ?? [];
    if (!Array.isArray(rawDimensions)) {
      throw new GraphDefinitionError('打分配置的 dimensions 须为清单');
    }
    const dimensions = rawDimensions.map((raw) => ScoreDimension.from_dict(raw));
    const names = dimensions.map((dim) => dim.name);
    if (new Set(names).size !== names.length) {
      throw new GraphDefinitionError(`打分维度名重复: ${listRepr(names)}`);
    }
    const rawThreshold = data['overall_threshold'];
    let threshold: number | null = null;
    if (rawThreshold !== undefined && rawThreshold !== null) {
      threshold = Number(rawThreshold);
      if (threshold < 0 || threshold > 1) {
        throw new GraphDefinitionError(
          `总分达标线必须在 [0, 1] 内: ${threshold}`,
        );
      }
    }
    return new ScoringConfig(dimensions, threshold);
  }
}

/** 单个维度的实际得分（评估输入，0-1；note 随结果留痕）。 */
export class DimensionScore {
  readonly name: string;
  readonly score: number;
  readonly note: string;

  constructor(name: string, score: number, note = '') {
    this.name = name;
    this.score = score;
    this.note = note;
  }
}

/**
 * 一次加权打分的结果（总分 + 达标判定 + 逐维度明细，可审计）。
 *
 * total：加权均值总分（0-1，缺失维度按 0 计——口径校验已拒绝缺失，故
 * 正常路径总有权重和）；passed：总分是否达标（未配置总分达标线 = 恒通过）；
 * scores：逐维度得分；failing_dimensions：低于各自达标线的维度。
 */
export class ScoreResult {
  readonly total: number;
  readonly passed: boolean;
  readonly scores: readonly DimensionScore[];
  readonly failing_dimensions: readonly DimensionScore[];

  constructor(
    total: number,
    passed: boolean,
    scores: readonly DimensionScore[] = [],
    failing_dimensions: readonly DimensionScore[] = [],
  ) {
    this.total = total;
    this.passed = passed;
    this.scores = [...scores];
    this.failing_dimensions = [...failing_dimensions];
  }

  to_dict(): Record<string, unknown> {
    return {
      total: this.total,
      passed: this.passed,
      scores: this.scores.map((s) => ({ name: s.name, score: s.score, note: s.note })),
      failing_dimensions: this.failing_dimensions.map((s) => s.name),
    };
  }
}

/**
 * 加权打分器：维度得分 → 加权均值总分 + 双门槛判定。
 *
 * 计算语义（确定性，可断言）：
 * - 加权均值：total = Σ(score_i × weight_i) / Σ(weight_i)；
 * - 维度门槛：得分低于该维度达标线 → 计入 failing_dimensions；
 * - 总分门槛：total >= overall_threshold 才 passed（未配置 = 恒通过）。
 *
 * 配置即数据；权重/达标线随反馈学习演化（调参直接换配置数据，机制无状态
 * 不变）。达标线按维度名预建索引，避免每次打分重扫配置。
 */
export class WeightedScorer {
  readonly config: ScoringConfig;
  readonly #thresholds = new Map<string, number | null>();

  constructor(config: ScoringConfig) {
    this.config = config;
    for (const dimension of config.dimensions) {
      this.#thresholds.set(dimension.name, dimension.threshold);
    }
  }

  /**
   * 按配置对维度得分打分。输入可为「维度名 → 得分」映射或 DimensionScore
   * 序列（note 随结果留痕）。未知/缺失维度或得分越界显式报错——口径漂移
   * fail-closed，宁可报错不静默忽略（口径漂移会让调参基准失真）。
   */
  score(
    dimension_scores: Record<string, number> | readonly DimensionScore[],
  ): ScoreResult {
    const raw = new Map<string, DimensionScore>();
    if (Array.isArray(dimension_scores)) {
      for (const ds of dimension_scores) raw.set(ds.name, ds);
    } else {
      for (const [name, value] of Object.entries(dimension_scores)) {
        raw.set(name, new DimensionScore(name, value));
      }
    }
    const configuredNames = this.config.dimensions.map((dim) => dim.name);
    const configuredSet = new Set(configuredNames);
    const unknown = [...raw.keys()].filter((name) => !configuredSet.has(name)).sort();
    if (unknown.length > 0) {
      throw new Error(
        `未知打分维度: ${listRepr(unknown)}（配置 ${listRepr([...configuredNames].sort())}）`,
      );
    }
    const scores: DimensionScore[] = [];
    let weighted_sum = 0;
    let weight_sum = 0;
    for (const dimension of this.config.dimensions) {
      const actual = raw.get(dimension.name);
      if (actual === undefined) {
        throw new Error(
          `未提供维度 ${dimension.name} 的得分（配置 ${listRepr([...configuredNames].sort())}）`,
        );
      }
      const score = actual.score;
      if (score < 0 || score > 1) {
        throw new RangeError(`维度 ${dimension.name} 得分必须在 [0, 1] 内: ${score}`);
      }
      scores.push(actual);
      weighted_sum += score * dimension.weight;
      weight_sum += dimension.weight;
    }
    const failing_dimensions = scores.filter((ds) => this.#below_threshold(ds));
    const total = weight_sum ? weighted_sum / weight_sum : 0;
    const passed =
      this.config.overall_threshold === null || total >= this.config.overall_threshold;
    return new ScoreResult(total, passed, scores, failing_dimensions);
  }

  /** 维度得分是否低于该维度达标线（未配置达标线 = 恒达标）。 */
  #below_threshold(dimension_score: DimensionScore): boolean {
    const threshold = this.#thresholds.get(dimension_score.name);
    return threshold !== null && threshold !== undefined && dimension_score.score < threshold;
  }
}
