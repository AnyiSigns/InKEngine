/**
 * JSON-RPC 消息通道（MCP 协议的消息层驱动）——镜像 Python mcp_client.py
 * 自写传输的请求表/分发语义，但以 TS 单一事件循环表达（无线程私有 loop：
 * Node 进程即引擎生命周期，无跨 loop 亲和问题）。
 *
 * RpcChannel 持有一个消息级双工端口：request 按自增 id 登记挂起表并写
 * 请求；读循环按 id 配对响应、应答 server→client 请求（ping/roots/list，
 * 未知方法回 -32601）、忽略通知（progress 等）。读侧 EOF/异常 → 挂起表
 * 全部以连接断流失败（fail-closed）。
 *
 * create_message_duplex_pair 供 in_memory 传输与测试构造成对消息端口
 * （内存队列承载，零网络/进程）。
 */
import { McpConnectionLost, RpcError, RpcTimeout } from './_errors.js';
import type { McpJsonRpcMessage, McpMessagePort } from './_types.js';

/** 请求/通知带上界（无响应不无限挂起）。 */
export function with_timeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RpcTimeout(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (exc: unknown) => {
        clearTimeout(timer);
        reject(exc);
      },
    );
  });
}

interface _Pending {
  resolve: (value: unknown) => void;
  reject: (exc: unknown) => void;
  method: string;
}

/**
 * JSON-RPC 消息通道：请求/响应按 id 配对，server→client 请求就地应答，
 * 通知忽略；读侧断流（EOF/异常）时挂起表全部失败（fail-closed）。
 */
export class RpcChannel {
  _pending: Map<number, _Pending> = new Map();
  private _next_id = 1;
  private _closed = false;
  private _read_ended = false;
  private _read_loop: Promise<void> | null = null;
  private readonly _server_id: string;
  private readonly _port: McpMessagePort;

  constructor(port: McpMessagePort, server_id: string) {
    this._port = port;
    this._server_id = server_id;
  }

  /** 启动读循环（open 期调用一次；断流/关闭收敛为挂起表失败）。 */
  start(): void {
    if (this._read_loop !== null) return;
    this._read_loop = this._run_read_loop();
  }

  async _run_read_loop(): Promise<void> {
    let read_exc: unknown = null;
    try {
      for await (const msg of this._port.read) {
        if (msg === null || msg === undefined) continue;
        this._dispatch(msg);
      }
    } catch (exc) {
      read_exc = exc;
    }
    // 读侧终止（EOF 或异常）：标记结束 + 未关的挂起请求以连接断流收敛
    this._read_ended = true;
    if (!this._closed) {
      const err = read_exc ?? new McpConnectionLost(`MCP server ${this._server_id} 连接已关闭`);
      this._fail_pending(err);
    }
  }

  _dispatch(msg: McpJsonRpcMessage): void {
    if (msg['id'] !== undefined && msg['method'] === undefined) {
      // 响应：按 id 配对挂起表
      const pending = this._pending.get(msg['id'] as number);
      if (pending !== undefined) {
        this._pending.delete(msg['id'] as number);
        const error = msg['error'];
        if (error !== null && error !== undefined) {
          const code =
            typeof error['code'] === 'number' ? error['code'] : -32603;
          pending.reject(
            new RpcError(code, typeof error['message'] === 'string' ? error['message'] : ''),
          );
        } else {
          pending.resolve(msg['result']);
        }
      }
      return;
    }
    if (msg['method'] !== undefined && msg['id'] !== undefined) {
      // server→client 请求：应答 ping/roots/list，未知方法回 -32601
      void this._handle_server_request(msg);
      return;
    }
    // 无 id = 通知（progress 等）：记录不处理
  }

  async _handle_server_request(msg: McpJsonRpcMessage): Promise<void> {
    const method = msg['method'] as string;
    const id = msg['id'];
    let payload: McpJsonRpcMessage;
    if (method === 'ping') {
      payload = { jsonrpc: '2.0', id, result: {} };
    } else if (method === 'roots/list') {
      payload = { jsonrpc: '2.0', id, result: { roots: [] } };
    } else {
      payload = {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${String(method)}` },
      };
    }
    try {
      await this._port.write(payload);
    } catch {
      // 应答失败（连接已断）静默：读侧断流会收敛挂起表
    }
  }

  /** 请求（挂起表登记 + 超时上界；超时精确摘除挂起表项）。 */
  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this._closed) {
      throw new McpConnectionLost(`MCP server ${this._server_id} 连接已关闭`);
    }
    const id = this._next_id;
    this._next_id += 1;
    if (this._read_ended) {
      // 读侧在请求登记前已结束（进程瞬时退出/启动即崩的竞态）：立即收敛
      throw new McpConnectionLost(`MCP server ${this._server_id} 连接已关闭`);
    }
    const message: McpJsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params: params ?? {},
    };
    const future = new Promise<unknown>((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      this._port.write(message).catch((exc: unknown) => {
        this._pending.delete(id);
        reject(exc);
      });
    });
    try {
      return await with_timeout(future, timeoutMs, `MCP server ${this._server_id} 请求超时`);
    } catch (exc) {
      if (exc instanceof RpcTimeout) {
        this._pending.delete(id);
      }
      throw exc;
    }
  }

  /** 通知（fire-and-forget；发送失败静默——通知无响应语义）。 */
  notify(method: string, params: Record<string, unknown>): void {
    if (this._closed) return;
    this._port
      .write({ jsonrpc: '2.0', method, params: params ?? {} })
      .catch(() => undefined);
  }

  /** 关闭通道：挂起表以连接断流失败（读循环随后自行收敛）。 */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    const closePort = this._port.close;
    if (closePort !== undefined) {
      void Promise.resolve(closePort.call(this._port));
    }
    this._fail_pending(new McpConnectionLost(`MCP server ${this._server_id} 连接已关闭`));
  }

  _fail_pending(exc: unknown): void {
    const pending = this._pending;
    this._pending = new Map();
    for (const item of pending.values()) item.reject(exc);
  }

  get closed(): boolean {
    return this._closed;
  }

  async join(): Promise<void> {
    if (this._read_loop !== null) await this._read_loop;
  }
}

// ── 内存消息队列（成对端口与测试桩的收方向承载）────────────────────────

class _MemoryQueue {
  private _items: McpJsonRpcMessage[] = [];
  private _waiters: Array<(value: McpJsonRpcMessage | undefined) => void> = [];
  private _closed = false;

  push(message: McpJsonRpcMessage): void {
    if (this._closed) return;
    const waiter = this._waiters.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }
    this._items.push(message);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    const waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) waiter(undefined);
  }

  private async _take(): Promise<McpJsonRpcMessage | undefined> {
    if (this._items.length > 0) return this._items.shift();
    if (this._closed) return undefined;
    return await new Promise<McpJsonRpcMessage | undefined>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  async *readable(): AsyncGenerator<McpJsonRpcMessage> {
    for (;;) {
      const message = await this._take();
      if (message === undefined) return;
      yield message;
    }
  }
}

/** 构造成对消息端口（in_memory 传输/测试桩：client 与 server 各执一端）。 */
export function create_message_duplex_pair(): [McpMessagePort, McpMessagePort] {
  const a = new _MemoryQueue();
  const b = new _MemoryQueue();
  const port = (selfQueue: _MemoryQueue, peerQueue: _MemoryQueue): McpMessagePort => ({
    read: selfQueue.readable(),
    write: async (message: McpJsonRpcMessage) => {
      peerQueue.push(message);
    },
    close: () => {
      selfQueue.close();
    },
  });
  return [port(a, b), port(b, a)];
}
