/**
 * stdio stderr 通道缓冲上界单测（fake spawn seam，零真实进程）：进程在
 * stderr 持续输出无行终止数据时缓冲不得无限累积——超过 MAX_STDIO_FRAME_BYTES
 * 即 fail-closed 断开（kill 子进程 + 通道关闭，后续请求以连接断流失败）。
 */
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  MAX_STDIO_FRAME_BYTES,
  McpConnectionLost,
  McpServerConfig,
  McpTransport,
  StdioMcpTransport,
  type SpawnedMcpProcess,
} from '../../../src/adapters/mcp/index.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 内存假子进程：stdin/stdout/stderr 均为 PassThrough，kill 置位并落定 exit。 */
function fake_child(): {
  child: SpawnedMcpProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  is_killed(): boolean;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const state = { killed: false };
  let resolveExit!: (value: { code: number | null; signal: string | null }) => void;
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExit = resolve;
  });
  const child: SpawnedMcpProcess = {
    stdin,
    stdout,
    stderr,
    kill: () => {
      state.killed = true;
      resolveExit({ code: null, signal: 'SIGTERM' });
    },
    exit,
  };
  return { child, stdin, stdout, stderr, is_killed: () => state.killed };
}

/** JSON Lines 帧（stdio 服务端响应形态）。 */
function frame(payload: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
}

const CONFIG = new McpServerConfig({
  id: 'floody',
  transport: McpTransport.STDIO,
  command: 'fake-server',
});

describe('stdio stderr 缓冲上界（fail-closed）', () => {
  it('无行终止洪泛超 MAX_STDIO_FRAME_BYTES → 断开连接（kill + 后续请求失败）', async () => {
    const { child, stdout, stderr, is_killed } = fake_child();
    // 预置 initialize 响应（id=1 与 RpcChannel 首个请求配对；先写后读靠
    // PassThrough 缓冲，无竞态）
    stdout.write(
      frame({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'floody', version: '1' },
        },
      }),
    );
    const transport = new StdioMcpTransport(CONFIG, { spawn_seam: () => child });
    await transport.start();

    // 洪泛 stderr：无行终止的垃圾输出，累计超 MAX_STDIO_FRAME_BYTES
    const piece = Buffer.alloc(1024 * 1024, 0x61); // 1MiB 'a'
    const pieces = Math.floor(MAX_STDIO_FRAME_BYTES / piece.length) + 2;
    for (let i = 0; i < pieces; i += 1) stderr.write(piece);

    // 等待 stderr 循环处理到超限并 kill（确定性轮询）
    const deadline = Date.now() + 5000;
    while (!is_killed() && Date.now() < deadline) await sleep(20);
    expect(is_killed()).toBe(true);

    // 通道已关：后续请求立即以连接断流失败
    await expect(transport.list_tools()).rejects.toBeInstanceOf(McpConnectionLost);
    await transport.aclose();
  });

  it('正常换行日志不触发断开（行缓冲被持续排空）', async () => {
    const { child, stdout, stderr, is_killed } = fake_child();
    stdout.write(
      frame({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'floody', version: '1' },
        },
      }),
    );
    const lines: string[] = [];
    const transport = new StdioMcpTransport(CONFIG, {
      spawn_seam: () => child,
      on_exec_line: (_level, line) => lines.push(line),
    });
    await transport.start();

    // 大量完整行（每行都带 \n，残段缓冲不增长）——不触发断开
    for (let i = 0; i < 20; i += 1) {
      stderr.write(Buffer.from(`{"level":"info","msg":"line-${i}"}\n`, 'utf8'));
    }
    await sleep(150);
    expect(is_killed()).toBe(false);
    expect(lines.length).toBe(20);
    await transport.aclose();
  });
});
