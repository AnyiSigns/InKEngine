/**
 * FileSandbox / FileSnapshot / snapshot_before 单测——逐点对标
 * ink_engine/tests/test_sandbox.py 的文件守卫与写前快照节。
 *
 * 语义检查点：
 * - resolve 相对/绝对路径归一并返回解析后的绝对路径（执行对象 = 校验对象）；
 * - '..'/越根绝对路径拒绝（SandboxViolation，消息含「路径越界」）；
 * - symlink 逃逸：realpath seam（宿主 fs）跟随到根外 = 拒绝，根内链接放行；
 * - validate 操作域白名单（FS_OPERATIONS），域外操作拒绝；
 * - 写前快照还原：原存在恢复旧内容、原不存在删除、重复还原不炸；
 * - 快照/还原的 fs 动作全部经 FileOps seam，未注入时还原抛错（fail-closed）。
 *
 * 延后用例（真实 fs IO，宿主 seam 实弹回归）：test_resolve_* 的 tmp_path
 * 真实目录/symlink 建链、test_snapshot_restore_* 的真实文件读写——
 * 本文件以内存 FileOps/realpath 注入验证机制编排，真实 fs 实现随宿主
 * 装配（host/cli）落地后对标。
 */
import { describe, expect, it } from 'vitest';

import { SandboxViolation } from '../../../src/core/errors.js';
import {
  FS_OPERATIONS,
  FileSandbox,
  FileSnapshot,
  snapshot_before,
  type FileOps,
} from '../../../src/core/sandbox/index.js';

/** 内存 FileOps 假体（真实 fs 的纯逻辑替身：exists/is_file/读写/删除）。 */
class FakeFileOps implements FileOps {
  readonly files = new Map<string, Uint8Array>();

  constructor(entries: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(entries)) {
      this.files.set(path, new TextEncoder().encode(text));
    }
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  is_file(path: string): boolean {
    return this.files.has(path);
  }

  read_bytes(path: string): Uint8Array {
    return this.files.get(path)!;
  }

  mkdir_parents(path: string): void {
    void path;
  }

  write_bytes(path: string, data: Uint8Array): void {
    this.files.set(path, new Uint8Array(data));
  }

  unlink(path: string): void {
    this.files.delete(path);
  }

  text(path: string): string {
    return new TextDecoder('utf-8').decode(this.files.get(path)!);
  }
}

/** realpath seam 假体：显式链接表命中则跟随，未命中按词法原样返回。 */
function fakeRealpath(links: Record<string, string>): (path: string) => string {
  return (path) => links[path] ?? path;
}

