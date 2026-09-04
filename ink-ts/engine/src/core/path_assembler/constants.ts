/**
 * 路径组装器默认参数与声明式常量（Python path_assembler.py 顶部常量段移植）。
 *
 * 引擎钉死默认值，使用方仅覆盖权；候选来源/统计口径/反馈理由码全部声明式
 * 枚举，防魔法字符串。本文件零依赖，供 path_assembler 各拆分文件共用。
 */

// ── 组装默认参数（引擎钉死；使用方仅覆盖权）──────────────────────
/** beam 宽度（组合爆炸四层压：类型契约/证据偏置/预算信封/池治理）。 */
export const DEFAULT_BEAM_WIDTH = 4;
/** 候选链最大深度。 */
export const DEFAULT_MAX_PATH_LENGTH = 10;
/** 候选条数（默认 1 主 + 1 探）。 */
export const DEFAULT_TOP_K = 2;
/** 草稿重试上限（首次 + 2 次重试 = 最多 3 次调用）。 */
export const LLM_RETRY_LIMIT = 2;
/** 草稿上下文窗口（域过滤后 top-N 契约摘要）。 */
export const DEFAULT_LLM_WINDOW = 30;
/** 自动修复最大轮数（防算子组合全枚举）。 */
export const MAX_REPAIR_ROUNDS = 4;
/** 默认上下文域（未注入域时的登记归属，与沉淀侧同一常数）。 */
export const DEFAULT_DOMAIN = 'default';
/** 默认放行档位（默认 0 最严；映射策略归使用方）。 */
export const DEFAULT_MAX_SAFETY_TIER = 0;
/** 缓存抽样重装概率（命中时以 ε 概率绕过缓存重新组装对比）。 */
export const DEFAULT_CACHE_EPSILON = 0.05;
/** 草稿链最大条数（超出 = 解析失败直接兜底；ENG9a-11）。 */
export const MAX_DRAFT_ITEMS = 20;
/** 草稿单条类型名最大长度（超出 = 非白名单形态；ENG9a-11）。 */
export const MAX_ITEM_CHARS = 200;

// ── 反馈结构化理由码（草稿重试反馈只回码 + 白名单类型名）──────────
export const FEEDBACK_UNKNOWN_NODE = 'unknown_node';
export const FEEDBACK_DUPLICATE_NODE = 'duplicate_node';
export const FEEDBACK_SAFETY_TIER = 'safety_tier';
export const FEEDBACK_PREFIX_REQUIREMENT = 'prefix_requirement';
export const FEEDBACK_GOAL_NOT_COVERED = 'goal_not_covered';
export const FEEDBACK_STATE_RULE = 'state_rule';
export const FEEDBACK_OTHER = 'other';

// ── canary 护栏默认值（ENG9a-6；executor 未迁移前为预留常数）──────
/** 单候选 canary 执行步数上限。 */
export const CANARY_MAX_STEPS = 16;
/** 单候选 canary 超时上限（秒）。 */
export const DEFAULT_CANARY_TIMEOUT = 30.0;
/** 草稿源单次调用超时（秒；草稿层护栏）。 */
export const DEFAULT_DRAFT_TIMEOUT = 30.0;

// ── 候选来源标记（声明式枚举）───────────────────────────────────
export const CANDIDATE_SOURCE_ALGORITHM = 'algorithm';
export const CANDIDATE_SOURCE_DRAFT = 'draft';
export const CANDIDATE_SOURCE_CACHE = 'cache';
/** 技能先例源（知识集 kind=path 条目注入的候选链）。 */
export const CANDIDATE_SOURCE_SKILL = 'skill';

// ── 统计口径键（声明式枚举）──────────────────────────────────────
export const STATS_BEAM_EXTENSIONS = 'beam_extensions';
export const STATS_EDGE_SCORE_CALLS = 'edge_score_calls';
export const STATS_REPAIR_ATTEMPTS = 'repair_attempts';
export const STATS_LLM_ATTEMPTS = 'llm_attempts';
export const STATS_CACHE_HITS = 'cache_hits';
export const STATS_CACHE_MISSES = 'cache_misses';
export const STATS_CACHE_INVALIDATIONS = 'cache_invalidations';
export const STATS_CACHE_REPLACEMENTS = 'cache_replacements';

// ── 干预落库集合（assemble 后的运行期干预；状态落库 + 审计）───────
/** 候选选择落库集合（按域记录当前选中候选；清空 = 恢复多候选观察态）。 */
export const PATH_CANDIDATE_COLLECTION = 'path_candidate_selection';
/** 多径开关落库集合（复用 PathAssemblyFlags 单块开关语义；按域持久化）。 */
export const PATH_FLAGS_COLLECTION = 'path_flags';
