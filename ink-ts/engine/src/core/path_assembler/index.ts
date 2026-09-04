/**
 * core/path_assembler 公开 re-export（snake_case 镜像 Python path_assembler
 * __all__，1:1 移植 ink_engine.core.path_assembler）。
 *
 * 路径组装器 = 只读（出候选计划供观察/审计，不接执行路径）：把「结点池
 * （注册表 + 契约）+ 边证据 + 目标 schema」装成 1..k 条候选路径，产物为图
 * 定义数据（可序列化、可重建、可走 canary）。本模块只组装不执行——观测出口
 * = 组装候选事件（event_types 注册表）+ 审计记录落库（宿主注入回调承接）。
 *
 * 文件拆分纪律（≤350 行/文件）：常量落 constants；数据形态/协议落 types；
 * 候选链校验落 validate；草稿解析落 draft_parse；schema 反推落 search；修复
 * 算子落 repair；内存检索兜底落 retrieval；组装私助落 snapshot；组装器按
 * 机制段拆成继承链 _assembler_cache（缓存/证据）→ _assembler_pipeline（草稿/
 * 评分/多径）→ assembler（assemble 编排）；canary 重建/单回合预留落 canary；
 * 指令运行期落 runtime；模块级默认运行期落 module_runtime；干预能力落
 * intervention。executor（core/executor.Engine）未迁移：canary 单回合执行按
 * defer 预留（见 canary.ts），canary 执行类测试随测试文件头注一并 defer。
 */

// ── 常数（镜像 __all__ 常量段）──────────────────────────────────
export {
  CANARY_MAX_STEPS,
  CANDIDATE_SOURCE_ALGORITHM,
  CANDIDATE_SOURCE_CACHE,
  CANDIDATE_SOURCE_DRAFT,
  CANDIDATE_SOURCE_SKILL,
  DEFAULT_BEAM_WIDTH,
  DEFAULT_CACHE_EPSILON,
  DEFAULT_CANARY_TIMEOUT,
  DEFAULT_DOMAIN,
  DEFAULT_DRAFT_TIMEOUT,
  DEFAULT_LLM_WINDOW,
  DEFAULT_MAX_PATH_LENGTH,
  DEFAULT_MAX_SAFETY_TIER,
  DEFAULT_TOP_K,
  FEEDBACK_DUPLICATE_NODE,
  FEEDBACK_GOAL_NOT_COVERED,
  FEEDBACK_OTHER,
  FEEDBACK_PREFIX_REQUIREMENT,
  FEEDBACK_SAFETY_TIER,
  FEEDBACK_STATE_RULE,
  FEEDBACK_UNKNOWN_NODE,
  LLM_RETRY_LIMIT,
  MAX_DRAFT_ITEMS,
  MAX_ITEM_CHARS,
  MAX_REPAIR_ROUNDS,
  STATS_BEAM_EXTENSIONS,
  STATS_CACHE_HITS,
  STATS_CACHE_INVALIDATIONS,
  STATS_CACHE_MISSES,
  STATS_CACHE_REPLACEMENTS,
  STATS_EDGE_SCORE_CALLS,
  STATS_LLM_ATTEMPTS,
  STATS_REPAIR_ATTEMPTS,
} from './constants.js';

// ── 数据形态 / 协议（镜像 __all__ 类段）─────────────────────────
export {
  AssemblyCandidate,
  AssemblyDraftContext,
  AssemblyEnvelope,
  AssemblyRequest,
  NodeSummary,
  PathAssemblyResult,
  PathAssemblyResult as AssemblyResult,
} from './types.js';
export { CanaryResult, CanaryVerdict } from './canary.js';
export { InMemoryPoolRetriever } from './retrieval.js';
export type { DraftProvider, EdgeIndexKey } from './types.js';
export type { CandidateStorage } from './intervention.js';

// ── 组装器 / 运行期 / 干预（镜像 __all__ 函数与类）───────────────
export { PathAssembler } from './assembler.js';
export { PathAssemblyRuntime } from './runtime.js';
export {
  get_default_assembly_runtime,
  set_default_assembly_runtime,
  assemble_plan,
} from './module_runtime.js';
export { assembly_audit_record } from './audit.js';
export { canary_active, canary_budget, canary_instantiate, canary_round } from './canary.js';
export {
  add_branch,
  remove_node,
  repair_chain,
  replace_node,
  reroute_edge,
} from './repair.js';
export { parse_draft_chain, sanitize_draft_feedback } from './draft_parse.js';
export { validate_chain } from './validate.js';
export { choose_candidate, clear_candidate_selection, set_multipath } from './intervention.js';
