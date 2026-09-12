/**
 * 检索原语公开 re-export（snake_case 镜像 Python retrieval.__all__）。
 *
 * 文件拆分纪律：常量/数据形态/seam 落 _types；注册表落 retriever_registry；
 * 知识集适配落 knowledge_set_retriever。
 */

export {
  DEFAULT_LIMIT,
  DEFAULT_MAX_RETRIEVERS,
  INJECTION_EXCLUDED_KINDS,
  MAX_LIMIT,
  SOURCE_DIALOG,
  SOURCE_MODEL,
  SOURCE_USER,
  SOURCE_WEB,
} from './_types.js';

export { DEFAULT_INJECTION_SCANNER, RetrievedChunk } from './_types.js';
export type {
  InjectionScanner,
  Retriever,
  RetrievedChunkOptions,
} from './_types.js';

// 来源分级的默认可信度基准（私有但重导出——知识集/记忆消费方沿用
// retrieval._SOURCE_CREDIBILITY 形态）
export { _SOURCE_CREDIBILITY } from './_types.js';

export { RetrieverRegistry } from './retriever_registry.js';
export type { RetrieverRegistryOptions } from './retriever_registry.js';

export { KnowledgeSetRetriever } from './knowledge_set_retriever.js';