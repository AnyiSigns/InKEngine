/**
 * MCP 适配器内部形态（镜像 Python mcp_client.py 的类型面）。
 *
 * - McpJsonRpcMessage：JSON-RPC 2.0 消息（请求/响应/通知/error 统一形态）；
 * - McpMessagePort：内存传输的消息级端口（read = 收方向异步可迭代，
 *   write = 发方向）——TS 无 mcp SDK 的 ClientSession/内存流对抽象，
 *   以「消息级双工端口」承载 in_memory 传输（宿主注入 server_factory，
 *   create_message_duplex_pair 供宿主/测试构造成对端口）；
 * - RawMcpSession：传输级会话能力（list_tools/call_tool/ping/aclose，
 *   以 dict 形态读写，不经文本提取）——SdkSession 在其上做业务收敛。
 *
 * stdio 进程 spawn seam：默认走 node:child_process（Windows 隐藏窗口），
 * 单元测试注入假进程（内存流对）即确定性验证协议，无需真实进程。
 */
import type { Readable, Writable } from 'node:stream';

/** MCP 工具描述（dict 形态；input_schema=inputSchema 双字段兼容）。 */
export interface McpToolRecord {
  name?: unknown;
  description?: unknown;
  input_schema?: unknown;
  inputSchema?: unknown;
  [key: string]: unknown;
}

/** MCP 调用结果（dict 形态；is_error/isError 双字段兼容，content 项 dict）。 */
export interface McpCallResult {
  content?: unknown;
  is_error?: unknown;
  isError?: unknown;
  [key: string]: unknown;
}

/** JSON-RPC 2.0 消息（请求/响应/通知/error 统一形态）。 */
export interface McpJsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

/** 消息级双工端口（in_memory 传输的收发面）。 */
export interface McpMessagePort {
  /** 收方向：server → client 的消息流（响应/通知/server→client 请求）。 */
  read: AsyncIterable<McpJsonRpcMessage>;
  /** 发方向：client → server 的请求/通知写入。 */
  write(message: McpJsonRpcMessage): Promise<void>;
  /** 可选关闭钩子：终止收方向（读循环据此结束；stdio 形态无此概念）。 */
  close?(): void | Promise<void>;
}

/** in_memory server 工厂签名：() -> 消息级端口（宿主注入内嵌 server）。 */
export type ServerFactory = () => McpMessagePort | Promise<McpMessagePort>;

/** 传输级会话能力（dict 形态，不经文本提取；会话层在此上收敛）。 */
export interface RawMcpSession {
  list_tools(): Promise<McpToolRecord[]>;
  call_tool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult>;
  ping(): Promise<void>;
  aclose(): Promise<void>;
}

/** spawn 产出的子进程抽象（stdio 全管道承载通信）。 */
export interface SpawnedMcpProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  /** 销毁三条管道（失败启动的清理路径用；可选）。 */
  destroy_io?(): void;
  /** 进程退出（close）；spawn 失败（ENOENT 等）时 reject。 */
  exit: Promise<{ code: number | null; signal: string | null }>;
}

/** spawn seam：默认 node:child_process.spawn，测试注入假进程。 */
export type SpawnSeam = (
  command: string,
  args: readonly string[],
  opts: { env?: NodeJS.ProcessEnv | null; windows_hide?: boolean },
) => SpawnedMcpProcess;

/** 异步队列（写侧排队 + 哨兵关闭；镜像 asyncio.Queue[bytes | None]）。 */
export class AsyncQueue<T> {
  private _items: T[] = [];
  private _waiters: Array<(value: T | undefined) => void> = [];
  private _closed = false;

  push(value: T): void {
    if (this._closed) return;
    const waiter = this._waiters.shift();
    if (waiter !== undefined) {
      waiter(value);
      return;
    }
    this._items.push(value);
  }

  async next(): Promise<T | undefined> {
    if (this._items.length > 0) return this._items.shift();
    if (this._closed) return undefined;
    return await new Promise<T | undefined>((resolve) => {
      this._waiters.push(resolve);
    });
  }

  close(): void {
    this._closed = true;
    const waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) waiter(undefined);
  }
}
