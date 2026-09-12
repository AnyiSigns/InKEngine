/**
 * host 测试假 OpenAI 兼容服务（node:http 本地回环；镜像 engine e2e 假服务
 * 的协议最小面——非流式 + SSE 流式 + 请求留痕）。engine 测试助手在
 * engine/test（包内不导出），host 侧复用同形态进程内实现。
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

export interface OpenAIRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface FakeOpenAIOptions {
  /** 固定回复内容；数组 = 按请求序取用（越界回落末条；多轮剧本用）。 */
  content?: string | string[];
  finish_reason?: string;
  usage?: Record<string, number> | null;
  /** 响应前固定延迟（毫秒；测「运行中中止/注入」时序的在途窗口放大）。 */
  delayMs?: number;
  /** 工具调用剧本：单个 = 所有响应都带该工具调用；数组 = 按请求序取用
   *  （null 项 = 该轮无工具调用；越界回落末条）。 */
  toolCall?: { name: string; arguments?: string } | null | Array<{ name: string; arguments?: string } | null>;
}

/** OpenAI 兼容假服务（真实 TCP 监听本地回环；每测试独立实例）。 */
export class FakeOpenAIServer {
  readonly requests: OpenAIRecord[] = [];
  private _server: http.Server | null = null;
  private _sockets = new Set<Socket>();
  private _baseUrl: string | null = null;
  private readonly _content: string[];
  private readonly _finish_reason: string;
  private readonly _usage: Record<string, number>;
  private readonly _delayMs: number;
  private readonly _toolCalls: Array<{ name: string; arguments?: string } | null>;

  constructor(options: FakeOpenAIOptions = {}) {
    const raw = options.content ?? 'host-reply';
    this._content = Array.isArray(raw) ? raw : [raw];
    this._finish_reason = options.finish_reason ?? 'stop';
    this._usage = options.usage ?? { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 };
    this._delayMs = options.delayMs ?? 0;
    this._toolCalls = options.toolCall === undefined
      ? [null]
      : Array.isArray(options.toolCall)
        ? options.toolCall
        : [options.toolCall];
  }

  /** 当前请求序的工具调用（越界回落末条；null = 无工具调用）。 */
  private toolCallFor(index: number): { name: string; arguments?: string } | null {
    return this._toolCalls[Math.min(index, this._toolCalls.length - 1)] ?? null;
  }

  /** 当前请求序的回复内容（越界回落末条，保证多轮剧本不空答）。 */
  private contentFor(index: number): string {
    return this._content[Math.min(index, this._content.length - 1)] ?? '';
  }

  async start(): Promise<string> {
    if (this._baseUrl !== null) return this._baseUrl;
    const server = http.createServer((req, res) => void this._handle(req, res));
    server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
    });
    this._server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    this._baseUrl = `http://127.0.0.1:${port}/v1`;
    return this._baseUrl;
  }

  get baseUrl(): string {
    if (this._baseUrl === null) throw new Error('FakeOpenAIServer 未 start()');
    return this._baseUrl;
  }

  get requestCount(): number {
    return this.requests.length;
  }

  async close(): Promise<void> {
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    const server = this._server;
    this._server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown> = {};
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad request', code: 'bad_request' } }));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) headers[key] = String(value);
    this.requests.push({ method: req.method ?? 'GET', url: req.url ?? '', headers, body });
    if (this._delayMs > 0) {
      const delay = this._delayMs;
      setTimeout(() => {
        this._respond(body, res);
      }, delay);
      return;
    }
    this._respond(body, res);
  }

  private _respond(body: Record<string, unknown>, res: http.ServerResponse): void {
    // 延迟响应可能落在 close() 之后（socket 已毁）——写前判活，避免悬挂异常
    if (res.writableEnded || res.destroyed) return;
    if (body['stream'] === true) this._writeStream(res, body);
    else this._writeCompletion(res, body);
  }

  private _writeCompletion(res: http.ServerResponse, body: Record<string, unknown>): void {
    const payload = {
      id: 'chatcmpl-host-test',
      object: 'chat.completion',
      model: body['model'] ?? 'host-test-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: this.contentFor(this.requests.length - 1) },
          finish_reason: this._finish_reason,
        },
      ],
      usage: this._usage,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  private _writeStream(res: http.ServerResponse, body: Record<string, unknown>): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const content = this.contentFor(this.requests.length - 1);
    const toolCall = this.toolCallFor(this.requests.length - 1);
    if (toolCall !== null) {
      // 工具调用帧（compat 协议 delta.tool_calls；arguments 整段单帧交付）
      this._sse(res, {
        choices: [
          {
            index: 0,
            delta: {
              content: '',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${this.requests.length}`,
                  type: 'function',
                  function: {
                    name: toolCall.name,
                    arguments: toolCall.arguments ?? '{}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    }
    for (const token of [...content]) {
      this._sse(res, { choices: [{ index: 0, delta: { content: token }, finish_reason: null }] });
    }
    this._sse(res, { choices: [{ index: 0, delta: {}, finish_reason: this._finish_reason }] });
    this._sse(res, { choices: [], usage: this._usage });
    res.write('data: [DONE]\n\n');
    res.end();
  }

  private _sse(res: http.ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}
