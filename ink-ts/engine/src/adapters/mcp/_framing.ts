/**
 * MCP stdio 帧协议面（镜像 Python mcp_client.py 的自写分帧）。
 *
 * 本环境 MCP stdio 生态（SDK 2.x 客户端/服务端、内置执行件 inkling_exec）
 * 均为 **JSON Lines**（每行一个 JSON，无 header）——协议层以 json_lines
 * 为缺省；``Content-Length`` 分帧为旧标准兼容形态（读侧自适应，写侧按
 * 配置显式启用）。
 *
 * 帧编码/解码是纯函数；流式读侧需要按块缓冲的字节读取器（ByteReader）
 * 与消息解码循环（read_messages）——读侧同时支持两种形态，恶意/异常
 * server 声明超大 Content-Length 时按 MAX_STDIO_FRAME_BYTES 上界
 * fail-closed 断开（不按声明值分配缓冲）。
 *
 * 工具调用结果文本截断上限与引擎 tool_pipeline.DEFAULT_MAX_RESULT_CHARS
 * 共享常量（单点维护防漂移，见 _result.ts）。
 */
import { McpConnectionLost } from './_errors.js';

// ── 帧协议形态与上界 ────────────────────────────────────────────────────

export const CONTENT_LENGTH_FRAMING = 'content_length';
export const JSON_LINES_FRAMING = 'json_lines';

/** stdio 单帧上限（字节）：Content-Length 分帧的可信上界。 */
export const MAX_STDIO_FRAME_BYTES = 16 * 1024 * 1024;

// 连接/调用超时（秒）：MCP 握手与工具调用均须有上界，避免无限挂起拖垮回合
export const CONNECT_TIMEOUT = 30.0;
export const CALL_TIMEOUT = 60.0;

// MCP initialize 握手身份
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const MCP_CLIENT_NAME = 'ink-engine';
export const MCP_CLIENT_VERSION = '1.0';

/** MCP stdio 帧编码（content_length = LSP 风格；json_lines = 单行 JSON）。 */
export function encode_mcp_frame(
  payload: Record<string, unknown>,
  framing: string = CONTENT_LENGTH_FRAMING,
): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  if (framing === JSON_LINES_FRAMING) {
    return Buffer.concat([body, Buffer.from('\n')]);
  }
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/** 解析帧头行的 Content-Length 值（非法形态回落 0，读循环跳过）。 */
export function parse_content_length(header: Buffer | string): number {
  const text = header.toString('ascii').trim();
  if (!text.toLowerCase().startsWith('content-length:')) return 0;
  const value = text.split(':', 2)[1]?.trim();
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 去除行尾换行/回车（供字节读侧的行解析使用）。 */
export function strip_line_ending(line: Buffer): Buffer {
  let end = line.length;
  if (end > 0 && line[end - 1] === 0x0a) end -= 1;
  if (end > 0 && line[end - 1] === 0x0d) end -= 1;
  return line.subarray(0, end);
}

/**
 * 字节缓冲读取器：按块拉取 + 缓冲，提供行读取与精确字节数读取
 * （MCP 读循环的两种原语；跨 chunk 边界安全）。
 */
export class ByteReader {
  private _buf = Buffer.alloc(0);
  private readonly _source: AsyncIterator<Buffer>;
  private _done = false;

  constructor(source: AsyncIterable<Buffer>) {
    this._source = source[Symbol.asyncIterator]();
  }

  private async _pull(): Promise<void> {
    const next = await this._source.next();
    if (next.done) {
      this._done = true;
      return;
    }
    const chunk = next.value;
    if (chunk.length > 0) this._buf = Buffer.concat([this._buf, chunk]);
  }

  /** 读一行（不含行尾）；EOF 且无剩余返回 null。 */
  async read_line(): Promise<Buffer | null> {
    for (;;) {
      const index = this._buf.indexOf(0x0a);
      if (index !== -1) {
        const line = this._buf.subarray(0, index + 1);
        this._buf = this._buf.subarray(index + 1);
        return strip_line_ending(line);
      }
      if (this._done) {
        if (this._buf.length === 0) return null;
        const rest = this._buf;
        this._buf = Buffer.alloc(0);
        return strip_line_ending(rest);
      }
      await this._pull();
    }
  }

  /** 精确读取 n 字节；EOF 前字节不足返回 null（子进程已退出）。 */
  async read_exactly(n: number): Promise<Buffer | null> {
    for (;;) {
      if (this._buf.length >= n) {
        const out = this._buf.subarray(0, n);
        this._buf = this._buf.subarray(n);
        return out;
      }
      if (this._done) return null;
      await this._pull();
    }
  }
}

/**
 * MCP stdout 消息解码循环（async generator）：逐条产出 JSON-RPC 消息。
 *
 * 读侧自适应两种分帧：行首 ``Content-Length:`` = 旧标准分帧（解析头部后
 * 按字节数读 body）；否则 = JSON Lines 整行消息（内置执行件形态）。当
 * 配置写侧为 content_length 而 server 以 JSON Lines 响应时，经
 * ``on_switch_to_json_lines`` 回调同步切换写侧（容错未显式配置的 server）。
 */
export async function* read_messages(
  stdout: AsyncIterable<Buffer>,
  server_id: string,
  opts: { on_switch_to_json_lines?: () => void } = {},
): AsyncGenerator<Record<string, unknown>> {
  const reader = new ByteReader(stdout);
  for (;;) {
    const line = await reader.read_line();
    if (line === null) break;
    if (line.length === 0) continue;
    if (line[0] === 0x43 && line.length >= 15 && line.subarray(0, 15).toString('ascii') === 'Content-Length:') {
      // 标准 MCP 分帧：解析 header 后按字节数读 body
      let contentLength = parse_content_length(line);
      for (;;) {
        const header = await reader.read_line();
        if (header === null) break;
        if (header.length === 0) break;
        if (header.subarray(0, 15).toString('ascii').toLowerCase() === 'content-length:') {
          contentLength = parse_content_length(header);
        }
      }
      if (contentLength <= 0) continue;
      if (contentLength > MAX_STDIO_FRAME_BYTES) {
        // 帧大小超可信上界：断开连接（fail-closed）——不按声明值分配缓冲，
        // 防恶意超大 Content-Length
        throw new McpConnectionLost(
          `MCP server ${server_id} 帧大小超限（${contentLength} > ${MAX_STDIO_FRAME_BYTES} 字节），连接已断开`,
        );
      }
      const body = await reader.read_exactly(contentLength);
      if (body === null) break;
      yield JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
      continue;
    }
    // JSON Lines：整行即一条消息（server 以该形态响应时写侧同步切换）
    const trimmed = strip_line_ending(line).toString('utf-8').trim();
    if (trimmed === '') continue;
    if (opts.on_switch_to_json_lines !== undefined) {
      opts.on_switch_to_json_lines();
    }
    yield JSON.parse(trimmed) as Record<string, unknown>;
  }
}

/** 执行件 stderr 单行 → 日志通道（结构化行按 level 分级落明）。 */
export function exec_line_is_error(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { level?: unknown };
    return parsed.level === 'error';
  } catch {
    return false;
  }
}
