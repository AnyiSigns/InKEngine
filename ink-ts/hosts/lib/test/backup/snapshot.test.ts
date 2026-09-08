/**
 * backup 安全域单测（snapshot.ts）：路径逃逸拒绝（双分隔符/盘符/.. /resolve
 * 越界）、符号链接目录 fail-closed、快照产物目录不可覆盖、读侧体积封顶。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  READ_TOTAL_BYTES_CAP,
  applyRestore,
  readBackupFile,
} from '../../src/backup/snapshot.js';
import { BackupError } from '../../src/backup/snapshot.js';

const dirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ink-backup-safe-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function rejectsPath(dataDirPath: string, zipPath: string, code: string): Promise<void> {
  const entry = { path: zipPath, data: Buffer.from('x') };
  await expect(applyRestore(dataDirPath, [entry])).rejects.toMatchObject({
    name: 'BackupError',
    code,
  });
}

describe('backup 路径逃逸拒绝（fail-closed）', () => {
  it('绝对路径/盘符/.. /空段/反斜杠段一律拒绝', async () => {
    const root = dataDir();
    writeFileSync(join(root, 'marker.txt'), 'v1');
    await rejectsPath(root, '/etc/passwd', 'invalid_path');
    await rejectsPath(root, 'C:/windows/x', 'invalid_path');
    await rejectsPath(root, '../outside', 'invalid_path');
    await rejectsPath(root, 'a/../../outside', 'invalid_path');
    await rejectsPath(root, 'a/./b', 'invalid_path');
    await rejectsPath(root, 'a//b', 'invalid_path');
    // 反斜杠段（zip 内容可能来自外部文件，双分隔符统一拒绝）
    await rejectsPath(root, '..\\outside', 'invalid_path');
    await rejectsPath(root, 'a\\..\\outside', 'invalid_path');
    await rejectsPath(root, '\\windows\\x', 'invalid_path');
    // resolve 归一逃逸（重复点段解析后仍越界）
    await rejectsPath(root, 'a/../../b/../c/../../escape', 'invalid_path');
    // 合法条目照常落位（对照正例）
    const ok = await applyRestore(root, [{ path: 'sub/ok.txt', data: Buffer.from('y') }]);
    expect(ok.restored).toEqual(['sub/ok.txt']);
  });

  it('快照产物目录不可覆盖（snapshots/backups 首段拒绝）', async () => {
    const root = dataDir();
    await rejectsPath(root, 'snapshots/evil.zip', 'invalid_path');
    await rejectsPath(root, 'backups/x.zip', 'invalid_path');
  });
});

describe('backup 符号链接目录 fail-closed', () => {
  it('目标路径中间目录为 junction/符号链接 → 整单拒绝（不跟随写入）', async () => {
    const root = dataDir();
    const outside = dataDir();
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    let link: string;
    try {
      link = join(root, 'link');
      await fs.symlink(outside, link, 'junction');
    } catch {
      return; // 平台不允许建 junction（如 CI 无特权）：跳过该场景
    }
    await expect(applyRestore(root, [{ path: 'link/evil.txt', data: Buffer.from('x') }]))
      .rejects.toMatchObject({ name: 'BackupError', code: 'path_symlink' });
    // 外部目录未被写入
    expect(await fs.readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
  });
});

describe('backup 读侧体积封顶', () => {
  it('备份文件超过读侧上限 → too_large（不整包读入内存）', async () => {
    const root = dataDir();
    const huge = join(root, 'huge.zip');
    const handle = await fs.open(huge, 'w');
    try {
      await handle.truncate(READ_TOTAL_BYTES_CAP + 1);
    } finally {
      await handle.close();
    }
    await expect(readBackupFile(huge)).rejects.toBeInstanceOf(BackupError);
    await expect(readBackupFile(huge)).rejects.toMatchObject({ code: 'too_large' });
  });
});
