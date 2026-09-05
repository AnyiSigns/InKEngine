/**
 * 前端宿主通道抽象（serve transport）：web 与引擎宿主之间唯一传输面。
 *
 * 形态随迁自旧侧前端的 transport 分界：宿主交互 = request(method, params)；
 * 事件流 = subscribe(topic, handler)。桌面 IPC 假设整体移除：生产通道 =
 * cli serve http/ws，本文件 = **接口契约 + 真传输实现**（配置 VITE_SERVE_URL
 * 即建立 JSON-RPC fetch 通道 + WebSocket 事件订阅）。未配置 serve 端点时
 * 回落 stub（available=false），调用方走夹具路径。
 *
 * - request 方法命名 = 引擎/宿主域方法（round_send / session_list / todo.get /
 *   ui_spec.apply / knowledge.list 等；serve 宿主按命令面解析同名方法，
 *   未注册方法回 JSON-RPC 错误信封，错误细节走 serve diag 面）；
 * - subscribe 事件 topic = ROUND_EVENT_TOPIC（引擎回合事件信封流：payload 为
 *   {type, thread_id, round_id, step_id, …}，经 app/activate 归约进 ChannelHub）；
 *   serve 侧的 state.* / events.* 细分通道由真 transport 实现承载本单一订阅；
 * - 错误信封 {code, message, trace_id}：前端只收错误信封不进细节，细节走
 *   serve diag 面。
 */

import { logger } from '@/shared/logger';

/** 统一错误信封形态（后端 {code, message, trace_id}）。 */
export interface EngineErrorEnvelope {
  code?: string;
  message?: string;
  trace_id?: string;
}

/** 统一命令失败处理（单通道面的错误收口）：
 * 提取 {code, message, trace_id} 记入日志后原样上抛——backendAdapter /
 * settings 全部命令调用共用此面，不再各自 catch 静默吞错或丢 trace_id。 */
export function handleEngineError(cmd: string, err: unknown): void {
  const envelope = (err ?? {}) as EngineErrorEnvelope;
  logger.warn('engine', `命令失败: ${cmd}`, {
    code: envelope.code ?? 'UNKNOWN',
    message: envelope.message ?? String(err),
    trace_id: envelope.trace_id ?? '',
  });
}

/** 宿主通道接口（cli serve http/ws 传输契约；真实现按本接口经 setServeChannel 注入）。 */
export interface ServeChannel {
  /** 通道可用性（false = serve 未连接/未就绪，调用方回落夹具路径）。 */
  available: boolean;
  /** serve http 基址（真通道注入时填写；stub 不填）。 */
  baseUrl?: string;
  /** 请求宿主方法（JSON-RPC 信封形态由 serve 承载；错误信封归一上抛）。 */
  request<T>(method: string, params?: unknown): Promise<T>;
  /** 订阅事件 topic（serve 推送；返回注销函数，宿主不可用返回空操作）。 */
  subscribe(topic: string, handler: (payload: unknown) => void): Promise<() => void>;
}

/** 事件信封载荷（serve 推送回调控件形态）。 */
export interface ServeEventEnvelope<T> {
  event: string;
  id: number;
  payload: T;
}

/** 引擎回合事件流订阅 topic（web 侧单一订阅；serve 事件面唯一入口）。 */
export const ROUND_EVENT_TOPIC = 'round_event';

/** serve 端点解析环境键（dev/集成期预置；如 http://127.0.0.1:8010）。 */
export const SERVE_URL_ENV_KEY = 'VITE_SERVE_URL';

/** serve 访问令牌环境键（与 URL 成对；serve listen 行同字段）。 */
export const SERVE_TOKEN_ENV_KEY = 'VITE_SERVE_TOKEN';

/** 通道未就绪的 stub：available=false，请求一律显式拒绝（不静默假成功）。 */
export function createUnavailableChannel(): ServeChannel {
  const unavailable = (): never => {
    throw new Error('宿主 serve 通道未就绪（web transport stub；配置 VITE_SERVE_URL 后注入真通道）');
  };
  return {
    available: false,
    request: unavailable as never,
    subscribe: async () => () => undefined,
  };
}

