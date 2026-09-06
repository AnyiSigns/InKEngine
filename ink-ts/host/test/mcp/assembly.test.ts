/**
 * host MCP 装配接线测试（R1：内置 server 由 ink_ts_mcp 二进制承载）。
 *
 * 覆盖：
 * - resolveBuiltinOverrides：给内置 server 补 command= 定位 ink_ts_mcp +
 *   profile 参数 + Content-Length 分帧；二进制缺失 = fail-closed 可观测；
 * - assembleHostMcp：连接失败只记诊断不击穿 boot（mcpStatus connected=false）；
 * - 真二进制连接（binary 定位不到 = 整组跳过）：manager.connect_builtin 走
 *   装配同一 overrides 路径 → initialize 握手 → tools/list → tools/call
 *   （file 工具在 INK_MCP_ROOT 内执行成功；根外/未设根 fail-closed）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { McpClientManager, Runtime } from '@ink-ts/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BUILTIN_MCP_PROFILES,
  assembleHostMcp,
  resolveBuiltinOverrides,
} from '../../src/mcp/assembly.js';
import { locateNativeBinary } from '../../src/exec/binary.js';

function tempDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `ink-host-mcp-${label}-`));
}

const mcpBinary = locateNativeBinary('mcp');
const mcpDescribe = mcpBinary === null ? describe.skip : describe;

describe('内置 MCP server 装配接线', () => {
  it('profile 表覆盖两个内置 server（inkling_exec → exec / inkling_shell → shell）', () => {
    expect(BUILTIN_MCP_PROFILES).toEqual({ inkling_exec: 'exec', inkling_shell: 'shell' });
  });

  it('resolveBuiltinOverrides：未配置 command = 定位 ink_ts_mcp + profile 参数 + 分帧', () => {
    const dir = tempDir('resolve');
    try {
      const file = path.join(dir, process.platform === 'win32' ? 'ink_ts_mcp.exe' : 'ink_ts_mcp');
      writeFileSync(file, 'MZ fake');
      const resolved = resolveBuiltinOverrides('inkling_exec', null, { env: { INK_NATIVE_DIR: dir } });
      expect(resolved.error).toBeNull();
      expect(resolved.overrides).toEqual({
        command: file,
        args: ['exec'],
        stdio_framing: 'content_length',
      });
      const shell = resolveBuiltinOverrides('inkling_shell', null, {
        env: { INK_NATIVE_DIR: dir },
      });
      expect(shell.overrides['args']).toEqual(['shell']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveBuiltinOverrides：显式 command 保留 + 仍注入 profile 参数', () => {
    const resolved = resolveBuiltinOverrides('inkling_exec', 'C:/bin/custom-mcp', {
      env: {},
      cwd: tempDir('nowhere'),
    });
    expect(resolved.error).toBeNull();
    expect(resolved.overrides['command']).toBe('C:/bin/custom-mcp');
    expect(resolved.overrides['args']).toEqual(['exec']);
  });

  it('resolveBuiltinOverrides：二进制缺失 fail-closed 可观测', () => {
    const outside = tempDir('outside');
    try {
      const resolved = resolveBuiltinOverrides('inkling_exec', null, {
        env: {},
        cwd: outside,
      });
      expect(resolved.overrides).toEqual({});
      expect(resolved.error).not.toBeNull();
      expect(resolved.error).toContain('ink_ts_mcp');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('assembleHostMcp：连接失败只记诊断不击穿 boot（connected=false）', async () => {
    const dir = tempDir('assembly');
    const runtime = new Runtime();
    try {
      const fake = path.join(dir, 'fake-mcp.exe');
      writeFileSync(fake, 'not a real binary');
      const mcp = await assembleHostMcp(runtime, {
        connect: [
          { server_id: 'inkling_exec', command: fake },
          { server_id: 'ghost-server' },
        ],
      });
      expect(mcp.status).toHaveLength(2);
      expect(mcp.status[0]!.server_id).toBe('inkling_exec');
      expect(mcp.status[0]!.connected).toBe(false);
      expect(mcp.status[0]!.error).not.toBeNull();
      expect(mcp.status[1]!.server_id).toBe('ghost-server');
      expect(mcp.status[1]!.error).toContain('未定义');
      // 失败不击穿：管理器仍装配可用
      expect(mcp.manager.list_servers()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

mcpDescribe('ink_ts_mcp 真二进制连接（R1 exec profile）', () => {
  const rootDir = tempDir('real');
  const savedRoot = process.env['INK_MCP_ROOT'];
  const manager = new McpClientManager();
  let server_id: string | null = null;

  beforeAll(async () => {
    process.env['INK_MCP_ROOT'] = rootDir;
    writeFileSync(path.join(rootDir, 'hello.txt'), '你好 builtin-mcp');
    const resolved = resolveBuiltinOverrides('inkling_exec', null);
    if (resolved.error !== null) {
      throw new Error(resolved.error);
    }
    await manager.connect_builtin('inkling_exec', resolved.overrides);
    server_id = 'inkling_exec';
  });

  afterAll(async () => {
    await manager.close_all();
    if (savedRoot === undefined) {
      delete process.env['INK_MCP_ROOT'];
    } else {
      process.env['INK_MCP_ROOT'] = savedRoot;
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('initialize 握手后 tools/list 暴露 file/process 工具', async () => {
    const handle = manager._sessions.get(server_id!)!;
    const tools = await handle.list_tools();
    const names = tools.map((tool) => tool['name']);
    expect(names).toContain('file_read');
    expect(names).toContain('file_write');
    expect(names).toContain('doc_parse');
    expect(names).toContain('process_exec');
  });

  it('tools/call：file_read 在 INK_MCP_ROOT 内成功', async () => {
    const handle = manager._sessions.get(server_id!)!;
    const text = await handle.call_tool('file_read', {
      path: path.join(rootDir, 'hello.txt'),
    });
    const output = JSON.parse(text) as { content?: string };
    expect(output['content']).toContain('你好 builtin-mcp');
  });

  it('tools/call：根外路径拒绝（fail-closed 可观测）', async () => {
    const handle = manager._sessions.get(server_id!)!;
    await expect(
      handle.call_tool('file_read', { path: path.join(tmpdir(), 'outside-mcp.txt') }),
    ).rejects.toThrow(/\[root\]/);
  });
});
