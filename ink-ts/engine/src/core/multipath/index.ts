/**
 * core/multipath 公开 re-export（snake_case 镜像 Python multipath.py __all__，
 * 1:1 移植 ink_engine.core.multipath）。
 *
 * 多径执行 + 汇流裁决（候选路径并行执行 → Junction 收口 → 证据回写）：
 * 组装器出候选（1..k 条图定义数据），本模块把这些候选执行并裁决——输入
 * = 候选集 + 组装请求 + 预算信封；默认 k=2（1 主 + 1 探），k=3 仅高风险
 * 任务放行。机制开关默认全关（MultiPathConfig.enabled=False 时全部入口零
 * 生效）。零 IO：证据/审计只产出不落库，落库经使用方存储与 sink 回调。
 *
 * 文件拆分纪律（≤350 行/文件）：常数与档序落 constants；装配配置与预算
 * 预检落 config；候选链证据口径落 evidence；汇流数据形态落 junction_types；
 * 裁决核心落 verdict；归因/审计落 updates；Junction 节点类型落
 * junction_node；收口结果落 results；运行器按段拆成 _runner_base（接缝/
 * 审计/支流执行——经父引擎结构面 MultipathEngineLike 真接线 executor
 * Engine）→ runner（run 编排）。
 */

// ── 常数（镜像 __all__ 常量段）──────────────────────────────────
export {
  DEFAULT_DOMAIN,
  DEFAULT_MULTIPATH_CONCURRENCY,
  DEFAULT_MULTIPATH_K,
  DEFAULT_SHARED_RHO,
  HIGH_RISK_SAFETY_TIER,
  JUNCTION_BRANCHES_STATE_KEY,
  JUNCTION_TYPE,
  JUNCTION_VERDICT_STATE_KEY,
  MAX_MULTIPATH_K,
  MODE_COST,
  MODE_NONE,
  MODE_QUALITY_GATE,
  MODE_SYNTHETIC,
  MODE_TIER,
  MULTIPATH_KEY,
  RHO_MAX,
  RHO_MIN,
  UPDATE_FAIL,
  UPDATE_SUCCESS,
  tier_rank,
} from './constants.js';

// ── 配置 / 数据形态 / 协议（镜像 __all__ 类与函数段）──────────────
export { MultiPathConfig, multipath_config_from_flags } from './config.js';
export { multipath_budget_required, check_multipath_budget } from './config.js';
export {
  ChainEvidence,
  EdgeRef,
  chain_edge_refs,
  chain_terminal_fields,
  chain_evidence,
  evidence_index_of,
} from './evidence.js';
export type { EvidenceIndex } from './evidence.js';
export {
  JunctionBranch,
  JunctionSynthContext,
  JunctionVerdict,
} from './junction_types.js';
export type { JunctionSynthProvider } from './verdict.js';
export { branches_are_homogeneous, junction_verdict } from './verdict.js';
export {
  JunctionEvidenceUpdate,
  apply_junction_updates,
  junction_audit_record,
  plan_junction_updates,
} from './updates.js';
export { JunctionExecutor, register_junction_node } from './junction_node.js';
export {
  BudgetView,
  MultiPathBranchResult,
  MultiPathResult,
} from './results.js';

// ── 运行器（run 编排 + 子链归属）───────────────────────────────
export { MultipathRunner } from './runner.js';
export {
  multipath_branch_path,
  multipath_branch_thread,
} from './_runner_base.js';
export type { MultipathEngineLike } from './_runner_base.js';
