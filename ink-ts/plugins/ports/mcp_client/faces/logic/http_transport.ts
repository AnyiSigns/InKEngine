// gate: 超限(381 行) - Streamable HTTP 会话单段（会话头/请求对偶/202 拉流共用状态机），IO 原语已拆 _http_io.ts
/**
 * Streamable HTTP MCP 客户端（镜像 Python 的 streamable_http_client 路径，
 * 但自写于 node fetch——无第三方 SDK）。
 *
 * 传输面走 MCP v2 规范主形态：每请求一个 POST（initialize/tools/list/
 * tools/call/ping），响应为单条 JSON 或 SSE 流（text/event-stream）——
 * 从中按请求 id 配对取回响应；initialize 应答带 ``mcp-session-id`` 头时
 * 后续请求原样回带（会话状态保持）。202 Accepted（请求排队）形态按
 * Location 拉流读取。
 *
 * 安全/健壮性要点：
 * - 响应体读取带字节上界（MAX_STDIO_FRAME_BYTES）：边读边计数、超限即
 *   cancel 上游（不整读后才发现），与 stdio 帧上限同常量 fail-closed；
 * - 请求级空闲中止（IdleAbort，见 _http_io.ts）：整个 roundtrip 的头部
 *   等待与读体逐块共用同一 AbortController，超时取消在途网络（不悬挂）；
 * - 202 Location 重定向仅接受 http/https scheme（防 file:// 等本地形态
 *   被远端拖入），异步 GET 回带同会话头（Mcp-Session-Id）；
 * - 本实现只承载请求/响应对偶（list_tools/call_tool/ping 的上界语义
 *   齐备），不维护常驻 GET 通知流。
 */
import { McpConnectionLost, McpToolImportError, RpcError, RpcTimeout } from './_errors.js';
import {
  CALL_TIMEOUT,
  CONNECT_TIMEOUT,
  MAX_STDIO_FRAME_BYTES,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
} from './_framing.js';
import { with_timeout } from './_rpc_channel.js';
import {
  make_idle_abort,
  parse_sse_events,
  read_body_bounded,
  type BodyReaderLike,
  type IdleAbort,
} from './_http_io.js';
import type { McpCallResult, McpJsonRpcMessage, McpToolRecord, RawMcpSession } from './_types.js';
import type { McpServerConfig } from './config.js';

export { parse_sse_events };

/** fetch 响应形态（网络 seam 的最小面；body 可选——缺省整读回落 text()）。 */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body?: { getReader(): BodyReaderLike } | null;
}

