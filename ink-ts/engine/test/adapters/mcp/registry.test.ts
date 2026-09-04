/**
 * 内置 MCP server 注册表单测：tools.json mcp 工具的 server_id 定义对齐、
 * 连接位可覆盖、注册表权威字段不可改写、未知 server_id fail-closed。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { ToolSource } from '../../../src/core/tool_vetting/tool_vetting.js';
import {
  BUILTIN_MCP_SERVERS,
  McpTransport,
  builtin_mcp_server_config,
} from '../../../src/adapters/mcp/index.js';

describe('BUILTIN_MCP_SERVERS 内置注册表', () => {
  it('注册表覆盖 tools.json 的 server_id（inkling_exec / inkling_shell）', () => {
    expect(Object.keys(BUILTIN_MCP_SERVERS).sort()).toEqual([
      'inkling_exec',
      'inkling_shell',
    ]);
    expect(BUILTIN_MCP_SERVERS['inkling_exec']!.transport).toBe(McpTransport.STDIO);
    expect(BUILTIN_MCP_SERVERS['inkling_shell']!.transport).toBe(McpTransport.IN_MEMORY);
    for (const config of Object.values(BUILTIN_MCP_SERVERS)) {
      expect(config.signature).toBeTruthy(); // 连接身份签名齐备（vetting 不缺项）
      expect(config.source).toBe(ToolSource.GITHUB);
    }
  });
});

describe('builtin_mcp_server_config 宿主填充连接位', () => {
  it('环境相关连接参数可覆盖，注册表权威字段（传输/来源/签名）不可改', () => {
    const config = builtin_mcp_server_config('inkling_exec', {
      command: 'C:/bin/inkling_exec.exe',
      args: ['serve'],
    });
    expect(config).not.toBeNull();
    expect(config!.id).toBe('inkling_exec');
    expect(config!.transport).toBe(McpTransport.STDIO);
    expect(config!.command).toBe('C:/bin/inkling_exec.exe');
    expect(config!.args).toEqual(['serve']);
    expect(config!.source).toBe(BUILTIN_MCP_SERVERS['inkling_exec']!.source);
    expect(config!.signature).toBe('builtin:inkling_exec');
  });

  it('注册表权威字段覆盖 / 未知字段 → 显式拒绝；未知 server_id → null', () => {
    expect(() =>
      builtin_mcp_server_config('inkling_exec', { transport: McpTransport.HTTP }),
    ).toThrow(/注册表字段不可覆盖/);
    expect(() =>
      builtin_mcp_server_config('inkling_exec', { signature: 'spoofed' }),
    ).toThrow(/注册表字段不可覆盖/);
    expect(() =>
      builtin_mcp_server_config('inkling_exec', { bogus: 1 }),
    ).toThrow(/未知字段/);
    expect(builtin_mcp_server_config('ghost-server')).toBeNull();
  });
});
