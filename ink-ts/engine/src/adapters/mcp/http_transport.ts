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
 * 差异声明：本实现只承载请求/响应对偶（list_tools/call_tool/ping 的上界
 * 语义齐备），不维护常驻 GET 通知流——server→client 单向通知/请求在纯
 * 请求-响应使用面上不产生；如需常驻推送面，宿主应提供会话级长连接
 * 传输（stdio/in_memory）。
 */
import { McpConnectionLost, McpToolImportError, RpcError } from './_errors.js';
import {
  CALL_TIMEOUT,
  CONNECT_TIMEOUT,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
} from './_framing.js';
import { with_timeout } from './_rpc_channel.js';
import type { McpCallResult, McpJsonRpcMessage, McpToolRecord, RawMcpSession } from './_types.js';
import type { McpServerConfig } from './config.js';

/** fetch 响应形态（网络 seam 的最小面）。 */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
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

const _sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function _wrap_fetch(fetchImpl: typeof globalThis.fetch): FetchLike {
  return async (url, init) => {
    const response = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    return {
      status: response.status,
      headers: { get: (name: string) => response.headers.get(name) },
      text: async () => await response.text(),
    };
  };
}

/** SSE data 事件解析（MCP streamable HTTP 的流式响应载体）。 */
export function parse_sse_events(text: string): string[] {
  const events: string[] = [];
  let data: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      if (data.length > 0) {
        events.push(data.join('\n'));
        data = [];
      }
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length > 0) events.push(data.join('\n'));
  return events;
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
    const response = await this._post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
      },
    });
    const sessionHeader = response.headers.get('mcp-session-id');
    if (sessionHeader !== null && sessionHeader !== '') {
      this._session_id = sessionHeader;
    }
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const init = await this._resolve_collected(text, contentType, id);
    this._server_info =
      typeof init === 'object' && init !== null
        ? (init as Record<string, unknown>)
        : null;
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
    const future = this._roundtrip(message, id);
    return await with_timeout(future, timeoutMs, `MCP server ${this._config.id} 请求超时`);
  }

  private async _roundtrip(
    message: McpJsonRpcMessage,
    id: number,
  ): Promise<unknown> {
    const response = await this._post(message);
    const contentType = response.headers.get('content-type') ?? '';
    // 202 = 请求已受理待异步响应：按 Location 拉流读取配对消息
    if (response.status === 202) {
      const location = response.headers.get('location');
      if (location === null) {
        throw new McpConnectionLost(
          `MCP server ${this._config.id} 返回 202 但缺 Location（无法拉取异步响应）`,
        );
      }
      const stream = await this._fetch(location, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      });
      const streamText = await stream.text();
      return await this._resolve_collected(streamText, 'text/event-stream', id);
    }
    const text = await response.text();
    return await this._resolve_collected(text, contentType, id);
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
