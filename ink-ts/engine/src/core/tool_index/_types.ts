/**
 * 工具向量索引（search_tools 后端检索引擎）：共享数据类与常量的。
 *
 * 检索语义落引擎侧（零 IO core + seam 注入），与 Python ``tool_index.py``
 * 一致——search_tools 是引擎自指工具、检索域 = 引擎域，索引也在引擎；
 * 嵌入实现为 seam（``AsyncEmbedder`` 形态接口），core 仅消费抽象。
 */

import type { ToolSpec } from '../llm/tools.js';

/** 检索结果上限（search_tools 返回 ≤8 条）。 */
export const MAX_RESULTS = 8;

/** 嵌入文本中 name 的权重倍数（name 更关键，重复多次提升匹配精度）。 */
export const NAME_REPEAT = 3;

/** 端点未在 endpoints 字典登记时的默认端点类型。 */
export const DEFAULT_ENDPOINT = 'declarative';

/** 权限档（命名空间隔离默认 review；self/introspect 直过 allow）。 */
export type Tier = 'allow' | 'review';

/** 自指工具白名单（直过 allow，无需审批）。 */
export const SELF_TOOL_NAMES: ReadonlySet<string> = new Set([
  'propose_patch',
  'apply_patch',
  'revert_patch',
  'propose_domain_manifest',
  'search_tools',
  'request_tool',
]);

/** 索引条目（工具 + 嵌入向量 + 检索元数据）。 */
export interface ToolIndexEntry {
  spec: ToolSpec;
  vector: readonly number[] | null;
  endpoint: string;
  tier: Tier;
}

/** 单条检索结果（search_tools 返回的列表项）。 */
export interface SearchResult {
  name: string;
  description: string;
  parameters_summary: string;
  tier: Tier;
  endpoint: string;
  score: number;
}

/** 端点类型 → 工具名 映射（未登记走 DEFAULT_ENDPOINT）。 */
export type Endpoints = Readonly<Record<string, string>>;

/**
 * 引擎侧 AsyncEmbedder 抽象（由宿主实现）。
 *
 * 同步契约（seam 收窄）：``aembed_documents`` / ``aembed_query`` 一律
 * **同步直返**嵌入结果——本 seam 不接收 Promise。宿主接入真异步嵌入器时
 * 必须在注入前先把异步结果 await/收口成同步值（引擎侧检索/构建为同步
 * 路径，无法在调用面轮询 Promise；等价 Python 端 asyncio + 专用线程循环
 * 的收口位点）。嵌入失败由宿主抛错，core 捕获后降级关键词基线并上报
 * on_degraded（见 ToolVectorIndex，失败不静默）。
 *
 * 运行时若仍返回 thenable（宿主未收口）= seam 契约违规：core 按降级处理
 * 并携带明确降级原因（degraded 标记/回调可见），不静默吞成「恒空向量」。
 */
export interface AsyncEmbedder {
  /** 批量嵌入（同步直返：宿主须先 await 收口后再注入）。 */
  aembed_documents(texts: readonly string[]): readonly (readonly number[])[];
  /** 单条 query 嵌入（同步直返）。 */
  aembed_query(text: string): readonly number[];
}