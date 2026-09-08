/**
 * material.import 目录扫描 + 三重上限（scanMaterial 对标）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MaterialError, scanMaterial } from '../../src/material/scan.js';
import type { DocParser } from '../../src/doc/_types.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ink-material-scan-'));
  dirs.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理兜底
    }
  }
});

const docParser: DocParser = {
  async parseDocument(p, _root, _maxChars) {
    return { ok: true as const, format: 'pdf', text: `parsed:${path.basename(p)}`, page_count: 1, truncated: false };
  },
};

describe('scanMaterial：扫描归一', () => {
  it('md/json 归一，bin 跳过，符号/目录不混入', async () => {
    const dir = tempDir();
    write(dir, 'note.md', '# 标题\n正文');
    write(dir, 'data.json', '{"a":1}');
    write(dir, 'ignore.bin', 'binary');
    const result = await scanMaterial({ root: dir, recursive: false }, { parse: docParser });
    expect(result.files.length).toBe(2);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]!.reason).toContain('不支持的格式');
    expect(result.files.find((f) => f.format === 'md')?.text).toContain('标题');
  });

  it('doc 走解析器（文本提取）；解析失败记 skipped', async () => {
    const dir = tempDir();
    write(dir, 'a.pdf', 'pdf bytes');
    const failing: DocParser = {
      async parseDocument() {
        return { ok: false as const, code: 'format', message: 'bad pdf' };
      },
    };
    const result = await scanMaterial({ root: dir, recursive: false }, { parse: failing });
    expect(result.files.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]!.reason).toContain('解析失败');
  });

  it('单文件越体积上限记 skipped', async () => {
    const dir = tempDir();
    write(dir, 'big.txt', 'x'.repeat(1024));
    const result = await scanMaterial(
      { root: dir, recursive: false, maxFileBytes: 10 },
      { parse: docParser },
    );
    expect(result.files.length).toBe(0);
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0]!.reason).toContain('超体积上限');
  });
});

describe('scanMaterial：fail-closed', () => {
  it('文件数越限 = 结构化拒绝（不部分放行）', async () => {
    const dir = tempDir();
    write(dir, 'a.md', 'a');
    write(dir, 'b.md', 'b');
    write(dir, 'c.md', 'c');
    const error = await scanMaterial({ root: dir, recursive: false, maxFiles: 2 }, { parse: docParser }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MaterialError);
    expect((error as MaterialError).code).toBe('over_file_limit');
  });

  it('扫描根不在允许导入根内 = denied', async () => {
    const dir = tempDir();
    const error = await scanMaterial(
      { root: dir, recursive: false },
      { allowedRoots: [path.join(os.tmpdir(), 'no-such-root')] },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MaterialError);
    expect((error as MaterialError).code).toBe('denied');
  });

  it('路径不存在/非目录 = 结构化拒绝', async () => {
    const missing = await scanMaterial({ root: path.join(os.tmpdir(), 'nope-material-x'), recursive: false }).catch(
      (e: unknown) => e,
    );
    expect((missing as MaterialError).code).toBe('not_found');
    const file = path.join(tempDir(), 'a.md');
    write(path.dirname(file), path.basename(file), 'x');
    const notDir = await scanMaterial({ root: file, recursive: false }).catch((e: unknown) => e);
    expect((notDir as MaterialError).code).toBe('not_dir');
  });

  it('递归深度上限内不下探更深目录', async () => {
    const dir = tempDir();
    write(dir, 'sub/sub/deep.md', 'deep');
    const result = await scanMaterial({ root: dir, recursive: true, maxDepth: 1 }, { parse: docParser });
    expect(result.files.length).toBe(0);
    expect(result.skipped.length).toBe(0);
  });
});
