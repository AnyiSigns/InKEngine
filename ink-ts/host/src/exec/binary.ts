/**
 * exec/infer 原生命名二进制定位（exec_proc 前缀约定的 TS 承接面）。
 *
 * 二进制定位约定（与 exec 仓库布局对齐）：`cargo build` 产出落在
 * `ink-ts/exec/target/{debug,release}/exec(.exe)` 与 `infer(.exe)`
 * （一次构建后 dev/CI/多机自用直接复用同一二进制，零打包）。定位优先序：
 * 1. 显式环境变量 `INK_EXEC_BINARY` / `INK_INFER_BINARY`（单文件覆盖）；
 * 2. `INK_NATIVE_DIR` 目录内的平台可执行形态（exec_proc 前缀逻辑）；
 * 3. 向上探测 `ink-ts/exec/target/{debug,release}/`（debug 优先，
 *    CARGO_TARGET_DIR 亦按此 profile 布局探测）。
 * 定位失败返回 null（调用方决定：集成测试跳过 / 装配期报缺）。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { NativeBinaryKind } from './_types.js';

/** 显式单文件覆盖键（kind → env）。 */
const BINARY_ENV: Record<NativeBinaryKind, string> = {
  exec: 'INK_EXEC_BINARY',
  infer: 'INK_INFER_BINARY',
};

/** 默认 target profile 探测顺序（debug 优先——开发期复用最近一次构建）。 */
const PROFILE_ORDER = ['debug', 'release'] as const;

/** 文件名 = 二进制名（exec/infer；Windows 补 .exe）。 */
export function binaryFileName(kind: NativeBinaryKind): string {
  return `${kind}${process.platform === 'win32' ? '.exe' : ''}`;
}

/** 平台可执行形态判定（Windows = 可执行扩展名；其它平台 = 存在即可执行）。 */
function looksExecutable(name: string): boolean {
  if (process.platform !== 'win32') return true;
  const ext = path.extname(name).toLowerCase();
  return ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '.com';
}

/** 候选目录内按 exec_proc 前缀定位（文件名含 kind 前缀 + 可执行形态）。 */
function locateInDir(dir: string, kind: NativeBinaryKind): string | null {
  const file = path.join(dir, binaryFileName(kind));
  if (existsSync(file)) return file;
  return null;
}

/** 自下而上探测含 `ink-ts/exec/target` 的工作树祖先目录。 */
function locateByProfile(startDir: string, kind: NativeBinaryKind): string | null {
  let dir: string | null = startDir;
  const file = binaryFileName(kind);
  while (dir !== null) {
    const base = path.join(dir, 'ink-ts', 'exec');
    if (existsSync(path.join(base, 'Cargo.toml'))) {
      for (const profile of PROFILE_ORDER) {
        const candidate = path.join(base, 'target', profile, file);
        if (existsSync(candidate) && looksExecutable(file)) return candidate;
      }
      return null;
    }
    const parent = path.dirname(dir);
    dir = parent === dir ? null : parent;
  }
  return null;
}

/** 定位原生二进制（找不到返回 null；env/cwd 可注入便于测试）。 */
export function locateNativeBinary(
  kind: NativeBinaryKind,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): string | null {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const file = binaryFileName(kind);

  // 1. 显式单文件覆盖
  const explicit = env[BINARY_ENV[kind]];
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) {
    return explicit;
  }
  // 2. INK_NATIVE_DIR 目录内定位
  const nativeDir = env['INK_NATIVE_DIR'];
  if (nativeDir !== undefined && nativeDir !== '') {
    const found = locateInDir(nativeDir, kind);
    if (found !== null) return found;
  }
  // 3a. CARGO_TARGET_DIR（构建重定向场景）
  const targetDir = env['CARGO_TARGET_DIR'];
  if (targetDir !== undefined && targetDir !== '') {
    for (const profile of PROFILE_ORDER) {
      const candidate = path.join(targetDir, profile, file);
      if (existsSync(candidate) && looksExecutable(file)) return candidate;
    }
  }
  // 3b. 工作树 target 布局探测
  return locateByProfile(cwd, kind);
}
