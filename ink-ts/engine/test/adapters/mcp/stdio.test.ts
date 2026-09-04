/**
 * 自写 MCP stdio 传输单测（镜像 Python test_mcp_threaded_stdio.py 的传输层）：
 * 帧编码/解码纯函数 + 真实子进程全链路（node echo server，零第三方）。
 *
 * 真实子进程用例在 Node 是确定性 IO（适配器允许 IO）；协议核心（分帧
 * 配对/业务拒绝收敛/断流收敛）均以可复现路径验证。真实进程监督拉起/熔断
 * 另置于 stdio_supervision.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  CONTENT_LENGTH_FRAMING,
  JSON_LINES_FRAMING,
  MAX_STDIO_FRAME_BYTES,
  McpConnectionLost,
  McpServerConfig,
  McpToolImportError,
  McpTransport,
  SdkSession,
  ByteReader,
  encode_mcp_frame,
  parse_content_length,
  read_messages,
} from '../../../src/adapters/mcp/index.js';
import { cleanup_tmp_dirs, echo_config } from './_helpers.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  cleanup_tmp_dirs();
});

describe('帧协议（纯函数）', () => {
  it('content_length 帧 = Content-Length 头 + UTF-8 JSON 体', () => {
    const frame = encode_mcp_frame({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const text = frame.toString('utf-8');
    expect(text.startsWith('Content-Length: ')).toBe(true);
    expect(text).toContain('\r\n\r\n');
    const bodyStart = text.indexOf('\r\n\r\n') + 4;
    const declared = parseInt(text.slice('Content-Length: '.length, text.indexOf('\r\n')), 10);
    expect(declared).toBe(frame.length - bodyStart);
    const body = frame.subarray(bodyStart).toString('utf-8');
    expect(JSON.parse(body)).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('json_lines 帧 = 单行 JSON + 换行', () => {
    const frame = encode_mcp_frame({ jsonrpc: '2.0', id: 2 }, JSON_LINES_FRAMING);
    expect(frame[frame.length - 1]).toBe(0x0a);
    expect(JSON.parse(frame.toString('utf-8').trim())).toEqual({ jsonrpc: '2.0', id: 2 });
  });

  it('parse_content_length 解析/非法回落 0', () => {
    expect(parse_content_length('Content-Length: 123')).toBe(123);
    expect(parse_content_length('Content-Length: 12ab')).toBe(0);
    expect(parse_content_length('X-Length: 5')).toBe(0);
  });

  it('ByteReader 跨 chunk 行/字节读取', async () => {
    const source = (async function* () {
      yield Buffer.from('hel');
      yield Buffer.from('lo\r\nwor');
      yield Buffer.from('ld');
    })();
    const reader = new ByteReader(source);
    expect((await reader.read_line())!.toString('utf-8')).toBe('hello');
    expect((await reader.read_exactly(2))!.toString('utf-8')).toBe('wo');
    expect((await reader.read_line())!.toString('utf-8')).toBe('rld');
    expect(await reader.read_line()).toBeNull();
  });

  it('read_messages 读侧自适应：content_length 分帧跨 chunk 解码', async () => {
    const msg = { jsonrpc: '2.0', id: 9, result: { tools: [] } };
    const frame = encode_mcp_frame(msg, CONTENT_LENGTH_FRAMING);
    const source = (async function* () {
      yield frame.subarray(0, 7);
      yield frame.subarray(7);
    })();
    const got: Record<string, unknown>[] = [];
    for await (const parsed of read_messages(source, 'echo')) got.push(parsed);
    expect(got).toEqual([msg]);
  });

  it('read_messages 帧大小超可信上界 → 连接断流（fail-closed）', async () => {
    const header = `Content-Length: ${MAX_STDIO_FRAME_BYTES + 1}\r\n\r\n`;
    const source = (async function* () {
      yield Buffer.from(header, 'ascii');
    })();
    const iterator = read_messages(source, 'echo')[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(McpConnectionLost);
  });
});

describe('自写 stdio 传输（真实子进程）', () => {
  it('全链路：open → list_tools → call_tool → ping → close', async () => {
    const session = await SdkSession.open(echo_config());
    try {
      const tools = await session.list_tools();
      expect(tools.length).toBe(1);
      expect(tools[0]!['name']).toBe('echo_text');
      await expect(session.call_tool('echo_text', { text: 'hello' })).resolves.toBe('hello');
      await session.ping();
    } finally {
      await session.aclose();
    }
  });

  it('Content-Length 旧标准分帧（写侧配置、读侧自适应）兼容', async () => {
    const session = await SdkSession.open(echo_config({ framing: CONTENT_LENGTH_FRAMING }));
    try {
      const tools = await session.list_tools();
      expect(tools.map((t) => t['name'])).toEqual(['echo_text']);
      await expect(session.call_tool('echo_text', { text: 'cl' })).resolves.toBe('cl');
    } finally {
      await session.aclose();
    }
  });

  it('server 业务拒绝（-32602 参数校验）→ GraphDefinitionError', async () => {
    const session = await SdkSession.open(echo_config());
    try {
      await expect(session.call_tool('reject', {})).rejects.toBeInstanceOf(GraphDefinitionError);
      await expect(session.call_tool('reject', {})).rejects.toThrow(/MCP 工具执行失败/);
    } finally {
      await session.aclose();
    }
  });

  it('server 返回 isError=true → 业务错误（提取失败文本）', async () => {
    const session = await SdkSession.open(echo_config());
    try {
      await expect(session.call_tool('fail', {})).rejects.toThrow(/boom/);
    } finally {
      await session.aclose();
    }
  });

  it('未知工具 → server 回 -32601 → 收敛为 GraphDefinitionError', async () => {
    const session = await SdkSession.open(echo_config());
    try {
      await expect(session.call_tool('nope', {})).rejects.toBeInstanceOf(GraphDefinitionError);
    } finally {
      await session.aclose();
    }
  });

  it('aclose 确定性收尾：进程终止、无残留 pending、可重开', async () => {
    const session = await SdkSession.open(echo_config());
    const transport = (session as unknown as {
      _transport: { _channel: { _pending: Map<number, unknown> } };
    })._transport;
    await session.aclose();
    expect(transport._channel._pending.size).toBe(0);
    // 重开新会话（原连接已彻底释放，不冲突）
    const session2 = await SdkSession.open(echo_config());
    try {
      await expect(session2.call_tool('echo_text', { text: 'again' })).resolves.toBe('again');
    } finally {
      await session2.aclose();
    }
  });

  it('命令不存在 → 连接失败收敛为 McpToolImportError', async () => {
    const config = new McpServerConfig({
      id: 'nope',
      transport: McpTransport.STDIO,
      command: 'definitely-not-a-real-binary-xyz',
    });
    await expect(SdkSession.open(config)).rejects.toBeInstanceOf(McpToolImportError);
    await expect(SdkSession.open(config)).rejects.toThrow(/连接失败/);
  });

  it('执行件 stderr 结构化日志收敛进宿主注入的 exec 通道（error 分级）', async () => {
    const captured: string[] = [];
    const session = await SdkSession.open(echo_config({ stderr: true }), {
      on_exec_line: (level, line) => captured.push(`${level}:${line}`),
    });
    try {
      const tools = await session.list_tools();
      expect(tools.length).toBe(1);
    } finally {
      await session.aclose();
    }
    const deadline = Date.now() + 3000;
    while (captured.length < 2 && Date.now() < deadline) await sleep(25);
    expect(captured.length).toBeGreaterThanOrEqual(2);
    expect(captured.some((entry) => entry.startsWith('error:') && entry.includes('tools/call'))).toBe(true);
    expect(captured.some((entry) => entry.startsWith('info:') && entry.includes('tools/list'))).toBe(true);
  });
});
