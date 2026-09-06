/**
 * assembleCliHost 生命周期测试：自建临时 data_dir 在 dispose 时删除；
 * 显式传入的 data_dir 属调用方所有，dispose 不触碰。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { HostHandle } from '@ink-ts/host';
import { afterEach, describe, expect, it } from 'vitest';

import { assembleCliHost } from '../src/host.js';

interface Assembled {
  handle: HostHandle;
  dataDir: string;
}

const handles: Assembled[] = [];

async function assemble(data_dir?: string): Promise<Assembled> {
  const handle = await assembleCliHost({ approve: false, graph: 'assistant', data_dir });
  const entry = { handle, dataDir: handle.config.data_dir };
  handles.push(entry);
  return entry;
}

afterEach(async () => {
  const list = handles.splice(0);
  for (const { handle, dataDir } of list) {
    try {
      await handle.dispose();
    } catch {
      // dispose 失败不阻断收尾（文件锁等平台差异兜底）
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('assembleCliHost 数据目录生命周期', () => {
  it('缺省自建临时 data_dir：dispose 后目录删除（进程收尾不留垃圾）', async () => {
    const { handle, dataDir } = await assemble();
    expect(dataDir).toMatch(/ink-ts-cli-/);
    expect(existsSync(dataDir)).toBe(true);
    await handle.dispose();
    expect(existsSync(dataDir)).toBe(false);
  });

  it('显式 data_dir：dispose 后目录保留（属调用方所有）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ink-cli-host-explicit-'));
    const { handle, dataDir } = await assemble(dir);
    expect(dataDir).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    await handle.dispose();
    expect(existsSync(dir)).toBe(true);
  });
});
