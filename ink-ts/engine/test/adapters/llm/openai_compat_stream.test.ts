/**
 * OpenAI 兼容适配器单测：流式 astream 增量解析与 usage 语义（Python
 * test_llm_openai_compat.py TestAstream 移植，零真实网络）。
 */
import { describe, expect, it } from 'vitest';

import { LLMParams, collect_result } from '../../../src/core/llm/base.js';
import { user } from '../../../src/core/llm/messages.js';
import {
  LLMAuthError,
  LLMBadRequestError,
  LLMEmptyStreamError,
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
  stream_response,
  sse_delta,
  sse_frame,
} from './compat_helpers.js';

describe('astream 增量解析', () => {
  it('内容 + 推理增量累积（reasoning_content）', async () => {
    const frames = [
      sse_frame(sse_delta({ reasoning_content: '想' })),
      sse_frame(sse_delta({ content: '你' })),
      sse_frame(sse_delta({ content: '好' })),
      sse_frame(sse_delta({}, 'stop')),
      'data: [DONE]\n\n',
    ];
    const { llm } = make_adapter(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.content).toBe('你好');
    expect(result.reasoning).toBe('想');
    expect(result.finish_reason).toBe('stop');
  });

  it('推理别名字段 reasoning', async () => {
    const frames = [
      sse_frame(sse_delta({ reasoning: '备选推理字段' })),
      sse_frame(sse_delta({ content: '答' })),
      'data: [DONE]\n\n',
    ];
    const { llm } = make_adapter(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.reasoning).toBe('备选推理字段');
    expect(result.content).toBe('答');
  });

  it('工具调用增量按 index 累积', async () => {
    const frames = [
      sse_frame(
        sse_delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] }),
      ),
      sse_frame(sse_delta({ tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] })),
      sse_frame(sse_delta({ tool_calls: [{ index: 0, function: { arguments: ':"北京"}' } }] })),
      sse_frame(sse_delta({}, 'tool_calls')),
      'data: [DONE]\n\n',
    ];
    const { llm } = make_adapter(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.finish_reason).toBe('tool_calls');
    expect(result.tool_calls).not.toBeNull();
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0]!.id).toBe('call_1');
    expect(result.tool_calls![0]!.name).toBe('get_weather');
    expect(result.tool_calls![0]!.arguments).toBe('{"city":"北京"}');
    expect(result.tool_calls![0]!.parsed_arguments).toEqual({ city: '北京' });
  });

  it('纯 usage 末帧被 collect_result 捕获', async () => {
    const frames = [
      sse_frame(sse_delta({ content: 'x' })),
      sse_frame({ choices: [], usage: { prompt_tokens: 1 } }),
      'data: [DONE]\n\n',
    ];
    const { llm } = make_adapter(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.usage).toEqual({ prompt_tokens: 1 });
  });

  it('同帧携带 choices + usage：合并产出不丢内容', async () => {
    const frames = [
      sse_frame({
        choices: [{ index: 0, delta: { content: '末' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2 },
      }),
      'data: [DONE]\n\n',
    ];
    const { llm } = make_adapter(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.content).toBe('末');
    expect(result.usage).toEqual({ prompt_tokens: 2 });
  });

  it('astream 默认请求 include_usage', async () => {
    const frames = [sse_frame(sse_delta({ content: 'x' })), 'data: [DONE]\n\n'];
    const { llm, seen } = make_adapter(() => stream_response(frames));
    await collect_result(llm.astream([user('hi')]));
    expect(body_of(seen)['stream_options']).toEqual({ include_usage: true });
  });

  it('extra_body 显式 stream_options 覆盖默认', async () => {
    const frames = [sse_frame(sse_delta({ content: 'x' })), 'data: [DONE]\n\n'];
    const { llm, seen } = make_adapter(() => stream_response(frames));
    await collect_result(
      llm.astream([user('hi')], {
        params: new LLMParams({ extra_body: { stream_options: { include_usage: false } } }),
      }),
    );
    expect(body_of(seen)['stream_options']).toEqual({ include_usage: false });
  });

  it('ainvoke 不带 stream_options（该字段仅流式语义）', async () => {
    const { llm, seen } = make_adapter(() => ok_json({ choices: [{ message: { content: 'ok' } }] }));
    await llm.ainvoke([user('hi')]);
    expect(body_of(seen)['stream_options']).toBeUndefined();
  });
});

describe('astream 流式容错', () => {
  it('坏帧跳过不中断流', async () => {
    const frames = ['data: {not json}\n\n', sse_frame(sse_delta({ content: 'ok' })), 'data: [DONE]\n\n'];
    const { llm } = make_adapter(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.content).toBe('ok');
  });

  it('keepalive 注释行跳过', async () => {
    const frames = [': ping\n\n', sse_frame(sse_delta({ content: 'ok' })), 'data: [DONE]\n\n'];
    const { llm } = make_adapter(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.content).toBe('ok');
  });

  it('空流抛 LLMEmptyStreamError（可重试瞬时故障）', async () => {
    const { llm } = make_adapter(() => stream_response([': ping\n\n']));
    const err = await capture(collect_result(llm.astream([user('hi')])));
    expect(err).toBeInstanceOf(LLMEmptyStreamError);
  });

  it('流中途 error 帧抛分类异常（已产内容仍分类上抛）', async () => {
    const frames = [
      sse_frame(sse_delta({ content: 'x' })),
      sse_frame({ error: { message: '限流了', code: 'rate_limit_exceeded' } }),
    ];
    const { llm } = make_adapter(() => stream_response(frames));
    const err = await capture(collect_result(llm.astream([user('hi')])));
    expect(err).toBeInstanceOf(LLMRateLimitError);
    expect(String(err)).toContain('限流了');
  });

  it('error 帧 code 关键词分类', async () => {
    const cases = [
      ['invalid_request_error', '参数非法', LLMBadRequestError],
      ['context_length_exceeded', '上下文超长', LLMBadRequestError],
      ['insufficient_quota', '额度不足', LLMRateLimitError],
      ['server_overloaded', '服务繁忙，请稍后重试', LLMServerError],
      ['engine_overloaded', 'engine overloaded', LLMServerError],
      [null, '上游暂时不可用，请稍后再试', LLMServerError],
      ['invalid_api_key', 'API key 无效', LLMAuthError],
      ['model_not_found', '模型不存在', LLMNotFoundError],
    ] as const;
    for (const [code, message, cls] of cases) {
      const { llm } = make_adapter(() =>
        stream_response([sse_frame({ error: { message, code } })]),
      );
      const err = await capture(collect_result(llm.astream([user('hi')])));
      expect(err).toBeInstanceOf(cls);
    }
  });

  it('流式前置 HTTP 429 分类', async () => {
    const { llm } = make_adapter(() => error_json(429, { error: { message: 'slow down' } }));
    const err = await capture(collect_result(llm.astream([user('hi')])));
    expect(err).toBeInstanceOf(LLMRateLimitError);
  });

  it('流式传输连接超时 → LLMTimeoutError', async () => {
    const { llm } = make_adapter(() => {
      throw new TimeoutError('连不上');
    });
    const err = await capture(collect_result(llm.astream([user('hi')])));
    expect(err).toBeInstanceOf(LLMTimeoutError);
  });

  it('非 dict 非法帧 → LLMFormatError（无 usage 无 choices）', async () => {
    const { llm } = make_adapter(() => stream_response(['data: {"id":"x"}\n\n']));
    const err = await capture(collect_result(llm.astream([user('hi')])));
    expect(err).toBeInstanceOf(LLMFormatError);
  });
});
