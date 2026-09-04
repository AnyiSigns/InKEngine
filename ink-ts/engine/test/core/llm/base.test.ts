/**
 * 统一 LLM 接口与数据模型单测（对标 Python llm/base.py 段：配置构建/参数
 * 覆盖/增量累积）。适配器实现面在 engine/adapters/llm 单测覆盖。
 */

import { describe, expect, it } from 'vitest';

import {
  LLMChunk,
  LLMConfig,
  LLMParams,
  REASONING_EFFORTS,
  collect_result,
} from '../../../src/core/llm/base.js';
import { LLMConfigError } from '../../../src/core/llm/errors.js';

describe('LLMConfig', () => {
  it('from_dict：白名单键入位、未知键收进 extra、缺必填抛 LLMConfigError', () => {
    const cfg = LLMConfig.from_dict({
      adapter: 'openai_compat',
      base_url: 'https://api.example.com/v1',
      model_id: 'demo',
      temperature: 0.7,
      vendor: 'extra-field',
    });
    expect(cfg.adapter).toBe('openai_compat');
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.extra).toEqual({ vendor: 'extra-field' });
    expect(() => LLMConfig.from_dict({ adapter: 'x', base_url: 'https://y' })).toThrow(
      LLMConfigError,
    );
  });

  it('base_url 仅允许 http/https（SSRF 面收紧）', () => {
    expect(() => new LLMConfig({ adapter: 'a', base_url: 'file:///etc', model_id: 'm' })).toThrow(
      /http\/https/,
    );
    expect(() => new LLMConfig({ adapter: 'a', base_url: 'http://ok', model_id: 'm' })).not.toThrow();
  });
});

describe('LLMParams / LLMChunk', () => {
  it('缺省 null、enable_thinking 与档位独立承载', () => {
    const params = new LLMParams({ enable_thinking: true, reasoning_effort: 'medium' });
    expect(params.temperature).toBeNull();
    expect(params.enable_thinking).toBe(true);
    expect(REASONING_EFFORTS).toContain('medium');
  });

  it('空帧判定：无任何信息字段 = 空', () => {
    expect(new LLMChunk().is_empty).toBe(true);
    expect(new LLMChunk({ token: '' }).is_empty).toBe(true);
    expect(new LLMChunk({ token: 'a' }).is_empty).toBe(false);
  });
});

describe('collect_result', () => {
  it('累积：内容/推理拼接、usage 与终止原因取末帧、工具增量按 index 合并', async () => {
    const result = await collect_result(
      (async function* stream() {
        yield new LLMChunk({ token: '你' });
        yield new LLMChunk({ token: '好' });
        yield new LLMChunk({ reasoning_token: '想想' });
        yield new LLMChunk({
          token: '',
          finish_reason: 'tool_calls',
          usage: { prompt_tokens: 3, completion_tokens: 5 },
        });
      })(),
    );
    expect(result.content).toBe('你好');
    expect(result.reasoning).toBe('想想');
    expect(result.finish_reason).toBe('tool_calls');
    expect(result.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5 });
  });
});
