/**
 * MCP 配置单测：McpServerConfig 序列化往返与非法拒绝 + StdioRestartPolicy
 * 缺省保守值/校验/往返 + 凭据遮蔽（headers/env 不进文案面）。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { ToolSource } from '../../../src/core/tool_vetting/tool_vetting.js';
import {
  CONTENT_LENGTH_FRAMING,
  JSON_LINES_FRAMING,
  McpServerConfig,
  McpTransport,
  StdioRestartPolicy,
} from '../../../src/adapters/mcp/index.js';

describe('McpServerConfig 序列化与校验', () => {
  it('序列化往返完整（含 transport 归一）', () => {
    const cfg = new McpServerConfig({
      id: 'svc',
      transport: McpTransport.STDIO,
      command: 'node',
      args: ['srv.js'],
      source: ToolSource.GITHUB,
      headers: { Authorization: 'Bearer t' },
      stdio_framing: CONTENT_LENGTH_FRAMING,
    });
    const restored = McpServerConfig.from_dict(cfg.to_dict());
    expect(restored.equals(cfg)).toBe(true);
    expect(restored.transport).toBe(McpTransport.STDIO);
  });

  it('缺 id / 非法传输 / 非法来源 / 非 dict 形态显式拒绝', () => {
    expect(() => McpServerConfig.from_dict({ transport: 'http' })).toThrow(/缺 id/);
    expect(() => McpServerConfig.from_dict({ id: 'x', transport: 'ftp' })).toThrow(
      /传输形态非法/,
    );
    expect(() => McpServerConfig.from_dict({ id: 'x', source: 'mars' })).toThrow(
      /来源分类非法/,
    );
    expect(() => McpServerConfig.from_dict(['id', 'x'])).toThrow(/期望 dict/);
    expect(() => McpServerConfig.from_dict({ id: 'x', env: 'PATH=abc' })).toThrow(
      /env 须为 dict/,
    );
    expect(() => McpServerConfig.from_dict({ id: 'x', headers: 'nope' })).toThrow(
      /headers 须为 dict/,
    );
    expect(() => McpServerConfig.from_dict({ id: 'x', restart_policy: 5 })).toThrow(
      /restart_policy/,
    );
    expect(() =>
      McpServerConfig.from_dict({ id: 'x', stdio_framing: 'binary' }),
    ).toThrow(/stdio_framing 非法/);
  });

  it('http 请求头（鉴权场景）序列化往返完整', () => {
    const cfg = new McpServerConfig({
      id: 'svc',
      transport: McpTransport.HTTP,
      url: 'https://mcp.example',
      headers: { Authorization: 'Bearer t' },
      source: ToolSource.MARKET,
      signature: 'signed-by-market',
    });
    const restored = McpServerConfig.from_dict(cfg.to_dict());
    expect(restored.equals(cfg)).toBe(true);
  });

  it('headers/env 凭据遮蔽自文案面（repr/toString 不泄漏子进程凭据）', () => {
    const cfg = new McpServerConfig({
      id: 'svc',
      transport: McpTransport.STDIO,
      command: 'node',
      env: { TOKEN: 'secret' },
      headers: { Authorization: 'Bearer xyz' },
    });
    expect(String(cfg)).not.toContain('TOKEN');
    expect(String(cfg)).not.toContain('secret');
    expect(String(cfg)).not.toContain('xyz');
  });

  it('to_dict(redact_credentials=True) 以 [REDACTED] 占位鉴权值', () => {
    const cfg = new McpServerConfig({
      id: 'svc',
      transport: McpTransport.HTTP,
      url: 'https://mcp.example',
      headers: { Authorization: 'Bearer t' },
      env: { TOKEN: 's3cret' },
    });
    const data = cfg.to_dict({ redact_credentials: true });
    expect(data['headers']).toEqual({ Authorization: '[REDACTED]' });
    expect(data['env']).toEqual({ TOKEN: '[REDACTED]' });
    expect(JSON.stringify(data)).not.toContain('s3cret');
  });
});

describe('StdioRestartPolicy 重启策略', () => {
  it('缺省值保守（2 次重启 / 1s 退避 / 3 次熔断）', () => {
    const policy = new StdioRestartPolicy();
    expect(policy.max_retries).toBe(2);
    expect(policy.backoff).toBe(1.0);
    expect(policy.circuit_break_threshold).toBe(3);
  });

  it('非法取值拒绝（负重启/退避、阈值 < 1）', () => {
    expect(() => new StdioRestartPolicy({ max_retries: -1 })).toThrow(/不能为负/);
    expect(() => new StdioRestartPolicy({ backoff: -0.1 })).toThrow(/不能为负/);
    expect(() => new StdioRestartPolicy({ circuit_break_threshold: 0 })).toThrow(
      /阈值须 >= 1/,
    );
  });

  it('经配置往返：restart_policy 数据化保存与还原', () => {
    const config = new McpServerConfig({
      id: 's1',
      transport: McpTransport.STDIO,
      command: 'pyserver',
      args: ['--port', '9000'],
      restart_policy: new StdioRestartPolicy({
        max_retries: 5,
        backoff: 0.5,
        circuit_break_threshold: 7,
      }),
    });
    const restored = McpServerConfig.from_dict(config.to_dict());
    expect(restored.id).toBe('s1');
    expect(restored.restart_policy).not.toBeNull();
    expect(restored.restart_policy!.equals(
      new StdioRestartPolicy({ max_retries: 5, backoff: 0.5, circuit_break_threshold: 7 }),
    )).toBe(true);
  });

  it('缺省 = 挂接时用默认策略（restart_policy 字段不持久化）', () => {
    const restored = McpServerConfig.from_dict(
      new McpServerConfig({ id: 's1', command: 'cmd' }).to_dict(),
    );
    expect(restored.restart_policy).toBeNull();
  });

  it('stdio_framing 缺省 JSON Lines（本环境 SDK 2.x/inkling_exec 形态）', () => {
    const cfg = new McpServerConfig({ id: 's1' });
    expect(cfg.stdio_framing).toBe(JSON_LINES_FRAMING);
  });
});
