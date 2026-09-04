/**
 * Anthropic 流式分帧契约单测（test_llm_adapters.py TestAnthropicAstreamFraming
 * 移植）：文本增量、工具调用增量累积、usage 语义、空流、流内 error 事件分类。
 * fake 传输注入，零真实网络。
 */

import { describe, expect, it } from 'vitest';

import { collect_result, LLMParams } from '../../../src/core/llm/base.js';
import { LLMEmptyStreamError, LLMRateLimitError } from '../../../src/core/llm/errors.js';
import { assistant, tool_result, user } from '../../../src/core/llm/messages.js';
import { ToolCall } from '../../../src/core/llm/_shapes.js';

import {
  DONE_FRAME,
  PING_FRAME,
  WEATHER_TOOL,
  body_of,
  make_anthropic,
  sse_frame,
  stream_response,
} from './anthropic_helpers.js';

describe('Anthropic astream 分帧', () => {
  it('文本增量流式累积 + usage（prompt 自 message_start 暂存合并）', async () => {
    const frames = [
      sse_frame({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
      sse_frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } }),
      sse_frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }),
      sse_frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      DONE_FRAME,
    ];
    const { llm } = make_anthropic(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.content).toBe('你好');
    expect(result.finish_reason).toBe('stop');
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2 });
  });

  it('工具调用增量按 index 累积（content_block_start + input_json_delta）', async () => {
    const frames = [
      sse_frame({ type: 'message_start', message: {} }),
      sse_frame({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      }),
      sse_frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city"' } }),
      sse_frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"北京"}' } }),
      sse_frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
      DONE_FRAME,
    ];
    const { llm } = make_anthropic(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')], { tools: [WEATHER_TOOL] }));
    expect(result.finish_reason).toBe('tool_calls');
    expect(result.tool_calls).not.toBeNull();
    expect(result.tool_calls?.length).toBe(1);
    expect(result.tool_calls?.[0]?.id).toBe('toolu_1');
    expect(result.tool_calls?.[0]?.name).toBe('get_weather');
    expect(result.tool_calls?.[0]?.parsed_arguments).toEqual({ city: '北京' });
  });

  it('message_delta 无 usage 时仅产出 finish_reason', async () => {
    const frames = [
      sse_frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      sse_frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      DONE_FRAME,
    ];
    const { llm } = make_anthropic(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.content).toBe('ok');
    expect(result.finish_reason).toBe('length');
    expect(result.usage).toBeNull();
  });

  it('空流（无 data 帧）抛 LLMEmptyStreamError', async () => {
    const { llm } = make_anthropic(() => stream_response([PING_FRAME]));
    await expect(collect_result(llm.astream([user('hi')]))).rejects.toBeInstanceOf(LLMEmptyStreamError);
  });

  it('坏 SSE 帧容错跳过（不中断流）', async () => {
    const frames = [
      'not a frame\n\n',
      sse_frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }),
      sse_frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      DONE_FRAME,
    ];
    const { llm } = make_anthropic(() => stream_response(frames));
    const result = await collect_result(llm.astream([user('hi')]));
    expect(result.content).toBe('好');
  });
});

describe('Anthropic 流内错误事件', () => {
  it('error 事件按 type 提示状态码分类（限流）', async () => {
    const frames = [sse_frame({ type: 'error', error: { type: 'rate_limit_error', message: '限流了' } })];
    const { llm } = make_anthropic(() => stream_response(frames));
    await expect(collect_result(llm.astream([user('hi')]))).rejects.toMatchObject({
      name: 'LLMRateLimitError',
      detail: '限流了',
    });
  });
});

describe('Anthropic 多轮消息往返', () => {
  it('astream 消息 payload：assistant 工具调用块 + tool_result 回传', async () => {
    const frames = [
      sse_frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } }),
      sse_frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      DONE_FRAME,
    ];
    const { llm, seen } = make_anthropic(() => stream_response(frames));
    const messages = [
      user('查北京天气'),
      assistant('', {
        tool_calls: [new ToolCall({ id: 'toolu_1', name: 'get_weather', arguments: '{"city":"北京"}' })],
      }),
      tool_result('{"temp": 26}', 'toolu_1'),
    ];
    const result = await collect_result(llm.astream(messages, { params: new LLMParams({ max_tokens: 64 }) }));
    expect(result.content).toBe('好');
    const sent = body_of(seen) as {
      messages: { role: string; content: unknown }[];
      max_tokens: number;
    };
    expect(sent.max_tokens).toBe(64);
    expect(sent.messages.length).toBe(3);
    const toolUseBlock = (sent.messages[1]?.content as { type: string; name: string }[]).find(
      (b) => b.type === 'tool_use',
    );
    expect(toolUseBlock?.name).toBe('get_weather');
    const toolMsg = sent.messages[2];
    expect(toolMsg?.role).toBe('user');
    const toolResultBlock = (toolMsg?.content as { type: string; tool_use_id: string }[])[0];
    expect(toolResultBlock?.type).toBe('tool_result');
    expect(toolResultBlock?.tool_use_id).toBe('toolu_1');
  });
});
