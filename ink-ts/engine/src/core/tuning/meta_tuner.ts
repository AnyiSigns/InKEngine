// gate: 超限(383 行) - 调参器单类闭环（指标→回写→回归），内部私有状态跨方法共享，拆文件破坏连续性
/**
 * 调参器（tuning.py MetaTuner 段移植）：回合指标 + 卡回路反馈 → 参数调整。
 *
 * 调整语义（可解释、可断言）：
 * - 卡回路反馈降权：反馈中低分维度（< 反馈阈值）的权重乘衰减系数（下限
 *   保护 MIN_WEIGHT）——评审评分随权重调整变化，避免劣质维度主导总分；
 * - 失败率 → 重试预算：失败率高则上调重试预算（容错），低则回落（省成本）；
 * - 失败率 → web 验证阈值：失败率高下调验证阈值（更早触发验证），低则
 *   上调（减少无谓验证）；
 * - 收敛轮数 → 探索宽度：平均收敛轮数偏高则加宽探索（探索更多候选），
 *   偏低则收窄（收敛更快）。
 *
 * 参数变更过 L2 效果评估回归（参数不走 L1/L3——参数无「旧版」可比）；
 * 与知识孵化闭环：调参结果经知识集回写（种子条目同 id，幂等不覆盖演化），
 * 下次调参从条目读回基线。
 */

