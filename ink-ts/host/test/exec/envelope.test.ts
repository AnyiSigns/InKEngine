/**
 * exec 信封签名与宿主侧裁决面门测试。
 *
 * 零裁决证明（host 侧拒绝面）：越权（argv[0] 不在白名单）/ 越根（file
 * path 或 process cwd 不在挂载根）/ 未批准 → ExecRefusedError 由 host
 * 拒绝、进程不触达（本文件为纯函数面；进程级拒绝对拍见 client.test.ts）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExecRefusedError } from '../../src/exec/_types.js';
import type { AdjudicatedDecision } from '../../src/exec/envelope.js';
import {
  buildSignedExecEnvelope,
  hmacHex,
  hostAllowed,
  isPathWithinRoots,
  parseUrlHost,
  verifySignature,
} from '../../src/exec/envelope.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function decision(overrides: Partial<AdjudicatedDecision> = {}): AdjudicatedDecision {
  return {
    approved: true,
    by: 'test',
    endpoint: 'os',
    roots: [],
    allowlist: [],
    allow_domains: [],
    timeout_secs: 30,
    max_chars: 4096,
    cwd: null,
    env: null,
    ...overrides,
  };
}

describe('签名与校验', () => {
  it('同一密钥签名可验；异密钥/篡改签名拒绝', () => {
    const envelope = buildSignedExecEnvelope(
      { tool: 'process_exec', op: 'process', args: { argv: ['git', 'status'] } },
      decision({ roots: [process.cwd()], allowlist: ['git'], cwd: process.cwd() }),
      KEY,
      { id: 'sig-1', nonce: 'n' },
    );
    expect(verifySignature(KEY, envelope.body, envelope.signature)).toBe(true);
    expect(verifySignature('different-key-'.padEnd(64, 'x'), envelope.body, envelope.signature)).toBe(false);
    expect(verifySignature(KEY, `${envelope.body} `, envelope.signature)).toBe(false);
  });

  it('hmacHex 输出形态稳定', () => {
    expect(hmacHex(KEY, 'hello')).toHaveLength(64);
    expect(hmacHex('k', 'data')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('宿主侧裁决面门（越权/越根由 host 拒绝）', () => {
  it('未批准裁决直接拒绝', () => {
    expect(() =>
      buildSignedExecEnvelope(
        { tool: 'shell_exec', op: 'process', args: { argv: ['git', 'status'] } },
        decision({ approved: false }),
        KEY,
      ),
    ).toThrow(ExecRefusedError);
  });

  it('越权：命令不在白名单 = host 拒绝', () => {
    expect(() =>
      buildSignedExecEnvelope(
        { tool: 'shell_exec', op: 'process', args: { argv: ['rm', '-rf', '/'] } },
        decision({ roots: [process.cwd()], allowlist: ['git'], cwd: process.cwd() }),
        KEY,
      ),
    ).toThrow(/越权拒绝/);
  });

  it('越根：file 路径在挂载根外 = host 拒绝', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ink-ws-'));
    expect(() =>
      buildSignedExecEnvelope(
        { tool: 'file_exec', op: 'file', args: { subop: 'read', path: path.join(tmpdir(), 'secret.txt') } },
        decision({ endpoint: 'file', roots: [workspace] }),
        KEY,
      ),
    ).toThrow(/越根拒绝/);
  });

  it('process cwd 在挂载根外 = host 拒绝', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ink-ws-cwd-'));
    expect(() =>
      buildSignedExecEnvelope(
        { tool: 'shell_exec', op: 'process', args: { argv: ['git', 'status'] } },
        decision({ roots: [workspace], allowlist: ['git'], cwd: tmpdir() }),
        KEY,
      ),
    ).toThrow(/越根拒绝/);
  });

  it('http 越权：域名不在白名单 = host 拒绝', () => {
    expect(() =>
      buildSignedExecEnvelope(
        { tool: 'fetch', op: 'http', args: { url: 'https://evil.example/x' } },
        decision({ endpoint: 'network', allow_domains: ['good.example'] }),
        KEY,
      ),
    ).toThrow(/越权拒绝/);
  });

  it('合法信封产出签名且成功', () => {
    const signed = buildSignedExecEnvelope(
      { tool: 'shell_exec', op: 'process', args: { argv: ['git', 'status'] } },
      decision({ roots: [process.cwd()], allowlist: ['git'], cwd: process.cwd() }),
      KEY,
    );
    expect(signed.envelope.tool).toBe('shell_exec');
    expect(verifySignature(KEY, signed.body, signed.signature)).toBe(true);
  });
});

describe('路径与域名纯函数', () => {
  it('路径根内判定', () => {
    const ws = process.cwd();
    expect(isPathWithinRoots([ws], path.join(ws, 'a', 'b'))).toBe(true);
    expect(isPathWithinRoots([ws], path.join(tmpdir(), 'outside'))).toBe(false);
    expect(isPathWithinRoots([], ws)).toBe(false);
  });

  it('域名白名单命中', () => {
    expect(hostAllowed(['example.com'], 'example.com')).toBe(true);
    expect(hostAllowed(['*.example.com'], 'www.example.com')).toBe(true);
    expect(hostAllowed(['*.example.com'], 'example.com')).toBe(false);
    expect(hostAllowed(['*'], 'anything.else')).toBe(true);
    expect(hostAllowed([], 'example.com')).toBe(false);
  });

  it('URL host 解析', () => {
    expect(parseUrlHost('https://raw.githubusercontent.com/a').host).toBe('raw.githubusercontent.com');
    expect(() => parseUrlHost('ftp://x.com/a')).toThrow();
    expect(() => parseUrlHost('https://user:pw@x.com/')).toThrow();
  });
});
