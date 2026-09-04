/**
 * Anthropic 非流式请求负载契约单测（test_llm_adapters.py TestAnthropic
 * ToolPassthrough/CacheParam/ErrorClassification/ReasoningEffort 移植）：
 * tools→input_schema、system 抽离、cache_control、HTTP 状态码错误分类、
 * extended thinking 档位映射。fake 传输注入，零真实网络。
 */

import { describe, expect, it } from 'vitest';

import { LLMParams } from '../../../src/core/llm/base.js';
import {
  LLMAuthError,
  LLMBadRequestError,
  LLMNotFoundError,
  LLMRateLimitError,
  LLMServerError,
} from '../../../src/core/llm/errors.js';
import { assistant, system, tool_result, user } from '../../../src/core/llm/messages.js';
import { ToolCall } from '../../../src/core/llm/_shapes.js';

import { WEATHER_TOOL, body_of, error_json, make_anthropic, ok_json } from './anthropic_helpers.js';

const OK_BODY = { content: [{ type: 'text', text: 'ok' }] };

describe('Anthropic 工具 schema passthrough', () => {
  it('tools 转为 input_schema 原生形态（无 OpenAI function 包裹）', async () => {
    const { llm, seen } = make_anthropic(() => ok_json(OK_BODY));
    await llm.ainvoke([user('hi')], { tools: [WEATHER_TOOL] });
    const body = body_of(seen);
    const tools = body['tools'] as Record<string, unknown>[];
    expect(tools[0]?.['name']).toBe('get_weather');
    const schema = (tools[0]?.['input_schema'] as Record<string, Record<string, { type: string }>>).properties;
    expect(schema?.['city']?.['type']).toBe('string');
    expect('function' in (tools[0] as object)).toBe(false);
  });

  it('system 抽离为顶层字段，messages 无 system 角色', async () => {
    const { llm, seen } = make_anthropic(() => ok_json(OK_BODY));
    await llm.ainvoke([system('sys'), user('hi')]);
    const body = body_of(seen);
    expect(body['system']).toBe('sys');
    const messages = body['messages'] as { role: string }[];
    expect(messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('工具调用历史转 tool_use 块、tool 角色转 tool_result 块', async () => {
    const { llm, seen } = make_anthropic(() => ok_json(OK_BODY));
    await llm.ainvoke([
      assistant('', {
        tool_calls: [new ToolCall({ id: 'toolu_1', name: 'get_weather', arguments: '{"city":"北京"}' })],
      }),
      tool_result('{"temp":26}', 'toolu_1'),
    ]);
    const messages = body_of(seen)['messages'] as {
      role: string;
      content: Record<string, unknown>[];
    }[];
    expect(messages[0]?.content[0]?.['type']).toBe('tool_use');
    expect(messages[0]?.content[0]?.['name']).toBe('get_weather');
    expect(messages[0]?.content[0]?.['input']).toEqual({ city: '北京' });
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content[0]?.['type']).toBe('tool_result');
    expect(messages[1]?.content[0]?.['tool_use_id']).toBe('toolu_1');
  });
});

describe('Anthropic 厂商缓存参数', () => {
  it('extra.cache_control 为真时给 system 挂 ephemeral 缓存断点', async () => {
    const { llm, seen } = make_anthropic(
      () => ok_json(OK_BODY),
      { extra: { cache_control: true } },
    );
    await llm.ainvoke([system('sys'), user('hi')]);
    const systemField = body_of(seen)['system'];
    expect(Array.isArray(systemField)).toBe(true);
    expect((systemField as { cache_control: unknown }[])[0]?.['cache_control']).toEqual({
      type: 'ephemeral',
    });
  });

  it('缺省 system 为纯字符串（不挂缓存）', async () => {
    const { llm, seen } = make_anthropic(() => ok_json(OK_BODY));
    await llm.ainvoke([system('sys'), user('hi')]);
    expect(body_of(seen)['system']).toBe('sys');
  });
});

describe('Anthropic 错误分类（HTTP 状态码）', () => {
  it.each([
    [401, LLMAuthError],
    [403, LLMAuthError],
    [429, LLMRateLimitError],
    [500, LLMServerError],
    [503, LLMServerError],
    [400, LLMBadRequestError],
    [404, LLMNotFoundError],
  ] as const)('状态码 %s → %s', async (status, cls) => {
    const { llm } = make_anthropic(() =>
      error_json(status, { type: 'error', error: { type: 'x', message: '上游错误' } }),
    );
    await expect(llm.ainvoke([user('hi')])).rejects.toBeInstanceOf(cls);
  });
});

describe('Anthropic extended thinking 档位', () => {
  it('medium → thinking.budget_tokens=8192、temperature 不设、max_tokens 自动抬升', async () => {
    const { llm, seen } = make_anthropic(() => ok_json(OK_BODY));
    await llm.ainvoke([user('hi')], { params: new LLMParams({ reasoning_effort: 'medium' }) });
    const body = body_of(seen);
    expect(body['thinking']).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect('temperature' in body).toBe(false);
    // 默认 max_tokens=1024 < budget，自动抬升到 budget+1024
    expect((body['max_tokens'] as number) > 8192).toBe(true);
  });

  it('off → 不携带 thinking、保留配置 temperature', async () => {
    const { llm, seen } = make_anthropic(() => ok_json(OK_BODY), { temperature: 0.3 });
    await llm.ainvoke([user('hi')], { params: new LLMParams({ reasoning_effort: 'off' }) });
    const body = body_of(seen);
    expect('thinking' in body).toBe(false);
    expect(body['temperature']).toBe(0.3);
  });
});
