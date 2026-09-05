/**
 * HttpMcpTransport 镜像单测（fake fetch seam 注入，零真实网络）：连接超时、
 * session-id 回带、202+Location 异步轮询、SSE 配对、响应体大小上界。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_STDIO_FRAME_BYTES,
  McpConnectionLost,
  McpServerConfig,
  McpToolImportError,
  McpTransport,
  HttpMcpTransport,
  type FetchLike,
  type FetchResponseLike,
} from '../../../src/adapters/mcp/index.js';

/** fake fetch 记录的调用。 */
interface FakeCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}

/** fake fetch 工厂：handler 决定每请求的响应；calls 记录全部请求。 */
function make_fetch(
  handler: (call: FakeCall) => FetchResponseLike | Promise<FetchResponseLike>,
): { fetch_impl: FetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetch_impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  return { fetch_impl, calls };
}

/** 挂起响应：仅在 signal abort 时以 AbortError 拒绝（模拟不落定的连接）。 */
function hanging_response(call: FakeCall): Promise<FetchResponseLike> {
  return new Promise<FetchResponseLike>((_resolve, reject) => {
    call.init.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

/** 构造假响应（headers 大小写不敏感存取，对齐 Headers.get 语义）。 */
function fake_response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

function json_body(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): FetchResponseLike {
  return fake_response(status, JSON.stringify(payload), {
    'content-type': 'application/json',
    ...headers,
  });
}

function parsed_body(call: FakeCall): { id?: number; method?: string; [k: string]: unknown } | null {
  try {
    return JSON.parse(call.init.body ?? 'null') as Record<string, unknown>;
  } catch {
    return null;
  }
}

function http_config(url = 'https://mcp.example'): McpServerConfig {
  return new McpServerConfig({ id: 'srv', transport: McpTransport.HTTP, url });
}

const SERVER_INFO = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 's', version: '1' } };

afterEach(() => {
  vi.useRealTimers();
});

describe('HttpMcpTransport 会话语义', () => {
  it('握手回带 Mcp-Session-Id：后续 POST 均携带会话头', async () => {
    const sessionHeaders: string[] = [];
    const { fetch_impl } = make_fetch((call) => {
      const msg = parsed_body(call);
      const method = msg?.['method'];
      if (call.init.headers?.['Mcp-Session-Id'] !== undefined) {
        sessionHeaders.push(call.init.headers['Mcp-Session-Id'] as string);
      }
      if (method === 'initialize') {
        return json_body(200, { jsonrpc: '2.0', id: msg?.['id'], result: SERVER_INFO }, {
          'mcp-session-id': 'sess-abc',
        });
      }
      if (method === 'tools/list') {
        return json_body(200, {
          jsonrpc: '2.0',
          id: msg?.['id'],
          result: { tools: [{ name: 't1' }] },
        });
      }
      return fake_response(202, '', {}); // notifications/initialized 等
    });
    const transport = new HttpMcpTransport(http_config(), { fetch_impl });
    await transport.start();
    expect(transport._session_id).toBe('sess-abc');
    const tools = await transport.list_tools();
    expect(tools.map((t) => t['name'])).toEqual(['t1']);
    expect(sessionHeaders.length).toBeGreaterThanOrEqual(1);
    expect(sessionHeaders[0]).toBe('sess-abc');
    await transport.aclose();
  });

  it('202 + Location 异步响应：GET 拉流配对（异步 GET 回带会话头）', async () => {
    const gets: FakeCall[] = [];
    let callId = 0;
    const { fetch_impl } = make_fetch((call) => {
      const msg = parsed_body(call);
      const method = msg?.['method'];
      if (call.init.method === 'GET') {
        gets.push(call);
        // Location 拉流 = SSE 形态（data: <json> 帧），配对 id = tools/call id
        const event = JSON.stringify({
          jsonrpc: '2.0',
          id: callId,
          result: { content: [{ type: 'text', text: 'async-ok' }], isError: false },
        });
        return fake_response(200, `data: ${event}\n\n`, {
          'content-type': 'text/event-stream',
        });
      }
      if (method === 'initialize') {
        return json_body(200, { jsonrpc: '2.0', id: msg?.['id'], result: SERVER_INFO }, {
          'mcp-session-id': 's1',
        });
      }
      if (method === 'tools/call') {
        callId = msg?.['id'] as number;
        return fake_response(202, '', { location: 'https://mcp.example/stream/42' });
      }
      return fake_response(202, '', {});
    });
    const transport = new HttpMcpTransport(http_config(), { fetch_impl });
    await transport.start();
    const result = await transport.call_tool('echo', { text: 'x' });
    expect(gets.length).toBe(1);
    expect(gets[0]!.init.headers?.['Mcp-Session-Id']).toBe('s1');
    const content = (result['content'] as { text: string }[])[0];
    expect(content?.['text']).toBe('async-ok');
    await transport.aclose();
  });

  it('SSE 配对：text/event-stream 响应按请求 id 取回（忽略通知与他请求响应）', async () => {
    const { fetch_impl } = make_fetch((call) => {
      const msg = parsed_body(call);
      const method = msg?.['method'];
      if (method === 'initialize') {
        return json_body(200, { jsonrpc: '2.0', id: msg?.['id'], result: SERVER_INFO });
      }
      if (method === 'tools/list') {
        const id = msg?.['id'];
        const events = [
          `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`,
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: (id as number) + 100, result: { tools: [{ name: 'wrong' }] } })}\n\n`,
          `data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'right' }] } })}\n\n`,
        ].join('');
        return fake_response(200, events, { 'content-type': 'text/event-stream' });
      }
      return fake_response(202, '', {});
    });
    const transport = new HttpMcpTransport(http_config(), { fetch_impl });
    await transport.start();
    const tools = await transport.list_tools();
    expect(tools.map((t) => t['name'])).toEqual(['right']); // 只取本请求 id 的配对
    await transport.aclose();
  });

  it('非流式 JSON 响应体超上限 fail-closed（>16MiB 拒绝解析）', async () => {
    const big = 'x'.repeat(MAX_STDIO_FRAME_BYTES + 1);
    const { fetch_impl } = make_fetch((call) => {
      const msg = parsed_body(call);
      const method = msg?.['method'];
      if (method === 'initialize') {
        return json_body(200, { jsonrpc: '2.0', id: msg?.['id'], result: SERVER_INFO });
      }
      return json_body(200, {
        jsonrpc: '2.0',
        id: msg?.['id'],
        result: { tools: [{ name: 'big' }], pad: big },
      });
    });
    const transport = new HttpMcpTransport(http_config(), { fetch_impl });
    await transport.start();
    await expect(transport.list_tools()).rejects.toBeInstanceOf(McpConnectionLost);
    await expect(transport.list_tools()).rejects.toThrow(/响应体超限/);
    await transport.aclose();
  });

  it('连接超时中止在途 fetch（AbortSignal 生效，进程不悬挂）', async () => {
    vi.useFakeTimers();
    try {
      const { fetch_impl } = make_fetch(hanging_response);
      const transport = new HttpMcpTransport(http_config(), { fetch_impl });
      const startP = transport.start();
      // 预先挂处理兜底：advance 触发 abort 的拒绝不得以 unhandled 形式泄漏
      startP.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(startP).rejects.toBeInstanceOf(McpToolImportError);
      await expect(startP).rejects.toThrow(/连接超时/);
    } finally {
      vi.useRealTimers();
    }
  });
});
