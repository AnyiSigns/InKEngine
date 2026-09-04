/**
 * OpenAI Responses API 适配器单测（fake transport 本地模拟，零真实网络）。
 *
 * 对标 pytest test_llm_openai_responses.py：覆盖非流式/流式解析（内容/工具
 * 调用/终态/用量）、请求负载构造（input 数组消息/工具回环项/tools 形态）、
 * 错误分类与空流。协议全名 openai_responses；注册表/兼容别名尚未移植，
 * 断言落到适配器级（adapter 常量 + 构造）。
 */

import { describe, expect, it } from 'vitest';

import { LLMChunk } from '../../../src/core/llm/base.js';
import { LLMConfig, LLMParams } from '../../../src/core/llm/base.js';
import { LLMAuthError, LLMEmptyStreamError, LLMRateLimitError } from '../../../src/core/llm/errors.js';
import { Attachment, ToolCall, assistant, system, tool_result, user } from '../../../src/core/llm/messages.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';
import { OpenAIResponsesLLM } from '../../../src/adapters/llm/openai_response.js';
import { _parse_sse_line } from '../../../src/adapters/llm/_responses_parse.js';
import type { LlmResponse, LlmTransport } from '../../../src/adapters/llm/_responses_transport.js';

type Body = Record<string, unknown>;

