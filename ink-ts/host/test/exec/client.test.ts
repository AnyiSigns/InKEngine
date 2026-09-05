/**
 * host ↔ exec 进程级集成（S5 验收：spawn → 信封调用 → 响应）。
 *
 * 二进制经 binary.ts 定位（target/{debug,release}/exec(.exe)）；定位不到 =
 * 未构建 cargo → 整组跳过（CI 无 Rust 工具链不炸，本地/出厂门禁必须先
 * `cargo build`）。覆盖：受监督 spawn + ping 健康 + process 信封调用回
 * 结构化结果；越权/越根由 host 拒绝（裁决面门）；exec 侧机械守门第二道
 * 防线（签名不符/信封内白名单矛盾在 exec 拒绝而非 host 前判）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { locateNativeBinary } from '../../src/exec/binary.js';
import { ExecClient } from '../../src/exec/client.js';
import { hmacHex } from '../../src/exec/envelope.js';
import type { SessionOpener } from '../../src/exec/session.js';
import { StdioProcessSession } from '../../src/exec/transport.js';

const execBinary = locateNativeBinary('exec');
const describeOrSkip = execBinary === null ? describe.skip : describe;

describeOrSkip('host ↔ exec 进程级集成', () => {
  const clients: ExecClient[] = [];
  const sessions: StdioProcessSession[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    for (const session of sessions.splice(0)) await session.close();
  });

  it('spawn + ping + process 信封调用回结构化结果', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ink-exec-int-'));
    const client = new ExecClient({ binary: execBinary! });
    clients.push(client);
    expect(await client.healthCheck()).toBe(true);
    const outcome = await client.call(
      { tool: 'process_exec', op: 'process', args: { argv: ['cmd', '/C', 'echo', 'native-exec-ok'] } },
      {
        approved: true,
        by: 'integration',
        endpoint: 'os',
        roots: [workspace],
        allowlist: ['cmd'],
        cwd: workspace,
        timeout_secs: 20,
        max_chars: 4096,
      },
    );
    expect(outcome.op).toBe('process');
    expect(outcome.output['exit_code']).toBe(0);
    expect(String(outcome.output['stdout'])).toContain('native-exec-ok');
  });

  it('越权命令由 host 拒绝（ExecRefused 不触达 exec）', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ink-exec-denied-'));
    const client = new ExecClient({ binary: execBinary! });
    clients.push(client);
    await expect(
      client.call(
        { tool: 'shell_exec', op: 'process', args: { argv: ['format-c:', '/all'] } },
        {
          approved: true,
          by: 'integration',
          endpoint: 'os',
          roots: [workspace],
          allowlist: ['git', 'cmd'],
          cwd: workspace,
        },
      ),
    ).rejects.toThrow(/越权拒绝/);
    // 进程仍健康：拒绝发生在 host 面门，exec 未被调用
    expect(await client.healthCheck()).toBe(true);
  });

  it('零裁决证明：越权由 host 拒绝且 exec 进程从未被拉起', async () => {
    let opened = false;
    const client = new ExecClient({
      binary: execBinary!,
      opener: (async () => {
        opened = true;
        throw new Error('exec 不应被拉起（host 面门已拒绝）');
      }) as SessionOpener,
    });
    clients.push(client);
    await expect(
      client.call(
        { tool: 'shell_exec', op: 'process', args: { argv: ['sudo', 'rm', '-rf', '/*'] } },
        {
          approved: true,
          by: 'integration',
          endpoint: 'os',
          roots: [process.cwd()],
          allowlist: ['git', 'cmd'],
          cwd: process.cwd(),
        },
      ),
    ).rejects.toThrow(/越权拒绝/);
    expect(opened).toBe(false);
  });

  it('越根 file 路径由 host 拒绝（ExecRefused 不触达 exec）', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ink-exec-root-'));
    const client = new ExecClient({ binary: execBinary! });
    clients.push(client);
    await expect(
      client.call(
        { tool: 'file_exec', op: 'file', args: { subop: 'read', path: path.join(tmpdir(), 'secret.txt') } },
        {
          approved: true,
          by: 'integration',
          endpoint: 'file',
          roots: [workspace],
        },
      ),
    ).rejects.toThrow(/越根拒绝/);
  });

  it('exec 机械守门（第二道防线）：信封白名单矛盾在 exec 拒绝', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ink-exec-gate-'));
    const key = 'a'.repeat(64);
    const session = new StdioProcessSession({
      binary: execBinary!,
      env: { INK_EXEC_SESSION_KEY: key },
    });
    sessions.push(session);
    // 手工构造「白名单矛盾」信封（argv[0] 不在 allowlist）并正确签名：
    // 越过 host 面门直送 exec → exec 必须以 allowlist 拒绝（机械复核）
    const body = JSON.stringify({
      version: 1,
      id: 'mechanic-1',
      tool: 'process_exec',
      op: 'process',
      args: { argv: ['definitely-not-allowlisted'] },
      endpoint: 'os',
      roots: [workspace],
      allowlist: ['git'],
      allow_domains: [],
      cwd: workspace,
      env: null,
      timeout_secs: 10,
      max_chars: 4096,
      nonce: 'n1',
      issued_at: 1,
      decision: { approved: true, by: 'test', trace_id: null },
    });
    const signature = hmacHex(key, body);
    const promise = session.request('exec.call', { body, signature });
    await expect(promise).rejects.toMatchObject({ reason: 'allowlist' });
  });

  it('exec 机械守门：签名不符 fail-closed', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'ink-exec-sig-'));
    const key = 'b'.repeat(64);
    const session = new StdioProcessSession({
      binary: execBinary!,
      env: { INK_EXEC_SESSION_KEY: key },
    });
    sessions.push(session);
    const body = JSON.stringify({
      version: 1,
      id: 'sig-1',
      tool: 'process_exec',
      op: 'process',
      args: { argv: ['cmd', '/C', 'echo', 'nope'] },
      endpoint: 'os',
      roots: [workspace],
      allowlist: ['cmd'],
      allow_domains: [],
      cwd: workspace,
      env: null,
      timeout_secs: 10,
      max_chars: 4096,
      nonce: 'n2',
      issued_at: 1,
      decision: { approved: true, by: 'test', trace_id: null },
    });
    const promise = session.request('exec.call', { body, signature: '0'.repeat(64) });
    await expect(promise).rejects.toMatchObject({ reason: 'signature' });
  });
});
