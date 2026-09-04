/**
 * 沉淀钩子（回合收尾的注册式证据采集扩展，只记录不裁决）——常量层。
 *
 * 对标 ink_engine.core.settle 的模块级常量。常数同源纪律：推荐先验晋升
 * 阈值直接引用 edge_evidence 的信任档转正常数（同一组值，不另定），
 * 其余提案/复审/分类阈值在本层定稿。
 */

import { TIER_PROMOTE_N, TIER_PROMOTE_P } from '../edge_evidence/_types.js';

// ── 结点级成败留痕三态（执行器轨迹）──

export const TRACE_SUCCESS = 'success';
export const TRACE_FAILED = 'failed';
export const TRACE_SKIPPED = 'skipped';

// ── 失败点提案阈值（偶发失败不污染评审队列）──

export const PROPOSAL_MIN_FAILS = 3;
export const PROPOSAL_FAIL_RATE = 0.4;
/** 入边失败率判定所需最小样本（单样本不判率——偶发失败不误伤）。 */
export const PROPOSAL_RATE_MIN_N = 2;

// ── 失败归因分类（error 事件 message 分类器）──
// 归到能力缺口类才走「新结点提案」通道；环境/配置类失败（权限/校验/
// 网络）不污染评审队列。model / unknown 视为能力缺口类。

export const FAIL_CAT_PERMISSION = 'permission';
export const FAIL_CAT_VALIDATION = 'validation';
export const FAIL_CAT_NETWORK = 'network';
export const FAIL_CAT_MODEL = 'model';
export const FAIL_CAT_UNKNOWN = 'unknown';

/** 能力缺口类集合（才触发结点提案）：模型能力本身不足 / 未归类未知。 */
export const CAPABILITY_GAP_CATEGORIES: ReadonlySet<string> = new Set([
  FAIL_CAT_MODEL,
  FAIL_CAT_UNKNOWN,
]);

// ── 归因更新种类（声明式枚举）──

export const UPDATE_SUCCESS = 'success';
export const UPDATE_FAIL = 'fail';

// ── 默认上下文域（未注入域时的登记归属）──

export const DEFAULT_DOMAIN = 'default';

// ── 推荐先验自动晋升（评审文档第十三节第七条：高强度证据路径自动晋升为
// 「推荐先验」，晋升不需人工拍板——与信任档推导式同一组常数，见 edge_evidence）──

export const PROMOTION_MIN_N = TIER_PROMOTE_N; // 30
export const PROMOTION_MIN_P = TIER_PROMOTE_P; // 0.9

// ── 策略边对抗复审（评审文档第十三节坑六：刚性堤坝冻死系统——对抗证据可
// 触发复审，复审前该边降级为普通统计边）──

export const POLICY_REVIEW_FAIL_THRESHOLD = 5; // 失败累计超阈值（默认 5 次）
/** 域证据均值反超判定所需非策略边最小样本（样本不足只按失败累计判定）。 */
export const POLICY_REVIEW_DOMAIN_MIN_EDGES = 2;
