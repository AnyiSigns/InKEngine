/**
 * 受控 OS 执行器域测试（真 exec 二进制：沙箱根内执行 + 越权/越根 host 拦截
 * + 审计留痕）。二进制缺失 = 整组跳过（CI 无 Rust 工具链不炸；本地/出厂门禁
 * 必须先 cargo build）。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SET_AUDIT_COLLECTION } from '@ink-ts/engine';

import { HostOsRunner } from '../../src/os/runner.js';
import { locateNativeBinary } from '../../src/exec/binary.js';
import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { echoGraphRecipe } from '../_graphs.js';

const execBinary = locateNativeBinary('exec');
const describeOrSkip = execBinary === null ? describe.skip : describe;

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

const ECHO = process.platform === 'win32' ? 'cmd' : 'echo';

describeOrSkip('受控 OS 执行器（沙箱根内执行 + 越权拦截 + 审计留痕）', () => {
  it('process 在沙箱根内执行成功且审计留痕（type=os_tool_exec）', async () => {
    const dir = tempDir('ink-os-ok-');
    const handle: HostHandle = await createHost({ data_dir: dir }, { graph_recipe: echoGraphRecipe });
    try {
      const runner = new HostOsRunner(() => handle.runtime.storage);
      const argv =
        process.platform === 'win32'
          ? ['cmd', '/C', 'echo', 'os-chain-ok']
          : ['echo', 'os-chain-ok'];
      const outcome = await runner.run(
        {
          tool: 'os_probe',
          op: 'process',
          args: { argv },
          roots: [dir],
          allowlist: [ECHO],
          cwd: dir,
          timeout_secs: 20,
        },
        { approved: true, by: 'test' },
      );
      expect(outcome.output['exit_code']).toBe(0);
      expect(String(outcome.output['stdout'])).toContain('os-chain-ok');

      const audit = await handle.runtime.storage!.list_records(SET_AUDIT_COLLECTION);
      expect(audit.some((record) => record['type'] === 'os_tool_exec')).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it('越权命令被 host 拦截（ExecRefused；不落审计、不触达 exec 执行）', async () => {
    const dir = tempDir('ink-os-deny-');
    const handle: HostHandle = await createHost({ data_dir: dir }, { graph_recipe: echoGraphRecipe });
    try {
      const runner = new HostOsRunner(() => handle.runtime.storage);
      await expect(
        runner.run(
          {
            tool: 'os_probe',
            op: 'process',
            args: { argv: ['not-allowlisted', 'x'] },
            roots: [dir],
            allowlist: ['cmd'],
            cwd: dir,
          },
          { approved: true, by: 'test' },
        ),
      ).rejects.toThrow(/越权拒绝/);
      const audit = await handle.runtime.storage!.list_records(SET_AUDIT_COLLECTION);
      expect(audit.some((record) => record['type'] === 'os_tool_exec')).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it('越根 file 路径被 host 拦截（roots 外路径不触达 exec）', async () => {
    const dir = tempDir('ink-os-root-');
    const outside = tempDir('ink-os-outside-');
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    const handle: HostHandle = await createHost({ data_dir: dir }, { graph_recipe: echoGraphRecipe });
    try {
      const runner = new HostOsRunner(() => handle.runtime.storage);
      await expect(
        runner.run(
          {
            tool: 'file_probe',
            op: 'file',
            args: { subop: 'read', path: path.join(outside, 'secret.txt') },
            roots: [dir],
          },
          { approved: true, by: 'test' },
        ),
      ).rejects.toThrow(/越根拒绝/);
    } finally {
      await handle.dispose();
    }
  });

  it('未显式放行（approved=false）拒绝；无 exec 二进制时报 exec_unavailable', async () => {
    const dir = tempDir('ink-os-approval-');
    const handle: HostHandle = await createHost({ data_dir: dir }, { graph_recipe: echoGraphRecipe });
    try {
      const runner = new HostOsRunner(() => handle.runtime.storage, null);
      await expect(
        runner.run(
          { tool: 'os_probe', op: 'process', args: { argv: ['cmd'] }, roots: [dir], allowlist: ['cmd'] },
          { approved: false, by: 'test' },
        ),
      ).rejects.toMatchObject({ code: 'approval_required' });
      await expect(
        runner.run(
          { tool: 'os_probe', op: 'process', args: { argv: ['cmd'] }, roots: [dir], allowlist: ['cmd'] },
          { approved: true, by: 'test' },
        ),
      ).rejects.toMatchObject({ code: 'exec_unavailable' });
    } finally {
      await handle.dispose();
    }
  });
});
