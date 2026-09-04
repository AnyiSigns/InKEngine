/**
 * 知识集域公开 re-export（snake_case 镜像 Python knowledge_set.__all__）。
 *
 * 文件拆分纪律：常量/哨兵/seam 落 _types；条目结构/序列化/渲染落
 * knowledge_entry；内存链读写与生命周期落 knowledge_set_core；公开类
 * （闸门/可移植/持久化/检索）落 knowledge_set；组装注入（种子/上下文
 * 源）落 _sources。
 */

export {
  DEFAULT_SEARCH_LIMIT,
  KIND_INSIGHT,
  KIND_PATH,
  KIND_RULE,
  KIND_SCRIPT,
  KIND_TEMPLATE,
  KIND_TOOL_RULE,
  KIND_WEIGHT,
  LEVEL_PROJECT,
  LEVEL_USER,
  LEVEL_WORK,
  SEED_ID_PREFIX,
  SKILL_ID_PREFIX,
  SOURCE_DIALOG,
  SOURCE_MODEL,
  SOURCE_ORDER,
  SOURCE_USER,
  SOURCE_WEB,
} from './_types.js';

// 来源分级的默认可信度基准（私有但重导出——外部消费方沿用
// knowledge_set._SOURCE_CREDIBILITY 形态；缺省可信度经 default_credibility）
export { _SOURCE_CREDIBILITY } from './_types.js';

export type { KnowledgeStorage } from './_types.js';

export { default_credibility } from './_types.js';

export { KnowledgeEntry } from './knowledge_entry.js';
export type { KnowledgeEntryOptions } from './knowledge_entry.js';

export { knowledge_collection } from './knowledge_utils.js';

export { KnowledgeSet } from './knowledge_set.js';
export type { KnowledgeGateLike, KnowledgeGateResult, KnowledgeGateCheckOptions } from './_types.js';

export { DEFAULT_INJECTION_SCANNER, build_knowledge_sources, seed_knowledge_set } from './_sources.js';
export type { BuildKnowledgeSourcesOptions, InjectionScanner } from './_sources.js';

export { KnowledgeSetBase } from './knowledge_set_core.js';
export type { KnowledgeSetBaseOptions, InnerPath } from './knowledge_set_core.js';