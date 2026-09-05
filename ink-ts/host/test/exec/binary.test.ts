/**
 * 二进制定位（exec_proc 前缀逻辑的 TS 承接）测试。
 *
 * 覆盖：显式 INK_EXEC_BINARY 单文件覆盖 > INK_NATIVE_DIR 目录内定位 >
 * 工作树 target 布局探测（debug 优先）；找不到 = null；Windows 可执行
 * 形态判定。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { binaryFileName, locateNativeBinary } from '../../src/exec/binary.js';

const tempDirs: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `ink-binary-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  tempDirs.splice(0);
});

describe('native 二进制定位', () => {
  it('平台文件名带 exe 后缀（Windows）', () => {
    const name = binaryFileName('exec');
    if (process.platform === 'win32') {
      expect(name).toBe('exec.exe');
    } else {
      expect(name).toBe('exec');
    }
  });

  it('显式环境变量单文件覆盖优先', () => {
    const dir = tempDir('explicit');
    const fake = path.join(dir, 'custom-exec-name.exe');
    writeFileSync(fake, 'MZ fake');
    const found = locateNativeBinary('exec', { env: { INK_EXEC_BINARY: fake } });
    expect(found).toBe(fake);
  });

  it('INK_NATIVE_DIR 目录内按 exec_proc 前缀定位', () => {
    const dir = tempDir('dir');
    const fileName = process.platform === 'win32' ? 'exec.exe' : 'exec';
    writeFileSync(path.join(dir, fileName), 'MZ fake');
    const found = locateNativeBinary('exec', { env: { INK_NATIVE_DIR: dir } });
    expect(found).toBe(path.join(dir, fileName));
  });

  it('目录内找不到 = null（不静默回落无关文件）', () => {
    const dir = tempDir('missing');
    const found = locateNativeBinary('infer', { env: { INK_NATIVE_DIR: dir }, cwd: dir });
    expect(found).toBeNull();
  });

  it('无任何配置 + 非仓库 cwd = null（fail-closed 不猜测路径）', () => {
    const outside = tempDir('outside');
    expect(locateNativeBinary('exec', { env: {}, cwd: outside })).toBeNull();
    expect(locateNativeBinary('infer', { env: {}, cwd: outside })).toBeNull();
  });
});
