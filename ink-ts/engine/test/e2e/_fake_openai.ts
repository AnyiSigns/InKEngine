/**
 * e2e 进程内假 OpenAI 兼容服务（node:http，端口 0 动态绑定，零外网）。
 *
 * 镜像 OpenAI /chat/completions 协议的最小面：
 * - 非流式（stream:false）：返回 {choices:[{message:{role,content},finish_reason}], usage}；
 * - 流式（stream:true）：SSE 逐字 content 增量 → 末帧 finish_reason=stop →
 *   usage 帧（choices:[]）→ data: [DONE]；
 * - 请求全量留痕（method/url/headers/body）供协议化断言；
 * - close() 幂等：销毁全部已登记 socket + 关闭服务（每测试独立实例）。
 *
 * 断言友好：content/usage 由构造参数决定；坏 JSON 请求显式 400（走适配器
 * 错误分类，绝不吞）。
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

/** 一次请求的留痕（headers 键 Node 侧已小写归一）。 */
export interface OpenAIRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 假服务可配置项（默认零参数可直接起服务）。 */
export interface FakeOpenAIOptions {
  /** 回复正文（非流式与流式共用同一内容）。 */
  content?: string;
  /** 终止原因（默认 stop）。 */
  finish_reason?: string;
  /** usage 元数据（默认空对象；流式经 usage 帧下发）。 */
  usage?: Record<string, number> | null;
}

/** OpenAI 兼容假服务（真实 TCP 监听，本地回环）。 */
export class FakeOpenAIServer {
  readonly requests: OpenAIRequestRecord[] = [];
  private _server: http.Server | null = null;
  private _sockets = new Set<Socket>();
  private _baseUrl: string | null = null;
  private readonly _content: string;
  private readonly _finish_reason: string;
  private readonly _usage: Record<string, number>;

  constructor(options: FakeOpenAIOptions = {}) {
    this._content = options.content ?? 'e2e-reply';
    this._finish_reason = options.finish_reason ?? 'stop';
    this._usage = options.usage ?? { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 };
  }

  /** 启动监听（127.0.0.1 + 端口 0），返回 base_url（含 /v1）。 */
  async start(): Promise<string> {
    if (this._baseUrl !== null) return this._baseUrl;
    const server = http.createServer((req, res) => this._handle(req, res));
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
    if (this._baseUrl === null) {
      throw new Error('FakeOpenAIServer 尚未 start()（先 await start() 取 baseUrl）');
    }
    return this._baseUrl;
  }

  /** 请求计数（缓存/重试语义断言）。 */
  get requestCount(): number {
    return this.requests.length;
  }

  /** 幂等关停：先销毁连接再关闭服务（不悬挂 keep-alive socket）。 */
  async close(): Promise<void> {
    for (const socket of this._sockets) socket.destroy();
    this._sockets.clear();
    const server = this._server;
    this._server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 统一请求入口：读 body → 留痕 → 按 stream 分流。 */
  private _handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    void this._readBody(req).then(
      (body) => {
        this.requests.push(this._record(req, body));
        if (body['stream'] === true) {
          this._writeStream(res, body);
        } else {
          this._writeCompletion(res, body);
        }
      },
      () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '非法请求体', code: 'bad_request' } }));
      },
    );
  }

  private _record(req: http.IncomingMessage, body: Record<string, unknown>): OpenAIRequestRecord {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = String(value);
    }
    return { method: req.method ?? 'GET', url: req.url ?? '', headers, body };
  }

  /** 整读请求体（body 上限 1MB；超限按非法请求抛）。 */
  private _readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          reject(new Error('请求体过大'));
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
          reject(new Error('非 JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /** 非流式补全响应：message + finish_reason + usage。 */
  private _writeCompletion(res: http.ServerResponse, body: Record<string, unknown>): void {
    const payload = {
      id: 'chatcmpl-e2e',
      object: 'chat.completion',
      model: body['model'] ?? 'e2e-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: this._content },
          finish_reason: this._finish_reason,
        },
      ],
      usage: this._usage,
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  /** 流式 SSE：逐字 content 增量帧 → finish 帧 → usage 帧 → [DONE]。 */
  private _writeStream(res: http.ServerResponse, body: Record<string, unknown>): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const token of [...this._content]) {
      this._sse(res, {
        choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
      });
    }
    this._sse(res, {
      choices: [{ index: 0, delta: {}, finish_reason: this._finish_reason }],
    });
    this._sse(res, { choices: [], usage: this._usage });
    res.write('data: [DONE]\n\n');
    res.end();
  }

  /** 写一条 SSE data 帧（`data: <json>` + 空行）。 */
  private _sse(res: http.ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}