interface Seen {
  calls: number;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function json_response(status: number, payload: unknown): LlmResponse {
  return {
    status,
    json: async () => payload,
    body_text: async () => JSON.stringify(payload),
    async *aiter_lines() {},
  };
}

function stream_response(status: number, lines: readonly string[]): LlmResponse {
  return {
    status,
    json: async () => {
      throw new Error('非流式响应不可 json');
    },
    body_text: async () => lines.join('\n'),
    async *aiter_lines() {
      for (const line of lines) yield line;
    },
  };
}

function make_adapter(handler: () => LlmResponse): { llm: OpenAIResponsesLLM; seen: Seen } {
  const seen: Seen = { calls: 0, url: '', headers: {}, body: null };
  const transport: LlmTransport = {
    async post(url, request) {
      seen.calls += 1;
      seen.url = url;
      seen.headers = { ...request.headers };
      seen.body = request.json;
      return handler();
    },
  };
  const config = new LLMConfig({
    adapter: 'openai_responses',
    model_id: 'gpt-5',
    base_url: 'https://api.openai.com/v1/',
    api_key: 'sk-test',
  });
  const llm = new OpenAIResponsesLLM(config, { transport });
  return { llm, seen };
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

function ok_response(): LlmResponse {
  return json_response(200, { output: [], finish_reason: 'stop' });
}

async function collect(chunks: AsyncIterable<LLMChunk>): Promise<LLMChunk[]> {
  const out: LLMChunk[] = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
}

// ---------------------------------------------------------------------------
// 协议标识与请求负载构造
// ---------------------------------------------------------------------------
describe('OpenAIResponsesLLM 协议标识与请求负载', () => {
  it('adapter 协议全名 openai_responses', () => {
    expect(OpenAIResponsesLLM.name).toBe('OpenAIResponsesLLM');
  });

  it('负载形态与端点：model/stream/input + /responses 后缀', async () => {
    const { llm, seen } = make_adapter(ok_response);
    await llm.ainvoke([user('hi')]);
    expect(seen.url).toMatch(/\/responses$/);
    const body = seen.body as Body;
    expect(body['model']).toBe('gpt-5');
    expect(body['stream']).toBe(false);
    expect(body['input']).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('input 转换：消息/工具回环项（function_call + function_call_output）', async () => {
    const { llm, seen } = make_adapter(ok_response);
    const messages = [
      system('你是助手'),
      user('分析下'),
      assistant('调用工具', {
        tool_calls: [new ToolCall({ id: 'call_1', name: 'web_search', arguments: '{"q":"x"}' })],
      }),
      tool_result('结果', 'call_1'),
      user('继续'),
    ];
    await llm.ainvoke(messages);
    const items = (seen.body as Body)['input'] as unknown[];
    expect(items[0]).toEqual({ role: 'system', content: '你是助手' });
    expect(items[1]).toEqual({ role: 'user', content: '分析下' });
    expect(items[2]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'web_search',
      arguments: '{"q":"x"}',
    });
    expect(items[3]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: '结果',
    });
    expect(items[4]).toEqual({ role: 'user', content: '继续' });
  });

  it('tools 扁平 function 段（type=function + name/description/parameters）', async () => {
    const { llm, seen } = make_adapter(ok_response);
    const spec = new ToolSpec({
      name: 'web_search',
      description: '联网检索',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    });
    await llm.ainvoke([user('hi')], { tools: [spec] });
    const tools = (seen.body as Body)['tools'] as Body[];
    expect(tools.length).toBe(1);
    expect(tools[0]!['type']).toBe('function');
    expect(tools[0]!['name']).toBe('web_search');
    expect(tools[0]!['description']).toBe('联网检索');
    const params = tools[0]!['parameters'] as Body;
    expect((params['properties'] as Body)['q']).toEqual({ type: 'string' });
  });

  it('user 附件展开为 input_text + 多模态内容段', async () => {
    const { llm, seen } = make_adapter(ok_response);
    const msg = user('看图', { attachments: [new Attachment({ kind: 'image', url: 'https://x/i.png' })] });
    await llm.ainvoke([msg]);
    const item = ((seen.body as Body)['input'] as unknown[])[0] as Body;
    expect(item['role']).toBe('user');
    expect((item['content'] as unknown[])[0]).toEqual({ type: 'input_text', text: '看图' });
    expect(((item['content'] as unknown[])[1] as Body)['type']).toBe('image_url');
  });

  it('max_output_tokens 与 temperature 透传', async () => {
    const { llm, seen } = make_adapter(ok_response);
    await llm.ainvoke([user('hi')], { params: new LLMParams({ max_tokens: 100, temperature: 0.2 }) });
    const body = seen.body as Body;
    expect(body['max_output_tokens']).toBe(100);
    expect(body['temperature']).toBe(0.2);
  });

  it('reasoning_effort 映射 reasoning.effort（high）', async () => {
    const { llm, seen } = make_adapter(ok_response);
    await llm.ainvoke([user('hi')], { params: new LLMParams({ reasoning_effort: 'high' }) });
    expect((seen.body as Body)['reasoning']).toEqual({ effort: 'high' });
  });

  it('reasoning_effort off 不携带 reasoning', async () => {
    const { llm, seen } = make_adapter(ok_response);
    await llm.ainvoke([user('hi')], { params: new LLMParams({ reasoning_effort: 'off' }) });
    expect('reasoning' in (seen.body as Body)).toBe(false);
  });

  it('enable_thinking 无显式档位默认 medium', async () => {
    const { llm, seen } = make_adapter(ok_response);
    await llm.ainvoke([user('hi')], { params: new LLMParams({ enable_thinking: true }) });
    expect((seen.body as Body)['reasoning']).toEqual({ effort: 'medium' });
  });
});

// ---------------------------------------------------------------------------
// 非流式解析
// ---------------------------------------------------------------------------
describe('ainvoke 非流式解析', () => {
  it('message + function_call 项：内容/对象 arguments 归一/终态/用量', async () => {
    const handler = () =>
      json_response(200, {
        id: 'resp_1',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: '结论' }] },
          { type: 'function_call', call_id: 'fc_1', name: 'web_search', arguments: { q: 'x' } },
        ],
        finish_reason: 'function_call',
        usage: { input_tokens: 10, output_tokens: 20 },
      });
    const { llm } = make_adapter(handler);
    const result = await llm.ainvoke([user('hi')]);
    expect(result.content).toBe('结论');
    expect(result.tool_calls?.length).toBe(1);
    expect(result.tool_calls?.[0]?.name).toBe('web_search');
    expect(JSON.parse(result.tool_calls?.[0]?.arguments ?? '') as unknown).toEqual({ q: 'x' });
    expect(result.finish_reason).toBe('function_call');
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
  });

  it('字符串 arguments 原样保留', async () => {
    const handler = () =>
      json_response(200, {
        output: [{ type: 'function_call', call_id: 'fc_2', name: 'f', arguments: '{"a":1}' }],
        finish_reason: 'function_call',
      });
    const { llm } = make_adapter(handler);
    const result = await llm.ainvoke([user('hi')]);
    expect(result.tool_calls?.[0]?.arguments).toBe('{"a":1}');
  });
});

