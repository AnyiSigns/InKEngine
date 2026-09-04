/**
 * Builder 测试共享假体：内存 BuildFs 与内存 SpawnSeam（_fixtures.ts）。
 *
 * builder_pipeline / builder_smoke 两份测试共用同一套 zero-IO 执行体假体
 * （与 process_sandbox.test 同型：内存假体验证编排），抽离后各测试文件
 * 保持在 350 行以内。node:crypto 仅用于 sha256 参照（_sha256.ts 为纯 TS
 * 实现，测试以独立实现交叉验证）。
 */
import { createHash } from 'node:crypto';

import { Builder, BuildKind, BuildSpec } from '../../../src/core/builder/index.js';
import type { BuildKindValue } from '../../../src/core/builder/index.js';
import type { BuildFs } from '../../../src/core/builder/_types.js';
import {
  ProcessSandbox,
  type SpawnHandle,
  type SpawnSeam,
} from '../../../src/core/sandbox/index.js';

export const BUILD_CMD = 'C:\\tools\\build.exe';
export const ARTIFACT_ROOT = 'C:\\ws\\artifacts';

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** node:crypto 独立参照（验证纯 TS sha256 与内容寻址编排的正确性）。 */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── 内存 BuildFs 假体（真实 node:fs 的纯逻辑替身，Windows 盘符风格） ──────

export class FakeFs implements BuildFs {
  readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();
  cwd = 'C:\\ws';

  constructor() {
    this.dirs.add('C:\\');
  }

  private _norm(path: string): string {
    let p = path.trim().replace(/\//g, '\\').replace(/\\+/g, '\\');
    while (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1);
    return p;
  }

  private _parent(path: string): string {
    const idx = path.lastIndexOf('\\');
    if (idx === 2) return path.slice(0, 3);
    if (idx <= 0) return path;
    return path.slice(0, idx);
  }

  private _add_dir_chain(path: string): void {
    let cur = path;
    for (;;) {
      this.dirs.add(cur);
      if (cur.length <= 3) break;
      const next = this._parent(cur);
      if (next === cur) break;
      cur = next;
    }
  }

  add_dir(path: string): void {
    this._add_dir_chain(this._norm(path));
  }

  write_file(path: string, content: string | Uint8Array): void {
    const n = this._norm(path);
    this._add_dir_chain(this._parent(n));
    this.files.set(n, typeof content === 'string' ? encode(content) : content);
  }

  text(path: string): string {
    const bytes = this.files.get(this._norm(path));
    if (bytes === undefined) throw new Error(`文件不存在: ${path}`);
    return new TextDecoder('utf-8').decode(bytes);
  }

  resolve(path: string): string {
    if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\') || path.startsWith('/')) {
      return this._norm(path);
    }
    return this._norm(`${this.cwd}\\${path}`);
  }

  is_dir(path: string): boolean {
    return this.dirs.has(this._norm(path));
  }

  is_file(path: string): boolean {
    return this.files.has(this._norm(path));
  }

  read_bytes(path: string): Uint8Array {
    const bytes = this.files.get(this._norm(path));
    if (bytes === undefined) throw new Error(`文件不存在: ${path}`);
    return bytes;
  }

  mkdir_parents(path: string): void {
    this._add_dir_chain(this._norm(path));
  }

  copy_file(source: string, target: string): void {
    const bytes = this.files.get(this._norm(source));
    if (bytes === undefined) throw new Error(`拷贝源不存在: ${source}`);
    const dst = this._norm(target);
    this._add_dir_chain(this._parent(dst));
    this.files.set(dst, new Uint8Array(bytes));
  }
}

// ── 内存 SpawnSeam 假体（记录调用；产物产出经 on_spawn 模拟） ──────────────

interface SpawnCall {
  command: string;
  args: readonly string[];
  cwd: string | null;
}

class FakeHandle implements SpawnHandle {
  readonly exit_code: number | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;

  constructor(exit_code: number, stdout: Uint8Array, stderr: Uint8Array) {
    this.exit_code = exit_code;
    this.stdout = stdout;
    this.stderr = stderr;
  }

  async communicate(): Promise<{ stdout: Uint8Array; stderr: Uint8Array }> {
    return { stdout: this.stdout, stderr: this.stderr };
  }

  kill(): void {}
}

export class FakeSpawn implements SpawnSeam {
  readonly calls: SpawnCall[] = [];
  script: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => { exit_code?: number; stdout?: string; stderr?: string } = () => ({ exit_code: 0 });
  on_spawn: ((cwd: string) => void) | null = null;

  async spawn(
    command: string,
    args: readonly string[],
    options: { cwd: string | null; env: Readonly<Record<string, string>> },
  ): Promise<SpawnHandle> {
    this.calls.push({ command, args: [...args], cwd: options.cwd });
    const cwd = options.cwd ?? '';
    if (this.on_spawn !== null) this.on_spawn(cwd);
    const result = this.script(command, args, cwd);
    return new FakeHandle(
      result.exit_code ?? 0,
      encode(result.stdout ?? ''),
      encode(result.stderr ?? ''),
    );
  }
}

export function makeBuilder(spawn: FakeSpawn, fs: FakeFs, now: () => number = () => 100.0): Builder {
  const sandbox = new ProcessSandbox([BUILD_CMD], 30.0, null, 100_000, null, null, spawn);
  return new Builder(sandbox, ARTIFACT_ROOT, { fs, now });
}

export function buildSpec(opts: {
  kind?: string;
  workdir: string;
  args?: readonly string[];
  output_paths: readonly string[];
  timeout?: number;
}): BuildSpec {
  return new BuildSpec({
    kind: (opts.kind ?? BuildKind.SERVICE) as BuildKindValue,
    command: BUILD_CMD,
    args: opts.args ?? [],
    workdir: opts.workdir,
    timeout: opts.timeout ?? 120.0,
    output_paths: opts.output_paths,
  });
}