/** fetch seam（默认 globalThis.fetch；测试注入假实现零网络）。 */
export type FetchLike = (
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

function _wrap_fetch(fetchImpl: typeof globalThis.fetch): FetchLike {
  return async (url, init) => {
    const response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    const body = response.body;
    return {
      status: response.status,
      headers: { get: (name: string) => response.headers.get(name) },
      text: async () => await response.text(),
      body:
        body === null
          ? null
          : { getReader: () => body.getReader() },
    };
  };
}

/** Streamable HTTP 传输（RawMcpSession 形态；open 期完成握手）。 */
export class HttpMcpTransport implements RawMcpSession {
  readonly _config: McpServerConfig;
  _session_id: string | null = null;
  _server_info: Record<string, unknown> | null = null;
  _closed = false;
  private _next_id = 1;
  private readonly _fetch: FetchLike;

  constructor(config: McpServerConfig, opts: { fetch_impl?: FetchLike } = {}) {
    this._config = config;
    this._fetch = opts.fetch_impl ?? _wrap_fetch(globalThis.fetch);
  }

  async start(): Promise<void> {
    const url = this._config.url;
    if (url === null || url === '') {
      throw new McpToolImportError(`MCP server ${this._config.id} 的 http 传输缺 url`);
    }
    const id = this._next_id;
    this._next_id += 1;
    // initialize 握手带连接超时（与 stdio/memory 的 CONNECT_TIMEOUT 同口径）：
    // AbortController + 计时中止在途 fetch/正文读取，超时收敛为连接失败文案
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.round(CONNECT_TIMEOUT * 1000));
    try {
      const response = await this._post(
        {
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
          },
        },
        controller.signal,
      );
      const sessionHeader = response.headers.get('mcp-session-id');
      if (sessionHeader !== null && sessionHeader !== '') {
        this._session_id = sessionHeader;
      }
      const text = await this._read_limited(response, null);
      const contentType = response.headers.get('content-type') ?? '';
      const init = await this._resolve_collected(text, contentType, id);
      this._server_info =
        typeof init === 'object' && init !== null
          ? (init as Record<string, unknown>)
          : null;
    } catch (exc) {
      if (timedOut) {
        throw new McpToolImportError(
          `MCP server ${this._config.id} 连接超时（${CONNECT_TIMEOUT} 秒）`,
        );
      }
      throw exc;
    } finally {
      clearTimeout(timer);
    }
    await this._post_notification('notifications/initialized', {});
  }

  private _headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this._config.headers !== null) {
      for (const [key, value] of Object.entries(this._config.headers)) {
        headers[key] = value;
      }
    }
    if (this._session_id !== null) {
      headers['Mcp-Session-Id'] = this._session_id;
    }
    return headers;
  }

  private async _post(
    message: McpJsonRpcMessage,
    signal?: AbortSignal,
  ): Promise<FetchResponseLike> {
    const url = this._config.url;
    if (url === null || url === '' || this._closed) {
      throw new McpConnectionLost(`MCP server ${this._config.id} 连接已关闭`);
    }
    return await this._fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(message),
      signal,
    });
  }

  private _collect_messages(text: string, contentType: string): McpJsonRpcMessage[] {
    const parse = (data: string): McpJsonRpcMessage | null => {
      try {
        return JSON.parse(data) as McpJsonRpcMessage;
      } catch {
        return null;
      }
    };
    if (contentType.includes('text/event-stream')) {
      return parse_sse_events(text)
        .map(parse)
        .filter((m): m is McpJsonRpcMessage => m !== null);
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return (parsed as unknown[])
          .map((item) => (typeof item === 'object' && item !== null ? parse(JSON.stringify(item)) : null))
          .filter((m): m is McpJsonRpcMessage => m !== null);
      }
      if (typeof parsed === 'object' && parsed !== null) {
        return [parsed as McpJsonRpcMessage];
      }
    } catch {
      // 空体/非 JSON：视为无消息
    }
    return [];
  }

  private async _resolve_collected(
    text: string,
    contentType: string,
    id: number,
  ): Promise<unknown> {
    for (const message of this._collect_messages(text, contentType)) {
      // 流中可能夹带通知（无 id）与其他请求的响应：只取本请求 id
      if (message['id'] === id) {
        const error = message['error'];
        if (error !== null && error !== undefined) {
          throw new RpcError(
            typeof error['code'] === 'number' ? error['code'] : -32603,
            typeof error['message'] === 'string' ? error['message'] : '',
          );
        }
        return message['result'];
      }
    }
    throw new McpConnectionLost(
      `MCP server ${this._config.id} 响应未含请求 ${id} 的配对消息`,
    );
  }

  private async _request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = this._next_id;
    this._next_id += 1;
    const message: McpJsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    };
    // 请求级空闲中止：整个 roundtrip 共用一个 AbortController，超时取消在途
    // 网络（with_timeout 兜底计时，双保险不悬挂）
    const idle = make_idle_abort(timeoutMs);
    const future = this._roundtrip(message, id, idle);
    try {
      return await with_timeout(future, timeoutMs, `MCP server ${this._config.id} 请求超时`);
    } catch (exc) {
      if (idle.timed_out() && !(exc instanceof RpcTimeout)) {
        throw new RpcTimeout(`MCP server ${this._config.id} 请求超时`);
      }
      throw exc;
    } finally {
      idle.disarm();
    }
  }

  private async _fetch_io(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    idle: IdleAbort,
  ): Promise<FetchResponseLike> {
    idle.arm();
    try {
      return await this._fetch(url, { ...init, signal: idle.controller.signal });
    } finally {
      idle.disarm();
    }
  }

  private async _roundtrip(
    message: McpJsonRpcMessage,
    id: number,
    idle: IdleAbort,
  ): Promise<unknown> {
    const url = this._config.url;
    if (url === null || url === '' || this._closed) {
      throw new McpConnectionLost(`MCP server ${this._config.id} 连接已关闭`);
    }
    const response = await this._fetch_io(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(message),
    }, idle);
    const contentType = response.headers.get('content-type') ?? '';
    // 202 = 请求已受理待异步响应：按 Location 拉流读取配对消息
    if (response.status === 202) {
      const location = response.headers.get('location');
      if (location === null) {
        throw new McpConnectionLost(
          `MCP server ${this._config.id} 返回 202 但缺 Location（无法拉取异步响应）`,
        );
      }
      const scheme = (location.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)?.[1] ?? '').toLowerCase();
      if (scheme !== 'http' && scheme !== 'https') {
        throw new McpConnectionLost(
          `MCP server ${this._config.id} 的 202 Location 仅接受 http/https scheme: ${location}`,
        );
      }
      // 异步响应仍属同一会话：GET 回带 Mcp-Session-Id（server 按会话鉴权/路由）
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (this._session_id !== null) {
        headers['Mcp-Session-Id'] = this._session_id;
      }
      const stream = await this._fetch_io(location, { method: 'GET', headers }, idle);
      const streamText = await this._read_limited(stream, idle);
      return await this._resolve_collected(streamText, 'text/event-stream', id);
    }
    const text = await this._read_limited(response, idle);
    return await this._resolve_collected(text, contentType, id);
  }

  /** 响应体文本读取（流式 + 字节上界：超限即 cancel 上游 fail-closed）。 */
  private async _read_limited(
    response: FetchResponseLike,
    idle: IdleAbort | null,
  ): Promise<string> {
    const limit = MAX_STDIO_FRAME_BYTES;
    const overflow = (): never => {
      throw new McpConnectionLost(
        `MCP server ${this._config.id} 响应体超限（> ${limit} 字节）`,
      );
    };
    return await read_body_bounded(
      response.body?.getReader() ?? null,
      response.text,
      limit,
      overflow,
      idle,
    );
  }

  /** 通知（fire-and-forget POST；失败静默——通知无响应语义）。 */
  async _post_notification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this._post({ jsonrpc: '2.0', method, params: params ?? {} });
    } catch {
      // 通知失败静默（连接断流由后续请求暴露）
    }
  }

  async list_tools(): Promise<McpToolRecord[]> {
    const result = await this._request('tools/list', {}, Math.round(CALL_TIMEOUT * 1000));
    if (typeof result !== 'object' || result === null) return [];
    const tools = (result as Record<string, unknown>)['tools'];
    return Array.isArray(tools) ? (tools as McpToolRecord[]) : [];
  }

  async call_tool(
    name: string,
    arguments_: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const result = await this._request(
      'tools/call',
      { name, arguments: arguments_ ?? {} },
      Math.round(CALL_TIMEOUT * 1000),
    );
    if (typeof result !== 'object' || result === null) {
      return { content: [{ type: 'text', text: String(result) }], isError: false };
    }
    return result as McpCallResult;
  }

  async ping(): Promise<void> {
    await this._request('ping', {}, Math.round(CALL_TIMEOUT * 1000));
  }

  async aclose(): Promise<void> {
    this._closed = true;
    // fetch 形态无进程可终止：会话销毁即清理（连接归网络栈）
  }
}
