/**
 * serve 传输层测试：真通道注入路径 + 无配置 stub 路径。
 *
 * 断言面：URL/ws 端点推导、JSON-RPC 信封与鉴权头、错误信封归一、
 * ws 订阅帧与事件推送归一、topic 映射、模块级通道注入装配。
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  createServeChannel,
  createUnavailableChannel,
  getServeChannel,
  resolveServeChannel,
  serveTopicsForWebTopic,
  setServeChannel,
  type ServeChannel,
  type ServeEventEnvelope,
  type ServeWsCtor,
} from '@/shared/backend/transport';
import { createServeBackend } from '@/shared/backend/backendAdapter';

/** 假 fetch：记录调用并按脚本回包（response 面：ok/status/json）。 */
function fakeFetch(handler: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  onCall?: (url: string, init: { headers?: Record<string, string>; body?: string }) => void;
}): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const text = typeof init?.body === 'string' ? init.body : '';
    handler.onCall?.(String(url), {
      headers: (init?.headers as Record<string, string>) ?? {},
      body: text,
    });
    return {
      ok: handler.ok !== false,
      status: handler.status ?? 200,
      json: async () => handler.json ?? {},
    } as Response;
  }) as typeof fetch;
}

/** 假 WebSocket：捕获订阅 URL/帧，测试侧驱动 open/message/close。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static sent: Array<{ url: string; payload: string }> = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    if (!this.closed) FakeWebSocket.sent.push({ url: this.url, payload });
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  triggerMessage(payload: string): void {
    this.onmessage?.({ data: payload } as MessageEvent);
  }
}

function resetFakes(): void {
  FakeWebSocket.instances = [];
  FakeWebSocket.sent = [];
}

function channelDeps(): {
  fetchImpl: typeof fetch;
  WebSocketImpl: ServeWsCtor;
} {
  return {
    fetchImpl: fakeFetch({ json: { jsonrpc: '2.0', result: {} } }),
    WebSocketImpl: FakeWebSocket as unknown as ServeWsCtor,
  };
}

afterEach(() => {
  resetFakes();
  // 模块级通道复位 stub（跨用例隔离装配态）
  setServeChannel(createUnavailableChannel());
});

describe('serve 端点推导与 topic 映射', () => {
  it('serveTopicsForWebTopic：round_event = events.* + state.*；其它原样透传', () => {
    expect(serveTopicsForWebTopic('round_event')).toEqual(['events.*', 'state.*']);
    expect(serveTopicsForWebTopic('events.reply_token')).toEqual(['events.reply_token']);
  });

  it('request 指向 {base}/rpc 并带 Bearer token（token 配置时）', async () => {
    resetFakes();
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetchImpl = fakeFetch({
      json: { jsonrpc: '2.0', result: { ok: true } },
      onCall: (url, init) => calls.push({ url, body: String(init.body), headers: init.headers ?? {} }),
    });
    const channel = createServeChannel(
      { baseUrl: 'http://127.0.0.1:18731/', token: 'tkn' },
      { fetchImpl, WebSocketImpl: FakeWebSocket as unknown as ServeWsCtor },
    );
    const result = await channel.request<{ ok: boolean }>('round_send', { input: 'hi' });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:18731/rpc');
    expect(calls[0]!.headers['authorization']).toBe('Bearer tkn');
    const envelope = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(envelope['jsonrpc']).toBe('2.0');
    expect(envelope['method']).toBe('round_send');
    expect(envelope['params']).toEqual({ input: 'hi' });
  });

  it('round_event 订阅帧映射为 events.* + state.*（无 token 时 ws url 不带 token 段）', async () => {
    resetFakes();
    const channel = createServeChannel({ baseUrl: 'http://127.0.0.1:18731' }, channelDeps());
    await channel.subscribe('round_event', () => undefined);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://127.0.0.1:18731/ws');
    const instance = FakeWebSocket.instances[0]!;
    instance.triggerOpen();
    expect(FakeWebSocket.sent).toHaveLength(1);
    const frame = JSON.parse(FakeWebSocket.sent[0]!.payload) as { type: string; topics: string[] };
    expect(frame.type).toBe('subscribe');
    expect(frame.topics).toEqual(['events.*', 'state.*']);
  });
});

describe('serve 真通道 request：JSON-RPC 信封与错误归一', () => {
  it('JSON-RPC error 回错误信封（code 转字符串）', async () => {
    resetFakes();
    const fetchImpl = fakeFetch({
      json: { jsonrpc: '2.0', error: { code: -32601, message: 'method not found' } },
    });
    const channel = createServeChannel(
      { baseUrl: 'http://127.0.0.1:18731', token: 't' },
      { fetchImpl, WebSocketImpl: FakeWebSocket as unknown as ServeWsCtor },
    );
    await expect(channel.request('unknown_method')).rejects.toMatchObject({
      code: '-32601',
      message: 'method not found',
    });
  });

  it('HTTP 非 200（鉴权失败）归一为 HTTP_ 状态码信封', async () => {
    resetFakes();
    const fetchImpl = fakeFetch({
      ok: false,
      status: 401,
      json: { error: { message: 'unauthorized' } },
    });
    const channel = createServeChannel(
      { baseUrl: 'http://127.0.0.1:18731', token: 'bad' },
      { fetchImpl, WebSocketImpl: FakeWebSocket as unknown as ServeWsCtor },
    );
    await expect(channel.request('round_send')).rejects.toMatchObject({
      code: 'HTTP_401',
    });
  });

  it('网络不可达 → NETWORK 信封', async () => {
    resetFakes();
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const channel = createServeChannel(
      { baseUrl: 'http://127.0.0.1:1' },
      { fetchImpl, WebSocketImpl: FakeWebSocket as unknown as ServeWsCtor },
    );
    await expect(channel.request('ping')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('serve 真通道 subscribe：事件推送归一', () => {
  it('事件帧 → 信封 {event, id, payload}；events.* 与 state.* 投递；注销关闭连接', async () => {
    resetFakes();
    const channel = createServeChannel(
      { baseUrl: 'http://127.0.0.1:18731', token: 'tok' },
      channelDeps(),
    );
    const received: ServeEventEnvelope<unknown>[] = [];
    const unsub = await channel.subscribe('round_event', (raw) => {
      received.push(raw as ServeEventEnvelope<unknown>);
    });
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('ws://127.0.0.1:18731/ws?token=tok');
    ws.triggerOpen();
    ws.triggerMessage(
      JSON.stringify({ type: 'event', topic: 'events.reply_token', data: { type: 'reply_token', payload: { token: 'a' } } }),
    );
    ws.triggerMessage(
      JSON.stringify({ type: 'event', topic: 'state.round.t1', data: { thread_id: 't1', state: 'done' } }),
    );
    expect(received).toHaveLength(2);
    expect(received[0]!.event).toBe('events.reply_token');
    expect((received[0]!.payload as { type: string }).type).toBe('reply_token');
    expect(received[1]!.event).toBe('state.round.t1');
    await unsub();
    expect(ws.closed).toBe(true);
  });
});

describe('serve stub 路径：无配置回落', () => {
  it('resolveServeChannel({}) = available false；request 抛错、subscribe 空操作', async () => {
    const channel = resolveServeChannel({});
    expect(channel.available).toBe(false);
    expect(channel.baseUrl).toBeUndefined();
    expect(() => channel.request('x')).toThrow(/serve 通道未就绪/);
    const unsub = await channel.subscribe('round_event', () => undefined);
    unsub();
  });

  it('默认模块级通道 = stub；createServeBackend 回落不可用适配器', async () => {
    expect(getServeChannel().available).toBe(false);
    const backend = createServeBackend();
    expect(backend.available).toBe(false);
    expect(() => backend.sessionList()).toThrow(/宿主后端不可用/);
  });
});

describe('装配期注入：setServeChannel 接真通道', () => {
  it('注入真通道后 createServeBackend 可用且命令经通道下发', async () => {
    resetFakes();
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const fetchImpl = fakeFetch({
      json: { jsonrpc: '2.0', result: { sessions: [] } },
      onCall: (url, init) => calls.push({ url, body: String(init.body), headers: init.headers ?? {} }),
    });
    const channel = createServeChannel(
      { baseUrl: 'http://127.0.0.1:18731', token: 't' },
      { fetchImpl, WebSocketImpl: FakeWebSocket as unknown as ServeWsCtor },
    );
    setServeChannel(channel);
    expect(getServeChannel().available).toBe(true);
    const backend = createServeBackend();
    expect(backend.available).toBe(true);
    const sessions = await backend.sessionList();
    expect(sessions).toEqual([]);
    const request = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(request['method']).toBe('session_list');
  });

  it('serveTopicsForWebTopic round_event 覆盖 events.* 与 state.*（与 stub 订阅契约一致）', () => {
    const channel: ServeChannel = createServeChannel({ baseUrl: 'http://127.0.0.1:18731' }, channelDeps());
    expect(channel.available).toBe(true);
    expect(channel.baseUrl).toBe('http://127.0.0.1:18731');
    expect(serveTopicsForWebTopic('round_event')).toEqual(['events.*', 'state.*']);
  });
});
