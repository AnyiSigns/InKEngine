/**
 * serve 形态：本地 http/ws（鉴权）+ 静态托管/Vite 代理占位 + 事件订阅通道。
 *
 * 端点（web 侧 serve transport 对接面）：
 * - GET  /health              健康检查（回环免鉴权）→ {ok:true,...}；
 * - POST /rpc                 JSON-RPC 2.0 单请求（host.ping/info + host
 *   bridge 方法面）；鉴权见 serve_auth.ts；信封错误只回通用、细节走 stderr
 *   diag；rounds 与 approval 命令成功后广播 state.round 状态事件；
 * - WS   /ws?token=<token>    事件订阅（state.* 与 events.*，帧协议见 serve_ws.ts）；
 * - GET  /                    静态托管（缺省 cli/assets 占位；--static 覆盖）
 *   + Set-Cookie ink_ts_token（同源浏览器免显式 token）；
 * - 非静态 GET/HEAD + --vite <url> → Vite dev 代理（web 开发连接面）。
 *
 * 启动成功打印一行 listen JSON 到 stdout（url/ws/token）；SIGINT/SIGTERM
 * 优雅关停（先关 ws/http 再 dispose host，2s 兜底强退）。
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HostHandle } from '@ink-ts/host';

import type { CliOptions } from './argv.js';
import { attachEngineTransport } from './engine_attach.js';
import { EventHub } from './events_hub.js';
import { buildHandlers } from './handlers.js';
import { assembleCliHost } from './host.js';
import { handleRequest, parseLine } from './rpc.js';
import { isAuthorized } from './serve_auth.js';
import { attachWsChannel } from './serve_ws.js';

/** 缺省本地监听端口（--port 0 = 系统分配）。 */
export const DEFAULT_SERVE_PORT = 18731;
/** /rpc 请求体上限（JSON-RPC 信封；超限 413）。 */
const MAX_RPC_BODY_BYTES = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const DEFAULT_ASSETS_DIR = fileURLToPath(new URL('../assets', import.meta.url));

export interface StreamLike {
  write(text: string): unknown;
}

export interface ServeIo {
  stdout: StreamLike;
  stderr: StreamLike;
}

