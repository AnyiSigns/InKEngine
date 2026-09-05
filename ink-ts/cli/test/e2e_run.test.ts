/**
 * run 形态 e2e（spawn cli run …）：JSON 信封 stdout + exit 0/1/2 + 审批语义。
 *
 * - 成功（round/op/audit）exit 0，信封 ok=true；
 * - 运行失败（gate 挂起无 --approve / 未知方法 / os_op 未装配）exit 1，
 *   信封 ok=false + error.kind；
 * - 用法错误（互斥参数）exit 2（无信封，走 stderr + 帮助）；
 * - approval：仅显式 --approve 放行（fail-closed 缺省）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseEnvelope, runCli } from './_spawn.js';
import { locateNativeBinary } from '@ink-ts/host';

const STUB_REPLY = '（cli stub 回合已执行）';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function dataArgs(): string[] {
  return ['--data-dir', tempDir('ink-cli-run-')];
}

interface Envelope {
  ok: boolean;
  trace_id: string;
  command: string;
  data: { reply?: unknown; reason?: unknown; events?: { types?: string[] } } | null;
  error: { kind: string; message: string } | null;
}

async function runOnce(args: readonly string[]): Promise<{ exitCode: number | null; env: Envelope | null; stdout: string }> {
  const result = await runCli(args, { timeoutMs: 90_000 });
  const env = parseEnvelope(result.stdout) as Envelope | null;
  return { exitCode: result.exitCode, env, stdout: result.stdout };
}

describe('run 形态：round 回合驱动', () => {
  it('--round 成功：exit 0 + ok 信封 + stub 回复 + 事件摘要', async () => {
    const { exitCode, env } = await runOnce(['run', '--round', 'hello', '--trace-id', 'run-trace-1', ...dataArgs()]);
    expect(exitCode).toBe(0);
    expect(env?.ok).toBe(true);
    expect(env?.command).toBe('round');
    expect(env?.trace_id).toBe('run-trace-1');
    expect(env?.data?.reason).toBe('reply');
    expect(env?.data?.reply).toBe(STUB_REPLY);
    expect(env?.data?.events?.types).toContain('reply_token');
  });
});

describe('run 形态：approval --approve 显式放行语义', () => {
  it('gate 挂卡无 --approve → fail-closed exit 1（kind=approval）', async () => {
    const { exitCode, env } = await runOnce(['run', '--round', 'go', '--graph', 'gate', ...dataArgs()]);
    expect(exitCode).toBe(1);
    expect(env?.ok).toBe(false);
    expect(env?.error?.kind).toBe('approval');
    expect(env?.error?.message).toContain('--approve');
  });

  it('gate 挂卡 + --approve → 显式放行 exit 0（reply=approved）', async () => {
    const { exitCode, env } = await runOnce(['run', '--round', 'go', '--graph', 'gate', '--approve', ...dataArgs()]);
    expect(exitCode).toBe(0);
    expect(env?.ok).toBe(true);
    expect(env?.data?.reply).toBe('approved');
  });
});

describe('run 形态：op / audit / os-op', () => {
  it('--audit export：exit 0，data 为审计记录数组', async () => {
    const { exitCode, env } = await runOnce(['run', '--audit', 'export', '--trace-id', 'audit-1', ...dataArgs()]);
    expect(exitCode).toBe(0);
    expect(env?.ok).toBe(true);
    expect(env?.command).toBe('audit');
    expect(Array.isArray(env?.data)).toBe(true);
  });

  it('--op records.sessions：exit 0，data 为会话数组', async () => {
    const { exitCode, env } = await runOnce(['run', '--op', 'records.sessions', ...dataArgs()]);
    expect(exitCode).toBe(0);
    expect(env?.ok).toBe(true);
    expect(Array.isArray(env?.data)).toBe(true);
  });

  it('--op 未知方法：exit 1 + kind=op', async () => {
    const { exitCode, env } = await runOnce(['run', '--op', 'no.such.method', ...dataArgs()]);
    expect(exitCode).toBe(1);
    expect(env?.ok).toBe(false);
    expect(env?.error?.kind).toBe('op');
    expect(env?.error?.message).toContain('未知方法');
  });

  it('--os-op 显式 --approve：有 exec 原生件走参数校验，无则 fail-closed exit 1', async () => {
    const { exitCode, env } = await runOnce(['run', '--os-op', 'process_exec', '--approve', ...dataArgs()]);
    expect(exitCode).toBe(1);
    expect(env?.ok).toBe(false);
    expect(env?.error?.kind).toBe('os_op');
    if (locateNativeBinary('exec') === null) {
      expect(env?.error?.message).toContain('未装配');
    } else {
      expect(env?.error?.message).toContain('需 op');
    }
  });

  it('--os-op 无 --approve：fail-closed 拒绝（approval 提示）', async () => {
    const { exitCode, env } = await runOnce(['run', '--os-op', 'process_exec', ...dataArgs()]);
    expect(exitCode).toBe(1);
    expect(env?.ok).toBe(false);
    expect(env?.error?.kind).toBe('os_op');
    expect(env?.error?.message).toContain('--approve');
  });
});

describe('run 形态：用法错误 exit 2 / help exit 0', () => {
  it('互斥参数（--round + --audit）：exit 2 且 stdout 无信封', async () => {
    const { exitCode, env, stdout } = await runOnce(['run', '--round', 'x', '--audit', 'export']);
    expect(exitCode).toBe(2);
    expect(env).toBeNull();
    expect(stdout.trim()).toBe('');
  });

  it('run 缺驱动参数：exit 2', async () => {
    const result = await runCli(['run'], { timeoutMs: 30_000 });
    expect(result.exitCode).toBe(2);
  });

  it('--help：exit 0 且 stdout 含帮助', async () => {
    const { exitCode, stdout } = await runOnce(['run', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ink-ts cli');
  });
});
