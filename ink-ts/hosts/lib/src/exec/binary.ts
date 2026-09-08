/**
 * exec/infer/ink_ts_mcp 原生命名二进制定位（声明驱动的 TS 承接面）。
 *
 * 二进制定位约定（与 exec 仓库布局对齐）：`cargo build` 产出落在
 * `ink-ts/exec/target/{debug,release}/exec(.exe)`、`infer(.exe)` 与
 * `ink_ts_mcp(.exe)`（一次构建后 dev/CI/多机自用直接复用同一二进制，零打
 * 包）。每二进制（kind=exec/infer/mcp）的**文件名 + env 覆盖键**为声明数据
 * （真源 = plugins/endpoints/<id>/spec.json data.native → 派生视图
 * hosts/lib/src/exec/native.generated.ts，禁手改）。定位优先序：
 * 1. 显式环境变量 `INK_EXEC_BINARY` / `INK_INFER_BINARY` /
 *    `INK_MCP_BINARY`（单文件覆盖；键名 = 声明 data.native.env）；
 * 2. `INK_NATIVE_DIR` 目录内的平台可执行形态；
 * 3. 向上探测 `ink-ts/exec/target/{debug,release}/`（debug 优先，
 *    CARGO_TARGET_DIR 亦按此 profile 布局探测）。
 * 定位失败返回 null（调用方决定：集成测试跳过 / 装配期报缺）。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { NATIVE_BINARY_DECLS, type NativeBinaryKind } from './native.generated.js';

/** 默认 target profile 探测顺序（debug 优先——开发期复用最近一次构建）。 */
const PROFILE_ORDER = ['debug', 'release'] as const;

/** 声明查找（id → {file, env}；NATIVE_BINARY_DECLS 来自 plugins/endpoints 派生）。 */
function declOf(kind: NativeBinaryKind): { file: string; env: string } | undefined {
  return NATIVE_BINARY_DECLS.find((decl) => decl.id === kind);
}

/** 文件名 = 声明 data.native.file（exec/infer/ink_ts_mcp；Windows 补 .exe）。 */
export function binaryFileName(kind: NativeBinaryKind): string {
  const decl = declOf(kind);
  if (decl === undefined) throw new Error(`未声明原生执行件端点 kind: ${kind}`);
  return `${decl.file}${process.platform === 'win32' ? '.exe' : ''}`;
}

/** 平台可执行形态判定（Windows = 可执行扩展名；其它平台 = 存在即可执行）。 */
function looksExecutable(name: string): boolean {
  if (process.platform !== 'win32') return true;
  const ext = path.extname(name).toLowerCase();
  return ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '.com';
}

/** 候选目录内按声明文件名定位（存在即返回绝对路径）。 */
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
  const decl = declOf(kind);

  // 1. 显式单文件覆盖（键名 = 声明 data.native.env）
  const explicit = decl !== undefined ? env[decl.env] : undefined;
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
