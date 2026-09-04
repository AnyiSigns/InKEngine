/**
 * LLM 适配器注册机制单测（新厂商 = 注册新适配器类，配置驱动选择）。
 *
 * mirror python test_llm_registry.py 全量断言；适配器类零真实网络
 * （默认传输惰性构建，构造/查询阶段不触网）。
 */
import { describe, expect, it } from 'vitest';

import { AsyncLLM, LLMChunk, LLMConfig, LLMResult } from '../../../src/core/llm/base.js';
import { LLMConfigError } from '../../../src/core/llm/errors.js';
import { AnthropicLLM } from '../../../src/adapters/llm/anthropic.js';
import { OpenAIResponsesLLM } from '../../../src/adapters/llm/openai_response.js';
import { OpenAICompatibleLLM } from '../../../src/adapters/llm/openai_compat.js';
import {
  _LLM_REGISTRY,
  adapter_names,
  create_llm,
  get_adapter_class,
  register_adapter,
} from '../../../src/adapters/llm/registry.js';

/** 测试用最小适配器：注册面只关心类身份 + 配置透传。 */
class CustomLLM extends AsyncLLM {
  readonly adapter = 'custom';
  readonly created_with: LLMConfig;

  constructor(config: LLMConfig) {
    super(config);
    this.created_with = config;
  }

  async ainvoke(): Promise<LLMResult> {
    throw new Error('未实现');
  }

  async *astream(): AsyncGenerator<LLMChunk> {
    throw new Error('未实现');
  }
}

function make_stub(name: string): { cls: new (config: LLMConfig) => AsyncLLM } {
  class StubLLM extends AsyncLLM {
    readonly adapter = name;
    async ainvoke(): Promise<LLMResult> {
      throw new Error('未实现');
    }
    async *astream(): AsyncGenerator<LLMChunk> {
      throw new Error('未实现');
    }
  }
  return { cls: StubLLM };
}

describe('内置适配器注册表', () => {
  it('内置适配器齐备（协议全名 + 兼容别名 + 厂商别名）', () => {
    const names = adapter_names();
    // 协议全名（用户可辨别的常见 API 协议）
    expect(names).toContain('openai_compatible');
    expect(names).toContain('openai_responses');
    expect(names).toContain('anthropic_messages');
    // 兼容别名（旧配置零迁移）
    expect(names).toContain('openai_compat');
    expect(names).toContain('anthropic');
    // OpenAI 兼容厂商别名齐备（adapter 名直接可用）
    for (const alias of ['openai', 'deepseek', 'zhipu', 'moonshot', 'ollama']) {
      expect(names).toContain(alias);
    }
  });

  it('OpenAI 兼容别名共享同一适配器类', () => {
    const cls = get_adapter_class('openai_compat');
    expect(cls).toBe(OpenAICompatibleLLM);
    expect(get_adapter_class('openai_compatible')).toBe(OpenAICompatibleLLM);
    for (const alias of ['openai', 'deepseek', 'zhipu', 'moonshot', 'ollama']) {
      expect(get_adapter_class(alias)).toBe(cls);
    }
  });

  it('协议适配器按全名/兼容别名各自解析', () => {
    expect(get_adapter_class('anthropic_messages')).toBe(AnthropicLLM);
    expect(get_adapter_class('anthropic')).toBe(AnthropicLLM);
    expect(get_adapter_class('openai_responses')).toBe(OpenAIResponsesLLM);
    expect(get_adapter_class('openai_response')).toBe(OpenAIResponsesLLM);
  });

  it('未知适配器显式报错并附已注册清单', () => {
    let caught: unknown = null;
    try {
      create_llm({ adapter: 'unknown_vendor', model_id: 'm', base_url: 'http://x' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LLMConfigError);
    expect(String((caught as Error).message)).toContain('未注册的 LLM 适配器');
  });
});

describe('create_llm（配置驱动选择适配器）', () => {
  it('配置字典形态创建（deepseek 厂商别名 → OpenAI 兼容类）', () => {
    const llm = create_llm({
      adapter: 'deepseek',
      model_id: 'deepseek-chat',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'k',
      temperature: 0.3,
    });
    expect(llm).toBeInstanceOf(OpenAICompatibleLLM);
    expect(llm.config.model_id).toBe('deepseek-chat');
    expect(llm.config.temperature).toBe(0.3);
  });

  it('LLMConfig 形态创建并透传同一配置实例', () => {
    const cfg = new LLMConfig({ adapter: 'openai_compat', model_id: 'm', base_url: 'http://x' });
    const llm = create_llm(cfg);
    expect(llm).toBeInstanceOf(OpenAICompatibleLLM);
    expect(llm.config).toBe(cfg);
  });
});

describe('自定义适配器注册', () => {
  it('注册后按配置创建实例（同名可覆盖）', () => {
    try {
      register_adapter('custom', CustomLLM);
      expect(get_adapter_class('custom')).toBe(CustomLLM);
      const llm = create_llm({ adapter: 'custom', model_id: 'm', base_url: 'http://x' });
      expect(llm).toBeInstanceOf(CustomLLM);
      expect((llm as CustomLLM).created_with.model_id).toBe('m');
    } finally {
      // 清理：保持注册表与测试前一致（等价 python 的 pop）
      _LLM_REGISTRY.delete('custom');
    }
  });

  it('register_adapter 可覆盖同名内置适配器', () => {
    const { cls: V2LLM } = make_stub('openai_compat');
    register_adapter('openai_compat', V2LLM);
    try {
      expect(get_adapter_class('openai_compat')).toBe(V2LLM);
    } finally {
      register_adapter('openai_compat', OpenAICompatibleLLM);
    }
  });

  it('内置注册不覆盖宿主先注册的同名适配器（setdefault 语义）', () => {
    const { cls: MineLLM } = make_stub('openai');
    register_adapter('openai', MineLLM);
    try {
      expect(get_adapter_class('openai')).toBe(MineLLM);
    } finally {
      register_adapter('openai', OpenAICompatibleLLM);
    }
  });

  it('空注册名拒绝', () => {
    expect(() => register_adapter('', OpenAICompatibleLLM)).toThrow(LLMConfigError);
  });
});
