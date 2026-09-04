/**
 * 多径执行与汇流裁决常数段（multipath.py 模块级常数移植，1:1）。
 *
 * 机制职责（与组装器分工）：组装器出候选（1..k 条图定义数据），本模块把
 * 这些候选**执行**并裁决——输入 = 候选集 + 组装请求 + 预算信封；默认
 * k=2（1 主 + 1 探），k=3 仅高风险任务（max_safety_tier ≥ 1）放行。
 *
 * 本文件只承载常数与裁决排序键（tier_rank）：多径预算/触发/汇流裁决/
 * 运行器的机制分文件见 config.ts / evidence.ts / verdict.ts / runner.ts。
 * 多径嵌套深度为运行期护栏（ContextVar 语义在 TS 侧以模块变量 + 显式
 * 注入形表达，见 _runner_base.ts）。
 */

import {
  TIER_OBSERVING,
  TIER_PROMOTED,
  TIER_REGULAR,
} from '../edge_evidence/index.js';

// ── 多径执行默认参数（引擎钉死；使用方仅覆盖权）────────────────────
export const DEFAULT_MULTIPATH_K = 2; // 默认 k（1 主 + 1 探）
export const MAX_MULTIPATH_K = 3; // k 上界（k=3 仅高风险任务）
export const HIGH_RISK_SAFETY_TIER = 1; // 高风险判定线：max_safety_tier ≥ 1 才放行 k=3
export const DEFAULT_SHARED_RHO = 0.3; // 共享折扣默认值（共同前缀命中 = 边际成本趋低）
export const RHO_MIN = 0.2; // 共享折扣下界（前缀命中理想情形）
export const RHO_MAX = 1.0; // 共享折扣上界（无缓存 = 全边际成本）
export const DEFAULT_MULTIPATH_CONCURRENCY = 2; // 支流并发上限（fan_out 限流）

// 多径嵌套上限（多径嵌套护栏）：多径支流内再触发多径 = 成本爆炸高发点
// （支流 × 支流），嵌套深度 ≥ 该上限直接降级单径 + 审计注明（fail-closed
// 语义与 spawn 嵌套护栏同族——宁可降级不可静默放行）。
export const MAX_MULTIPATH_NESTING = 1;

// ── 汇流裁决模式（声明式枚举，防魔法字符串）────────────────────────
export const MODE_QUALITY_GATE = 'quality_gate';
export const MODE_TIER = 'tier';
export const MODE_COST = 'cost';
export const MODE_SYNTHETIC = 'synthetic';
export const MODE_NONE = 'none';

// ── 证据更新种类（与沉淀侧同一套枚举语义）──────────────────────────
export const UPDATE_SUCCESS = 'success';
export const UPDATE_FAIL = 'fail';

// ── Junction 节点类型（注册表内建类型名；开关关闭时不注册）─────────
export const JUNCTION_TYPE = 'junction';

// 多径展开保留键（组装编排节点 → 执行入口的状态通道保留键；与
// __spawn__/__plan__/__simulate__ 同语义：弹出后不落状态/checkpoint）
export const MULTIPATH_KEY = '__multipath__';

// Junction 节点与执行体的状态通道保留键（数据形态：可序列化落库）
export const JUNCTION_BRANCHES_STATE_KEY = 'multipath.branches';
export const JUNCTION_VERDICT_STATE_KEY = 'multipath.verdict';

// 默认上下文域（与组装/沉淀侧同一常数）
export const DEFAULT_DOMAIN = 'default';

// 信任档序（裁决档位序：观察 < 常规 < 转正；与评分公式 τ 档同阶）
const _TIER_RANK: Record<string, number> = {
  [TIER_OBSERVING]: 0,
  [TIER_REGULAR]: 1,
  [TIER_PROMOTED]: 2,
};

/** 信任档序（裁决排序键：越高越优）。 */
export function tier_rank(tier: string): number {
  return _TIER_RANK[tier] ?? 0;
}
