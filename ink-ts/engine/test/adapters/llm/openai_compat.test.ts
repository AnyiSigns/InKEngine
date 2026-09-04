/**
 * OpenAI 兼容适配器单测：请求负载构造 + 非流式 ainvoke（Python
 * test_llm_openai_compat.py TestRequestPayload / TestAinvoke 移植，零真实网络）。
 */
import { describe, expect, it } from 'vitest';

import { LLMParams } from '../../../src/core/llm/base.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';
import { system, user } from '../../../src/core/llm/messages.js';
import {
  LLMAuthError,
  LLMBadRequestError,
  LLMFormatError,
  LLMNotFoundError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from '../../../src/core/llm/errors.js';
import { TimeoutError } from '../../../src/adapters/llm/transport.js';
import {
  body_of,
  capture,
  error_json,
  make_adapter,
  ok_json,
  sse_delta,
  sse_frame,
  stream_response,
  text_response,
} from './compat_helpers.js';

const OK_HANDLER = () => ok_json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });

// ---------------------------------------------------------------------------
// 请求负载构造
// ---------------------------------------------------------------------------
describe('请求负载构造', () => {
  it('ainvoke 载荷形态：端点/认证头/model/stream/messages', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER);
    await llm.ainvoke([system('sys'), user('hi')]);
    expect(new URL(seen.request!.url).pathname).toBe('/v1/chat/completions');
    expect(seen.request!.headers['authorization']).toBe('Bearer sk-test');
    const body = body_of(seen);
    expect(body['model']).toBe('test-model');
    expect(body['stream']).toBe(false);
    expect(body['messages']).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('base_url 尾斜杠归一', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER);
    await llm.ainvoke([user('hi')]);
    expect(new URL(seen.request!.url).pathname).toBe('/v1/chat/completions');
  });

  it('tools 转换为 OpenAI function 形态', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER);
    const tools = [
      new ToolSpec({
        name: 'get_weather',
        description: '查询天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }),
    ];
    await llm.ainvoke([user('hi')], { tools });
    const body = body_of(seen);
    const bodyTools = body['tools'] as Array<Record<string, unknown>>;
    expect(bodyTools[0]!['type']).toBe('function');
    const fn = bodyTools[0]!['function'] as Record<string, unknown>;
    expect(fn['name']).toBe('get_weather');
    const params = fn['parameters'] as Record<string, unknown>;
    expect(params['properties']).toHaveProperty('city');
  });

  it('调用级参数覆盖配置默认', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER, { temperature: 0.7, max_tokens: 100 });
    await llm.ainvoke([user('hi')], { params: new LLMParams({ temperature: 0.2 }) });
    const body = body_of(seen);
    expect(body['temperature']).toBe(0.2); // 调用级覆盖配置
    expect(body['max_tokens']).toBe(100); // 配置默认
    await llm.ainvoke([user('hi')]);
    expect(body_of(seen)['temperature']).toBe(0.7);
  });

  it('extra_body 透传厂商扩展键', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER);
    await llm.ainvoke([user('hi')], { params: new LLMParams({ extra_body: { enable_thinking: true } }) });
    expect(body_of(seen)['enable_thinking']).toBe(true);
  });

  it('P1：extra_body 不得覆盖核心字段（替换对话/强制关流）', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER);
    await llm.ainvoke([user('hi')], {
      params: new LLMParams({
        temperature: 0.2,
        extra_body: {
          messages: [{ role: 'user', content: '注入' }],
          model: 'other-model',
          stream: false,
          temperature: 9.9,
        },
      }),
    });
    const body = body_of(seen);
    expect(body['model']).toBe('test-model');
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body['stream']).toBe(false);
    expect(body['temperature']).toBe(0.2);
  });

  it('astream 请求带 stream=true', async () => {
    const { llm, seen } = make_adapter(() =>
      stream_response([sse_frame(sse_delta({ content: 'x' })), 'data: [DONE]\n\n']),
    );
    for await (const _ of llm.astream([user('hi')])) {
      // 只消费不累积（payload 断言在请求侧）
    }
    expect(body_of(seen)['stream']).toBe(true);
  });

  it('无 api_key 不带认证头', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER, { api_key: null });
    await llm.ainvoke([user('hi')]);
    expect(seen.request!.headers['authorization']).toBeUndefined();
  });

  it('effort 样式（默认）：high → reasoning_effort；off → 不携带', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER);
    await llm.ainvoke([user('hi')], { params: new LLMParams({ reasoning_effort: 'high' }) });
    expect(body_of(seen)['reasoning_effort']).toBe('high');
    await llm.ainvoke([user('hi')], { params: new LLMParams({ reasoning_effort: 'off' }) });
    expect(body_of(seen)['reasoning_effort']).toBeUndefined();
  });

  it('boolean 样式（通义 qwen3）：开 = enable_thinking true；关 = false', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER, { extra: { reasoning_style: 'boolean' } });
    await llm.ainvoke([user('hi')], { params: new LLMParams({ reasoning_effort: 'medium' }) });
    expect(body_of(seen)['enable_thinking']).toBe(true);
    await llm.ainvoke([user('hi')], { params: new LLMParams({ reasoning_effort: 'off' }) });
    expect(body_of(seen)['enable_thinking']).toBe(false);
  });

  it('none 样式（deepseek reasoner）：档位不注入任何参数', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER, { extra: { reasoning_style: 'none' } });
    await llm.ainvoke([user('hi')], { params: new LLMParams({ reasoning_effort: 'high' }) });
    const body = body_of(seen);
    expect(body['reasoning_effort']).toBeUndefined();
    expect(body['enable_thinking']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 非流式 ainvoke
// ---------------------------------------------------------------------------
describe('ainvoke', () => {
  it('成功：内容 + usage', async () => {
    const { llm } = make_adapter(() =>
      ok_json({
        choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    );
    const result = await llm.ainvoke([user('hi')]);
    expect(result.content).toBe('你好');
    expect(result.finish_reason).toBe('stop');
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3 });
  });

  it('成功：工具调用 + parsed_arguments', async () => {
    const { llm } = make_adapter(() =>
      ok_json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city": "北京"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const result = await llm.ainvoke([user('hi')]);
    expect(result.content).toBe('');
    expect(result.finish_reason).toBe('tool_calls');
    expect(result.tool_calls).not.toBeNull();
    expect(result.tool_calls![0]!.name).toBe('get_weather');
    expect(result.tool_calls![0]!.parsed_arguments).toEqual({ city: '北京' });
  });

  it('reasoning_content → reasoning', async () => {
    const { llm } = make_adapter(() =>
      ok_json({ choices: [{ message: { content: '答', reasoning_content: '想' }, finish_reason: 'stop' }] }),
    );
    const result = await llm.ainvoke([user('hi')]);
    expect(result.reasoning).toBe('想');
  });

  it('HTTP 状态码错误分类（含上游 detail 透传）', async () => {
    const cases = [
      [401, LLMAuthError],
      [403, LLMAuthError],
      [429, LLMRateLimitError],
      [500, LLMServerError],
      [503, LLMServerError],
      [400, LLMBadRequestError],
      [422, LLMBadRequestError],
      [404, LLMNotFoundError],
    ] as const;
    for (const [status, cls] of cases) {
      const { llm } = make_adapter(() => error_json(status, { error: { message: '上游错误信息', code: 'x' } }));
      const err = await capture(llm.ainvoke([user('hi')]));
      expect(err).toBeInstanceOf(cls);
      expect(String(err)).toContain('上游错误信息');
    }
  });

  it('非 JSON body → LLMFormatError', async () => {
    const { llm } = make_adapter(() => text_response(200, '<html>gateway</html>'));
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMFormatError);
  });

  it('响应缺 choices → LLMFormatError', async () => {
    const { llm } = make_adapter(() => ok_json({ id: 'x' }));
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMFormatError);
  });

  it('传输读超时 → LLMTimeoutError', async () => {
    const { llm } = make_adapter(() => {
      throw new TimeoutError('读超时');
    });
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMTimeoutError);
  });

  it('HTTP 408 → LLMTimeoutError', async () => {
    const { llm } = make_adapter(() => error_json(408, { error: { message: 'request timeout' } }));
    const err = await capture(llm.ainvoke([user('hi')]));
    expect(err).toBeInstanceOf(LLMTimeoutError);
  });

  it('aclose 释放并重建 client（长连接生命周期由宿主管理）', async () => {
    const { llm, seen } = make_adapter(OK_HANDLER);
    await llm.ainvoke([user('hi')]);
    expect((llm as unknown as { _client: unknown })._client).not.toBeNull();
    await llm.aclose();
    expect((llm as unknown as { _client: unknown })._client).toBeNull();
    await llm.ainvoke([user('hi')]); // 关闭后可重建
    expect(seen.calls).toBe(2);
  });
});
