/**
 * 自适应调优公开面（tuning.py __all__ 镜像）。
 *
 * 自适应调优（Self-tuning，参数级进化：回合指标聚合 + 参数快照 + 调参
 * 器）。回合指标聚合纳入引擎自承载（meta 节点读执行统计自动调整探索
 * 宽度/重试预算/web 验证阈值）；知识集权重/阈值随卡回路反馈进化（与知识
 * 孵化闭环）。导出集合严格对齐 Python __all__：常量（权重上下限保护/失败
 * 率档位/机制参数边界）、回合指标（TurnMetrics）、参数形态与快照
 * （TunableParams/ParameterSnapshot/TuneResult）、参数回归执行器
 * （ParamRegressionExecutor）与调参器（MetaTuner）。
 */

export {
  CONVERGENCE_AVG_HIGH,
  CONVERGENCE_AVG_LOW,
  DIVERGENCE_WIDTH_MAX,
  DIVERGENCE_WIDTH_MIN,
  FAILURE_RATE_HIGH,
  FAILURE_RATE_LOW,
  MIN_WEIGHT,
  RETRY_BUDGET_FLOOR,
  WEB_THRESHOLD_MAX,
  WEB_THRESHOLD_MIN,
  WEB_THRESHOLD_STEP,
  WEIGHT_DECAY,
  WEIGHT_GAIN,
} from './_constants.js';

export { TurnMetrics } from './_turn_metrics.js';
export type { TurnMetricsInit } from './_turn_metrics.js';
export { TunableParams, ParameterSnapshot, TuneResult } from './_params.js';
export type {
  TunableParamsInit,
  ParameterSnapshotInit,
  TuneResultInit,
} from './_params.js';
export { ParamRegressionExecutor } from './_executor.js';
export { MetaTuner } from './meta_tuner.js';
export type {
  MetaTunerOptions,
  TuneOptions,
  TuneWithRegressionOptions,
} from './meta_tuner.js';