import { GraphDefinitionError } from '../errors.js';
import type { JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import { KnowledgeGate } from '../knowledge_gate/index.js';
import {
  KIND_WEIGHT,
  LEVEL_WORK,
  SOURCE_MODEL,
  KnowledgeEntry,
  type KnowledgeSet,
} from '../knowledge_set/index.js';
import type { FixtureSet } from '../rules/index.js';
import { GENERAL_WEIGHTS_SEED_ID } from '../seeds/seeds.js';
import {
  CONVERGENCE_AVG_HIGH,
  CONVERGENCE_AVG_LOW,
  DIVERGENCE_WIDTH_MAX,
  DIVERGENCE_WIDTH_MIN,
  FAILURE_RATE_HIGH,
  FAILURE_RATE_LOW,
  MAX_WEIGHT,
  MIN_WEIGHT,
  RETRY_BUDGET_FLOOR,
  WEB_THRESHOLD_MAX,
  WEB_THRESHOLD_MIN,
  WEB_THRESHOLD_STEP,
  WEIGHT_DECAY,
  WEIGHT_GAIN,
} from './_constants.js';
import { ParamRegressionExecutor } from './_executor.js';
import { _fmt1, _fmt2, _params_entry } from './_helpers.js';
import { ParameterSnapshot, TunableParams, TuneResult } from './_params.js';
import type { TurnMetrics } from './_turn_metrics.js';

/** MetaTuner 构造选项（Python __init__ 关键字参数映射）。 */
export interface MetaTunerOptions {
  feedback_threshold?: number;
  weight_decay?: number;
  weight_gain?: number;
  min_weight?: number;
  max_weight?: number;
  knowledge_set?: KnowledgeSet | null;
  snapshot_sink?: ((snapshot: ParameterSnapshot) => unknown) | null;
}

/** tune 系列入口的公共关键字参数。 */
export interface TuneOptions {
  feedback?: Readonly<Record<string, number>> | null;
  rule_version?: string | null;
}

/** tune_with_regression 追加关键字参数。 */
export interface TuneWithRegressionOptions extends TuneOptions {
  gate?: KnowledgeGate | null;
  regression?: FixtureSet | null;
}

/**
 * 调参器：回合指标 + 卡回路反馈 → 参数调整（确定性基线，可断言）。
 *
 * 越界权重在调参入口收敛到边界（历史遗留越界不阻塞后续调参）；低分维度
 * 反馈降权 / 高分维度反馈升权均有上下限保护（防维度形同虚设或失衡主导）。
 */
export class MetaTuner {
  readonly feedback_threshold: number;
  readonly weight_decay: number;
  readonly weight_gain: number;
  readonly min_weight: number;
  readonly max_weight: number;
  // 参数条目回写集成点（与知识孵化闭环：调参结果持久化进知识集的权重/
  // 阈值条目，下次调参从条目读回基线；null = 不落知识集）
  readonly knowledge_set: KnowledgeSet | null;
  // 参数快照落库集成点（随评估记录持久化——机制数据引擎存，落库实现由
  // 使用方注入；null = 不落库）。回归通过的参数快照经此回调交给存储侧，
  // 回放/审计按快照重算。
  readonly snapshot_sink: ((snapshot: ParameterSnapshot) => unknown) | null;

  constructor(options: MetaTunerOptions = {}) {
    this.feedback_threshold = options.feedback_threshold ?? 0.5;
    this.weight_decay = options.weight_decay ?? WEIGHT_DECAY;
    this.weight_gain = options.weight_gain ?? WEIGHT_GAIN;
    this.min_weight = options.min_weight ?? MIN_WEIGHT;
    this.max_weight = options.max_weight ?? MAX_WEIGHT;
    this.knowledge_set = options.knowledge_set ?? null;
    this.snapshot_sink = options.snapshot_sink ?? null;
  }

  /** 越界权重收敛到边界（调参入口：历史遗留越界不阻塞后续调参）。 */
  private _normalize_weights(weights: Record<string, number>): string[] {
    const changes: string[] = [];
    for (const [name, value] of Object.entries(weights)) {
      if (value < this.min_weight) {
        weights[name] = this.min_weight;
        changes.push(
          `维度 ${name} 权重越下限（${_fmt2(value)}）收敛到 ${this.min_weight}`,
        );
      } else if (value > this.max_weight) {
        weights[name] = this.max_weight;
        changes.push(
          `维度 ${name} 权重越上限（${_fmt2(value)}）收敛到 ${this.max_weight}`,
        );
      }
    }
    return changes;
  }

  /**
   * 按指标与反馈调整参数（无变化时返回原参数，changes 为空）。
   *
   * feedback：卡回路反馈（维度名 → 得分 0-1；null = 无反馈，仅按执行
   * 统计调机制参数）；rule_version：规则集版本标识（随快照落库；null =
   * 快照不落——调用方在需要回放语义时提供）。
   */
  tune(
    params: TunableParams,
    metrics: TurnMetrics,
    options: TuneOptions = {},
  ): TuneResult {
    const feedback = options.feedback ?? null;
    const ruleVersion = options.rule_version ?? null;
    const changes: string[] = [];
    const weights = { ...params.weights };
    changes.push(...this._normalize_weights(weights));
    for (const [dimension, score] of Object.entries(feedback ?? {})) {
      if (!(dimension in weights)) {
        continue; // 未知维度不调整（口径漂移由配置侧修复）
      }
      if (score < this.feedback_threshold) {
        const newWeight = Math.max(
          weights[dimension]! * this.weight_decay,
          this.min_weight,
        );
        if (newWeight !== weights[dimension]) {
          changes.push(
            `维度 ${dimension} 低分（${_fmt2(score)}）降权: ` +
              `${_fmt2(weights[dimension]!)} → ${_fmt2(newWeight)}`,
          );
          weights[dimension] = newWeight;
        }
      } else if (score > this.feedback_threshold) {
        const newWeight = Math.min(
          weights[dimension]! * this.weight_gain,
          this.max_weight,
        );
        if (newWeight !== weights[dimension]) {
          changes.push(
            `维度 ${dimension} 高分（${_fmt2(score)}）升权: ` +
              `${_fmt2(weights[dimension]!)} → ${_fmt2(newWeight)}`,
          );
          weights[dimension] = newWeight;
        }
      }
    }

    const failureRate = metrics.failure_rate;
    let retryBudget = params.retry_budget;
    if (failureRate >= FAILURE_RATE_HIGH) {
      const newRetry = Math.max(retryBudget, RETRY_BUDGET_FLOOR);
      if (newRetry !== retryBudget) {
        retryBudget = newRetry;
        changes.push(`失败率 ${_fmt2(failureRate)} 偏高，重试预算上调至 ${retryBudget}`);
      }
    } else if (
      metrics.turns > 0 &&
      failureRate <= FAILURE_RATE_LOW &&
      retryBudget > 1
    ) {
      retryBudget -= 1;
      changes.push(`失败率 ${_fmt2(failureRate)} 偏低，重试预算回落至 ${retryBudget}`);
    }

    let webVerifyThreshold = params.web_verify_threshold;
    if (failureRate >= FAILURE_RATE_HIGH) {
      const newThreshold = Math.max(
        webVerifyThreshold - WEB_THRESHOLD_STEP,
        WEB_THRESHOLD_MIN,
      );
      if (newThreshold !== webVerifyThreshold) {
        webVerifyThreshold = newThreshold;
        changes.push(
          `失败率 ${_fmt2(failureRate)} 偏高，web 验证阈值下调至 ${_fmt2(webVerifyThreshold)}`,
        );
      }
    } else if (metrics.turns > 0 && failureRate <= FAILURE_RATE_LOW) {
      const newThreshold = Math.min(
        webVerifyThreshold + WEB_THRESHOLD_STEP,
        WEB_THRESHOLD_MAX,
      );
      if (newThreshold !== webVerifyThreshold) {
        webVerifyThreshold = newThreshold;
        changes.push(
          `失败率 ${_fmt2(failureRate)} 偏低，web 验证阈值上调至 ${_fmt2(webVerifyThreshold)}`,
        );
      }
    }

    let divergenceWidth = params.divergence_width;
    if (metrics.convergence_rounds.length > 0) {
      const avgRounds =
        metrics.convergence_rounds.reduce((sum, round) => sum + round, 0) /
        metrics.convergence_rounds.length;
      if (avgRounds >= CONVERGENCE_AVG_HIGH) {
        const newWidth = Math.min(divergenceWidth + 1, DIVERGENCE_WIDTH_MAX);
        if (newWidth !== divergenceWidth) {
          divergenceWidth = newWidth;
          changes.push(
            `平均收敛轮数 ${_fmt1(avgRounds)} 偏高，探索宽度加宽至 ${divergenceWidth}`,
          );
        }
      } else if (
        avgRounds <= CONVERGENCE_AVG_LOW &&
        divergenceWidth > DIVERGENCE_WIDTH_MIN
      ) {
        divergenceWidth -= 1;
        changes.push(
          `平均收敛轮数 ${_fmt1(avgRounds)} 偏低，探索宽度收窄至 ${divergenceWidth}`,
        );
      }
    }

    const newParams = new TunableParams({
      divergence_width: divergenceWidth,
      retry_budget: retryBudget,
      web_verify_threshold: webVerifyThreshold,
      weights,
      thresholds: { ...params.thresholds },
    });
    const snapshot =
      ruleVersion !== null
        ? new ParameterSnapshot({ rule_version: ruleVersion, params: newParams })
        : null;
    return new TuneResult({ params: newParams, changes, snapshot });
  }

  /**
   * 调参 + L2 效果评估回归（参数变更须过回归才生效）。
   *
   * 分工语义：参数无「旧版」可比（L1/L3 不适用），回归 = L2 样例闸门——
   * 新参数须让回归样例全绿才允许生效；回归未通过 = 变更被拒绝，返回原
   * 参数（changes 空 + note 说明原因 + rejected=True 显式拒绝语义，
   * 调用方留痕审计）。gate：闸门实例（null = 默认：参数回归执行器注入
   * 组合闸门）；regression：L2 历史回归用例（追加评估；null = 不追加）。
   */
  async tune_with_regression(
    params: TunableParams,
    metrics: TurnMetrics,
    fixtures: FixtureSet,
    options: TuneWithRegressionOptions = {},
  ): Promise<TuneResult> {
    const tuned = this.tune(params, metrics, {
      feedback: options.feedback ?? null,
      rule_version: options.rule_version ?? null,
    });
    if (tuned.changes.length === 0) {
      return tuned; // 无参数变化无需回归（不空转评估）
    }
    const gate =
      options.gate ?? new KnowledgeGate({ l2_executor: new ParamRegressionExecutor() });
    const l2 = await gate.check_l2(_params_entry(tuned.params), fixtures, {
      regression: options.regression ?? null,
    });
    if (l2.passed) {
      this._commit(tuned);
      return tuned;
    }
    return new TuneResult({
      params,
      note: `参数回归未通过，变更被拒绝: ${l2.note || '样例未全绿'}`,
      // 显式拒绝语义：调用方据 rejected 区分「无参数变化」与「有建议但
      // 被回归拒绝」——依赖 changes 判生效会把拒绝误判为无变化
      rejected: true,
    });
  }

  /**
   * 调参并回写知识集（运行时回合收尾接线；无回归样例时的持久化入口）。
   *
   * 与 tune_with_regression 的分工：参数回归（L2 效果评估）需注入回归
   * 样例库，运行时回合收尾常无样例上下文——本入口按确定性基线调参
   * （tune）后直接回写知识集（快照经注入的落库回调持久化），供下次调参
   * 读回基线；无参数变化 = no-op 不落库。
   */
  tune_persisted(
    params: TunableParams,
    metrics: TurnMetrics,
    options: TuneOptions = {},
  ): TuneResult {
    const result = this.tune(params, metrics, {
      feedback: options.feedback ?? null,
      rule_version: options.rule_version ?? null,
    });
    if (result.changes.length > 0) {
      this._commit(result);
    }
    return result;
  }

  /** 调参结果落地（快照落库回调 + 参数回写知识集；失败只忽略——core 无日志面）。 */
  private _commit(result: TuneResult): void {
    if (result.snapshot !== null && this.snapshot_sink !== null) {
      try {
        this.snapshot_sink(result.snapshot);
      } catch {
        // 快照落库失败是宿主副作用路径：不阻断调参主流程
      }
    }
    this._persist_params(result.params);
  }

  /** 调参结果回写知识集（与知识孵化闭环：下次调参从条目读回基线）。
   *
   * 条目 id 与种子权重条目一致（幂等注入不覆盖演化——调参产物落在同一
   * 位置，回退 = 补丁链回退到种子版本）。
   */
  private _persist_params(params: TunableParams): void {
    if (this.knowledge_set === null) {
      return;
    }
    try {
      const existing = this.knowledge_set.get(GENERAL_WEIGHTS_SEED_ID);
      if (existing === null) {
        this.knowledge_set.add(
          new KnowledgeEntry({
            id: GENERAL_WEIGHTS_SEED_ID,
            level: LEVEL_WORK,
            kind: KIND_WEIGHT,
            data: params.to_dict(),
            source: SOURCE_MODEL,
            credibility: 0.9,
            title: '默认权重与阈值',
            tags: ['weights', 'thresholds', 'tuning'],
          }),
        );
      } else {
        this.knowledge_set.update(GENERAL_WEIGHTS_SEED_ID, {
          data: params.to_dict(),
        });
      }
    } catch {
      // 参数条目回写失败是知识集侧路径异常：不阻断调参主流程
    }
  }

  /** 从知识集读回当前参数基线（权重/阈值条目；缺失 = 引擎默认）。
   *
   * 调参入口的前置取数：先读回上次调参/种子注入的条目，再以之为基线
   * 调整——与知识孵化的「演化 = 新补丁」同构。条目数据非法 = 回落默认
   * 基线（参数声明结构损坏时显式兜底，不静默产出 NaN 参数）。
   */
  static load_params(knowledge_set: KnowledgeSet): TunableParams {
    const entry = knowledge_set.get(GENERAL_WEIGHTS_SEED_ID);
    if (entry === null || !isRecord(entry.data)) {
      return new TunableParams();
    }
    try {
      return TunableParams.from_dict(entry.data);
    } catch (error) {
      if (error instanceof GraphDefinitionError) {
        return new TunableParams();
      }
      throw error;
    }
  }
}