// ---------------------------------------------------------------------------
// 流式解析
// ---------------------------------------------------------------------------
describe('astream 流式解析', () => {
  it('文本增量/工具定型/completed 终态/usage 帧', async () => {
    const lines = [
      sse({ type: 'response.output_text.delta', delta: '你' }),
      sse({ type: 'response.output_text.delta', delta: '好' }),
      sse({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'fc_s', name: 'web_search', arguments: { q: 'y' } },
      }),
      sse({ type: 'response.completed' }),
      sse({ type: 'response.usage', usage: { output_tokens: 5 } }),
    ];
    const { llm } = make_adapter(() => stream_response(200, lines));
    const chunks = await collect(llm.astream([user('hi')]));
    const tokens = chunks.map((c) => c.token ?? '').join('');
    expect(tokens).toBe('你好');
    const deltas = chunks.filter((c) => c.tool_calls_delta);
    expect(deltas.length).toBe(1);
    expect(deltas[0]!.tool_calls_delta?.[0]?.name).toBe('web_search');
    expect(deltas[0]!.tool_calls_delta?.[0]?.id).toBe('fc_s');
    const finishes = chunks.filter((c) => c.finish_reason).map((c) => c.finish_reason);
    expect(finishes).toEqual(['completed']);
    const usages = chunks.filter((c) => c.usage).map((c) => c.usage);
    expect(usages[usages.length - 1]).toEqual({ output_tokens: 5 });
  });

  it('空流抛 LLMEmptyStreamError', async () => {
    const { llm } = make_adapter(() => stream_response(200, []));
    await expect(collect(llm.astream([user('hi')]))).rejects.toThrow(LLMEmptyStreamError);
  });

  it('坏帧（非 JSON）容错跳过不中断', async () => {
    const lines = ['data: not-json', sse({ type: 'response.output_text.delta', delta: 'ok' })];
    const { llm } = make_adapter(() => stream_response(200, lines));
    const chunks = await collect(llm.astream([user('hi')]));
    expect(chunks.map((c) => c.token ?? '').join('')).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------
describe('错误分类', () => {
  it('HTTP 401 分类为 LLMAuthError', async () => {
    const { llm } = make_adapter(() => json_response(401, { error: { message: 'bad key' } }));
    await expect(llm.ainvoke([user('hi')])).rejects.toThrow(LLMAuthError);
  });

  it('HTTP 429 分类为 LLMRateLimitError', async () => {
    const { llm } = make_adapter(() => json_response(429, { error: { message: 'rate limited' } }));
    await expect(llm.ainvoke([user('hi')])).rejects.toThrow(LLMRateLimitError);
  });
});

// ---------------------------------------------------------------------------
// SSE 事件语义（直接单测：坏帧/无信息事件/error 帧）
// ---------------------------------------------------------------------------
describe('SSE 事件解析语义', () => {
  it('[DONE] 与未知事件类型返回 null 跳过', () => {
    expect(_parse_sse_line('data: [DONE]')).toBeNull();
    expect(_parse_sse_line(sse({ type: 'response.output_text.done' }))).toBeNull();
    expect(_parse_sse_line('event: ping')).toBeNull();
  });

  it('error 帧按 code 提示分类（rate_limit_exceeded → 429）', () => {
    expect(() =>
      _parse_sse_line(sse({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'busy' } })),
    ).toThrow(LLMRateLimitError);
  });
});
