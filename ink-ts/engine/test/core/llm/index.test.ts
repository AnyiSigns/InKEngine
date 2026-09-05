/**
 * core/llm barrel 导出面测试：只暴露 core 本地纯契约名（base/messages/tools/
 * errors/fallback/cache），不反向导出 adapters 层（注册机制/适配器类/工厂）。
 *
 * mirror python core/llm/__init__.py 的 __all__ 纯本地子集。
 */
import { describe, expect, it } from 'vitest';

import * as llm from '../../../src/core/llm/index.js';
import { LLMConfig, Message } from '../../../src/core/llm/index.js';

describe('core/llm 公开导出面', () => {
  it('base 面：AsyncLLM 接口 + 配置/参数/增量数据形态 + collect_result', () => {
    for (const name of ['AsyncLLM', 'LLMConfig', 'LLMParams', 'LLMChunk', 'LLMResult']) {
      expect(name in llm, `缺 base 导出 ${name}`).toBe(true);
    }
    expect(typeof llm.collect_result).toBe('function');
  });

  it('errors 面：全 LLM* 异常 + classify_llm_error + is_transient_llm_error', () => {
    const error_names = [
      'LLMError',
      'LLMAuthError',
      'LLMBadRequestError',
      'LLMConfigError',
      'LLMEmptyStreamError',
      'LLMFormatError',
      'LLMNetworkError',
      'LLMNotFoundError',
      'LLMRateLimitError',
      'LLMServerError',
      'LLMTimeoutError',
      'LLMUnknownError',
    ];
    for (const name of error_names) {
      expect(name in llm, `缺 errors 导出 ${name}`).toBe(true);
    }
    expect(typeof llm.classify_llm_error).toBe('function');
    expect(typeof llm.is_transient_llm_error).toBe('function');
  });

  it('messages 面：Message + 角色工厂 + 工具调用累积', () => {
    for (const name of [
      'Message',
      'ToolCall',
      'ToolCallDelta',
      'accumulate_tool_calls',
      'assistant',
      'system',
      'tool_result',
      'user',
    ]) {
      expect(name in llm, `缺 messages 导出 ${name}`).toBe(true);
    }
  });

  it('tools 面：ToolSpec + to_openai_tools', () => {
    for (const name of ['ToolSpec', 'to_openai_tools']) {
      expect(name in llm, `缺 tools 导出 ${name}`).toBe(true);
    }
  });

  it('fallback 面：ModelChain + RetryPolicy（链级重试/备用模型链）', () => {
    for (const name of ['ModelChain', 'RetryPolicy']) {
      expect(name in llm, `缺 fallback 导出 ${name}`).toBe(true);
    }
  });

  it('cache 面：CachingLLM + CACHE_COLLECTION + DEFAULT_CACHE_TTL', () => {
    for (const name of ['CachingLLM', 'CACHE_COLLECTION', 'DEFAULT_CACHE_TTL']) {
      expect(name in llm, `缺 cache 导出 ${name}`).toBe(true);
    }
    expect(typeof llm.CachingLLM).toBe('function');
    expect(llm.CACHE_COLLECTION).toBe('llm_cache');
    expect(llm.DEFAULT_CACHE_TTL).toBe(24 * 3600.0);
  });

  it('适配器层不得从 core barrel 反导出（核心不反向依赖 adapters）', () => {
    const adapters_face = [
      'create_llm',
      'adapter_names',
      'get_adapter_class',
      'register_adapter',
      'OpenAICompatibleLLM',
      'AnthropicLLM',
      'OpenAIResponsesLLM',
      'create_embedder',
    ];
    for (const name of adapters_face) {
      expect(name in llm, `core barrel 不应导出适配器名 ${name}`).toBe(false);
    }
  });

  it('导出的符号可正常构造/调用（冒烟）', () => {
    const cfg = llm.LLMConfig.from_dict({
      adapter: 'openai_compat',
      model_id: 'm',
      base_url: 'http://x',
    });
    expect(cfg).toBeInstanceOf(LLMConfig);
    expect(cfg.adapter).toBe('openai_compat');
    expect(llm.system('hi')).toBeInstanceOf(Message);
    expect(llm.user('hi').role).toBe('user');
  });
});
