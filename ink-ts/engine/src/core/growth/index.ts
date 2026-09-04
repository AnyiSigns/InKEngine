/**
 * growth 模块公开面（镜像 Python growth.__all__）。
 *
 * 公开形态：GrowthConfig（自学习管线配置，出厂默认开启）+ GrowthPipeline
 * （自学习闭环：回合事件 → 信号缓冲 → 按需蒸馏 → 三层闸门 → 知识集）+ 孵化
 * 产物形态（_INSIGHT_SCHEMA/_EMPTY_FIXTURES）+ 成长指标时序常量
 * （METRICS_COLLECTION/METRICS_KEY/METRICS_CAP）。
 *
 * 额外导出 TS seam 类型（GrowthPipelineOptions/GrowthEmit/MetricStore）——
 * Python 侧为鸭子类型无形态，TS 需显式接口供宿主注入实现。
 */

export { _EMPTY_FIXTURES, _INSIGHT_SCHEMA } from './_constants.js';
export { METRICS_CAP, METRICS_COLLECTION, METRICS_KEY } from './_constants.js';
export { GrowthConfig } from './config.js';
export type { GrowthConfigOptions } from './config.js';
export type { GrowthEmit } from './_emit.js';
export type { MetricStore } from './_metrics.js';
export { GrowthPipeline } from './growth.js';
export type { GrowthPipelineOptions } from './growth.js';