describe('FileSandbox 路径守卫', () => {
  it('相对/绝对路径解析到根内绝对路径（Windows 盘符风格）', () => {
    const sb = new FileSandbox('C:\\ws');
    expect(sb.resolve('book/a.md')).toBe('C:\\ws\\book\\a.md');
    expect(sb.resolve('C:\\ws\\book\\a.md')).toBe('C:\\ws\\book\\a.md');
  });

  it('相对/绝对路径解析（POSIX 根风格）', () => {
    const sb = new FileSandbox('/sandbox');
    expect(sb.resolve('book/a.md')).toBe('/sandbox/book/a.md');
    expect(sb.resolve('/sandbox/book/a.md')).toBe('/sandbox/book/a.md');
  });

  it('不存在的深层路径按词法解析不拒绝', () => {
    const sb = new FileSandbox('C:\\ws');
    expect(sb.resolve('new/ch1.md')).toBe('C:\\ws\\new\\ch1.md');
    const posix = new FileSandbox('/sandbox');
    expect(posix.resolve('new/ch1.md')).toBe('/sandbox/new/ch1.md');
  });

  it('越界路径拒绝（相对 .. / 根外绝对路径）', () => {
    const sb = new FileSandbox('C:\\ws');
    for (const bad of ['../outside.md', 'C:\\outside.md', '..', 'C:\\ws\\..\\outside.md']) {
      expect(() => sb.resolve(bad)).toThrow(SandboxViolation);
      expect(() => sb.resolve(bad)).toThrow('路径越界');
    }
  });

  it('越界路径拒绝（POSIX 风格）', () => {
    const sb = new FileSandbox('/sandbox');
    for (const bad of ['../outside.md', '/outside.md', '..']) {
      expect(() => sb.resolve(bad)).toThrow('路径越界');
    }
  });

  it('symlink 逃逸：realpath 跟随到根外 = 拒绝', () => {
    const links = { 'C:\\box\\link.md': 'C:\\secret\\outside.txt' };
    const sb = new FileSandbox('C:\\box', fakeRealpath(links));
    expect(() => sb.resolve('link.md')).toThrow('路径越界');
  });

  it('根内 symlink：realpath 跟随到根内 = 放行并返回解析结果', () => {
    const links = { 'C:\\box\\link.md': 'C:\\box\\real\\a.md' };
    const sb = new FileSandbox('C:\\box', fakeRealpath(links));
    expect(sb.resolve('link.md')).toBe('C:\\box\\real\\a.md');
  });

  it('guards_operation：只守卫 FS_OPERATIONS 操作域', () => {
    const sb = new FileSandbox('C:\\ws');
    for (const op of FS_OPERATIONS) {
      expect(sb.guards_operation(op)).toBe(true);
    }
    expect(sb.guards_operation('chmod')).toBe(false);
    expect(sb.guards_operation('exec')).toBe(false);
  });

  it('validate：域内操作返回解析路径，域外操作拒绝', () => {
    const sb = new FileSandbox('C:\\ws');
    expect(sb.validate('read', 'a.md')).toBe('C:\\ws\\a.md');
    expect(sb.validate('write', 'sub/b.md')).toBe('C:\\ws\\sub\\b.md');
    expect(sb.validate('search', 'docs')).toBe('C:\\ws\\docs');
    expect(() => sb.validate('chmod', 'a.md')).toThrow('不支持的 fs 操作: chmod');
  });
});

describe('写前快照（FileSnapshot/snapshot_before）', () => {
  it('原存在：快照旧内容，改写后可还原', () => {
    const ops = new FakeFileOps({ 'C:\\docs\\a.md': '旧内容' });
    const snap = snapshot_before('C:\\docs\\a.md', ops);
    expect(snap.existed).toBe(true);
    expect(new TextDecoder().decode(snap.content!)).toBe('旧内容');
    ops.write_bytes('C:\\docs\\a.md', new TextEncoder().encode('新内容'));
    snap.restore();
    expect(ops.text('C:\\docs\\a.md')).toBe('旧内容');
  });

  it('原不存在：快照标记未存在，写入后可还原为删除', () => {
    const ops = new FakeFileOps();
    const snap = snapshot_before('C:\\docs\\b.md', ops);
    expect(snap.existed).toBe(false);
    ops.write_bytes('C:\\docs\\b.md', new TextEncoder().encode('新内容'));
    snap.restore();
    expect(ops.exists('C:\\docs\\b.md')).toBe(false);
  });

  it('重复还原不炸（幂等）', () => {
    const ops = new FakeFileOps({ 'C:\\docs\\c.md': 'x' });
    const snap = snapshot_before('C:\\docs\\c.md', ops);
    snap.restore();
    snap.restore();
    expect(ops.text('C:\\docs\\c.md')).toBe('x');
  });

  it('原存在但内容为空：还原写空内容', () => {
    const ops = new FakeFileOps();
    const snap = new FileSnapshot('C:\\docs\\d.md', true, null, ops);
    snap.restore();
    expect(ops.exists('C:\\docs\\d.md')).toBe(true);
    expect(ops.files.get('C:\\docs\\d.md')!.length).toBe(0);
  });

  it('未注入 FileOps 的还原抛错（fail-closed，不静默跳过）', () => {
    const snap = new FileSnapshot('C:\\docs\\e.md', true, null);
    expect(() => snap.restore()).toThrow('需要宿主文件执行体');
  });
});