/** 把 base http url 规范化为 JSON-RPC 端点（去尾斜杠 + /rpc）。 */
function rpcEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/rpc`;
}

/** 从 base http url 推导 /ws 订阅端点（http→ws，保留 host/port）。 */
function wsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.replace(/^http/, 'ws') + '/ws';
}

/** serve ws topic 模式匹配（相等或 `前缀.*` 通配，镜像 serve 事件面）。 */
function topicMatches(topic: string, pattern: string): boolean {
  if (pattern === topic || pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    return topic.startsWith(pattern.slice(0, -1));
  }
  return false;
}

/** web 订阅 topic → serve ws topics（round_event = 引擎回合事件信封流）。 */
export function serveTopicsForWebTopic(topic: string): readonly string[] {
  if (topic === ROUND_EVENT_TOPIC) return ['events.*', 'state.*'];
  if (topic === '*') return ['events.*', 'state.*'];
  return [topic];
}

/** JSON-RPC 错误信封 → 统一错误形态（code 取字符串；HTTP 层错误自带 message）。 */
function toEnvelope(input: {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}): EngineErrorEnvelope {
  const code = input.code === undefined || input.code === null ? 'JSON_RPC_ERROR' : String(input.code);
  const message = typeof input.message === 'string' ? input.message : 'serve 请求失败';
  const data = (typeof input.data === 'object' && input.data !== null ? input.data : {}) as Record<string, unknown>;
  const traceId = typeof data['trace_id'] === 'string' ? data['trace_id'] : undefined;
  return { code, message, ...(traceId !== undefined ? { trace_id: traceId } : {}) };
}

export interface ServeChannelConfig {
  /** serve http 基址（如 http://127.0.0.1:18731）。 */
  baseUrl: string;
  /** 访问令牌（serve listen 行同字段；缺省走同源 cookie）。 */
  token?: string;
}

/** ws 客户端最小面（浏览器 WebSocket 兼容；测试可注入实现）。 */
export interface ServeWsLike {
  onopen: (() => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(payload: string): void;
  close(): void;
}

export type ServeWsCtor = new (url: string) => ServeWsLike;

export interface ServeChannelDeps {
  fetchImpl?: typeof fetch;
  WebSocketImpl?: ServeWsCtor;
}

/** 真 serve 通道（fetch JSON-RPC + WebSocket 订阅）；依赖可注入便于测试。 */
export function createServeChannel(config: ServeChannelConfig, deps: ServeChannelDeps = {}): ServeChannel {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const token = config.token ?? '';
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const WebSocketImpl = deps.WebSocketImpl ?? (globalThis.WebSocket as ServeWsCtor | undefined);
  let seq = 0;

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== '') headers['authorization'] = `Bearer ${token}`;
    return headers;
  };

  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    seq += 1;
    const id = seq;
    let response: Response;
    try {
      response = await fetchImpl(rpcEndpoint(baseUrl), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
      });
    } catch (error) {
      throw { code: 'NETWORK', message: `serve 不可达: ${String(error instanceof Error ? error.message : error)}` };
    }
    let body: { error?: { code?: unknown; message?: unknown; data?: unknown } } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      if (!response.ok) {
        throw { code: `HTTP_${response.status}`, message: `serve 返回 ${response.status}` };
      }
      throw { code: 'BAD_RESPONSE', message: 'serve 响应非 JSON' };
    }
    if (!response.ok) {
      const envelope = toEnvelope({
        code: `HTTP_${response.status}`,
        message: typeof body.error?.message === 'string' ? body.error.message : `serve 返回 ${response.status}`,
      });
      throw envelope;
    }
    if (body.error) throw toEnvelope(body.error);
    return (body as unknown as { result: T }).result;
  };

  /** 打开一条 ws 订阅：注册回调后 resolve 注销函数；连接失败回落空操作。 */
  const subscribe = (topic: string, handler: (payload: unknown) => void): Promise<() => void> => {
    if (WebSocketImpl === undefined) return Promise.resolve(() => undefined);
    const topics = serveTopicsForWebTopic(topic);
    const wsUrl = token !== '' ? `${wsEndpoint(baseUrl)}?token=${encodeURIComponent(token)}` : wsEndpoint(baseUrl);
    let ws: ServeWsLike | null = null;
    let closed = false;
    let open = false;
    try {
      ws = new WebSocketImpl(wsUrl);
    } catch {
      return Promise.resolve(() => undefined);
    }
    ws.onopen = () => {
      if (closed) return;
      open = true;
      ws?.send(JSON.stringify({ type: 'subscribe', topics: [...topics] }));
    };
    ws.onmessage = (event: MessageEvent) => {
      if (closed || !open) return;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const frame = parsed as { type?: unknown; topic?: unknown; data?: unknown };
      if (frame.type !== 'event' || typeof frame.topic !== 'string') return;
      if (!topics.some((pattern) => topicMatches(frame.topic as string, pattern))) return;
      seq += 1;
      const envelope: ServeEventEnvelope<unknown> = {
        event: frame.topic as string,
        id: seq,
        payload: frame.data,
      };
      try {
        handler(envelope);
      } catch (error) {
        logger.warn('transport', 'serve 事件回调失败', { err: String(error) });
      }
    };
    ws.onerror = () => {
      logger.warn('transport', 'serve ws 连接错误', { url: wsUrl });
    };
    ws.onclose = () => {
      closed = true;
    };
    return Promise.resolve(() => {
      if (closed) return;
      closed = true;
      try {
        ws?.close();
      } catch {
        // 连接已关闭
      }
    });
  };

  return {
    available: true,
    baseUrl,
    request,
    subscribe,
  };
}

/** 由环境解析 serve 通道：配置 VITE_SERVE_URL = 真通道，否则 stub。 */
export function resolveServeChannel(env?: {
  [SERVE_URL_ENV_KEY]?: string;
  [SERVE_TOKEN_ENV_KEY]?: string;
}): ServeChannel {
  const url = env?.[SERVE_URL_ENV_KEY];
  if (!url || url.trim() === '') return createUnavailableChannel();
  return createServeChannel({ baseUrl: url.trim(), token: env?.[SERVE_TOKEN_ENV_KEY] ?? '' });
}

let serveChannel: ServeChannel = createUnavailableChannel();

/** 注入真 serve 通道（装配期/集成测试调用一次；未注入 = stub 默认）。 */
export function setServeChannel(channel: ServeChannel): void {
  serveChannel = channel;
}

/** 当前生效的 serve 通道（backendAdapter 装配与事件订阅共用同一实例）。 */
export function getServeChannel(): ServeChannel {
  return serveChannel;
}

/** 订阅宿主事件流（经 serve 通道；事件名如 ROUND_EVENT_TOPIC；通道不可用
 * 返回空操作，调用方回落夹具路径）。 */
export async function listenHostEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!serveChannel.available) return () => undefined;
  return serveChannel.subscribe(event, (raw) => {
    const typed = raw as ServeEventEnvelope<T>;
    handler(typed?.payload ?? (raw as T));
  });
}