interface ServeRuntime {
  handle: HostHandle;
  hub: EventHub;
  token: string;
  autoApprove: boolean;
  staticDir: string;
  viteProxy: string | null;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown, cors = false): void {
  if (cors) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-ink-token');
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function setTokenCookie(res: ServerResponse, token: string): void {
  res.setHeader('Set-Cookie', `ink_ts_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
}

function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  return new Promise((finish) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413 });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, status: 400 }));
  });
}

/** /rpc：JSON-RPC 单请求处理（notification 不回包；rounds 结果广播状态事件）。 */
async function handleRpc(req: IncomingMessage, res: ServerResponse, rt: ServeRuntime): Promise<void> {
  if (req.method !== 'POST') {
    jsonResponse(res, 405, { error: 'method not allowed' }, true);
    return;
  }
  const body = await readBody(req, MAX_RPC_BODY_BYTES);
  if (!body.ok) {
    jsonResponse(res, body.status, { error: 'body too large' }, true);
    return;
  }
  const handlers = buildHandlers({ bridge: rt.handle.bridge });
  const parsed = parseLine(body.text);
  const response = 'error' in parsed ? parsed.error : await handleRequest(parsed.request, handlers, { autoApprove: rt.autoApprove });
  const request = 'error' in parsed ? null : parsed.request;
  if (response.result !== undefined && typeof response.result === 'object') {
    const record = response.result as { thread_id?: unknown; round_id?: unknown; trace_id?: unknown };
    if (typeof record.thread_id === 'string') {
      rt.hub.publish(`state.round.${record.thread_id}`, {
        thread_id: record.thread_id,
        round_id: record.round_id ?? null,
        trace_id: record.trace_id ?? null,
        state: 'done',
      });
    }
  }
  if (request === null || request.id !== undefined) {
    jsonResponse(res, 200, response, true);
  } else {
    // notification：不回包（与 stdio 语义一致）；204 空响应体
    res.writeHead(204);
    res.end();
  }
}

function statDir(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 静态文件服务（路径穿越防护：解码后必须落在 root 内）。 */
function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, token: string): boolean {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  const pathname = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  if (pathname.includes('\0')) return false;
  let target = normalize(join(root, pathname));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(rootPrefix)) {
    jsonResponse(res, 403, { ok: false, error: 'forbidden' });
    return true;
  }
  if (statDir(target)) target = join(target, 'index.html');
  if (!existsSync(target)) return false;
  setTokenCookie(res, token);
  res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = createReadStream(target);
  stream.on('error', () => {
    jsonResponse(res, 500, { error: 'internal error' });
  });
  stream.pipe(res);
  return true;
}

/** Vite dev 代理（目标不可达 → 502 JSON；web 开发期连接面）。 */
async function proxyToVite(req: IncomingMessage, res: ServerResponse, target: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return false;
  try {
    const url = new URL(req.url ?? '/', target);
    const upstream = await fetch(url, {
      method,
      headers: { accept: req.headers['accept'] ?? '*/*', 'user-agent': 'ink-ts-cli-serve' },
    });
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'text/html; charset=utf-8',
    });
    res.end(await upstream.text());
    return true;
  } catch {
    jsonResponse(res, 502, { ok: false, error: `Vite dev 代理不可达: ${target}` });
    return true;
  }
}

async function route(req: IncomingMessage, res: ServerResponse, rt: ServeRuntime): Promise<void> {
  const pathname = (req.url ?? '/').split('?')[0] ?? '/';
  if (pathname === '/health') {
    setTokenCookie(res, rt.token);
    jsonResponse(res, 200, { ok: true, service: 'ink-ts-cli-serve', mode: 'serve' });
    return;
  }
  if (pathname === '/rpc') {
    if (!isAuthorized(req, rt.token)) {
      jsonResponse(res, 401, { error: 'unauthorized' }, true);
      return;
    }
    await handleRpc(req, res, rt);
    return;
  }
  if (serveStatic(req, res, rt.staticDir, rt.token)) return;
  if (rt.viteProxy !== null && (req.method === 'GET' || req.method === 'HEAD')) {
    await proxyToVite(req, res, rt.viteProxy);
    return;
  }
  jsonResponse(res, 404, { ok: false, error: `not found: ${pathname}` });
}

export interface ServeStartResult {
  url: string;
  wsUrl: string;
  token: string;
  close(): Promise<void>;
}

/** 装配 host + 起 http/ws 服务；成功即打印 listen 行到 stdout。 */
export async function startServe(options: CliOptions, io: ServeIo): Promise<ServeStartResult> {
  const serveFlags = options.serve;
  const host = serveFlags?.host ?? '127.0.0.1';
  const port = serveFlags?.port ?? DEFAULT_SERVE_PORT;
  const token = serveFlags?.token ?? randomUUID().replace(/-/g, '');
  const staticRaw = serveFlags?.static_dir ?? DEFAULT_ASSETS_DIR;
  const staticDir = isAbsolute(staticRaw) ? staticRaw : resolve(staticRaw);
  const viteProxy = serveFlags?.vite_proxy ?? null;

  const handle = await assembleCliHost(options);
  const hub = new EventHub();
  const detach = attachEngineTransport(handle.runtime, hub);
  const rt: ServeRuntime = { handle, hub, token, autoApprove: options.approve, staticDir, viteProxy };

  let closed = false;
  const stop = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await wsChannel.close();
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
    detach();
    try {
      await handle.dispose();
    } catch {
      // dispose 失败不影响关停结果
    }
  };

  const server: HttpServer = createServer((req, res) => {
    void route(req, res, rt).catch(() => {
      jsonResponse(res, 500, { error: 'internal error' }, pathnameIsRpc(req.url));
    });
  });
  const wsChannel = attachWsChannel(server, hub, token);

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, host, () => resolveListen());
    });
  } catch (error) {
    await stop();
    throw error;
  }
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  const url = `http://${host}:${boundPort}`;
  const wsUrl = `ws://${host}:${boundPort}/ws`;
  io.stdout.write(`${JSON.stringify({ event: 'listen', mode: 'serve', url, ws: wsUrl, token })}\n`);
  return { url, wsUrl, token, close: stop };
}

function pathnameIsRpc(url: string | undefined): boolean {
  return (url ?? '').startsWith('/rpc');
}

/** serve 入口：启动成功后等待信号优雅关停（长驻进程）。 */
export async function runServe(options: CliOptions, io: ServeIo): Promise<void> {
  const started = await startServe(options, io);
  io.stderr.write(`[serve] listening ${started.url} ws=${started.wsUrl} token=${started.token}\n`);
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    io.stderr.write(`[serve] ${signal} 收到，优雅关停\n`);
    void started.close().then(() => {
      const force = setTimeout(() => process.exit(0), 2000);
      force.unref();
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export { DEFAULT_ASSETS_DIR };
