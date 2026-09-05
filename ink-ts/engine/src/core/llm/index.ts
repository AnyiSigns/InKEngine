/**
 * core/llm 公开导出面（mirror python core/llm/__init__.py 的 __all__ 纯本地名）。
 *
 * 本 barrel 只承载 core 本地纯契约模块——base（接口/数据形态）/ messages /
 * tools / errors / fallback / cache；适配器（OpenAICompatibleLLM/AnthropicLLM/
 * OpenAIResponsesLLM）与注册机制（registry.py：register_adapter/adapter_names/
 * get_adapter_class/create_llm）属 adapters 层，core 不反向依赖 adapters，一律
 * 从 `engine/src/adapters/llm/registry.js` 及其适配器模块导入。
 *
 * python __all__ 中尚未迁移到 TS 的为 embedding 面（create_embedder 等），
 * 待其落地后在本 barrel 对应位置补挂。
 */

// base：统一接口 + 配置/参数/增量数据形态 + 累积函数
export {
  AsyncLLM,
  LLMChunk,
  LLMConfig,
  LLMParams,
  LLMResult,
  collect_result,
} from './base.js';

// errors：异常体系 + 分类/瞬时判定（mirror __all__ 的 11 个 LLM* 异常名）
export {
  LLMAuthError,
  LLMBadRequestError,
  LLMConfigError,
  LLMEmptyStreamError,
  LLMError,
  LLMFormatError,
  LLMNetworkError,
  LLMNotFoundError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
  LLMUnknownError,
  classify_llm_error,
  is_transient_llm_error,
} from './errors.js';

// messages：消息 + 角色工厂 + 工具调用增量累积（ToolCall/ToolCallDelta 经
// messages 中转导出，与 python 侧从 messages/base 取同名符号对齐）
export {
  Message,
  ToolCall,
  ToolCallDelta,
  accumulate_tool_calls,
  assistant,
  system,
  tool_result,
  user,
} from './messages.js';

// tools：工具 schema 声明 + OpenAI function 形态转换
export { ToolSpec, to_openai_tools } from './tools.js';

// fallback：模型链（主配置 + 备用切换 + 指数退避重试/流式中断，mirror __all__）
export { ModelChain, RetryPolicy } from './fallback.js';

// cache：LLM 调用缓存包装器（Storage records 通道持久化，mirror __all__）
export { CACHE_COLLECTION, DEFAULT_CACHE_TTL, CachingLLM } from './cache.js';
