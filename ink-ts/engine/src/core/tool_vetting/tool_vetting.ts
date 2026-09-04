/**
 * 工具可信度闸门机制：清单校验 → 静态审查 → 判定，以及观察模式（影子
 * 运行：独立工作目录副本 + 写操作虚拟化 + 结果恒标记 untrusted）。镜像
 * Python ink_engine.core.tool_vetting 的 ToolVetting 与模块级工具函数。
 *
 * 安全边界（fail-closed）：
 * - 未知来源且无签名 = 清单校验拒绝（签名缺失拒绝）；
 * - 权限声明逐项解析（parse_permission，声明非法 = 拒绝）；
 * - 静态审查钩子命中 = 结果降级 review（需人工）或 rejected（strict）；
 * - 影子运行 = 写虚拟化（独立工作目录副本 + 快照 diff），结果恒标记
 *   untrusted（观察数据不作信任依据，只作行为证据）。
 *
 * 装配：static_hooks（宿主注入静态审查钩子：ruff/pyright/eslint/tsc/
 * npm audit 等）。静态审查默认非空操作（ENG6-7）：出厂基线附带
 * code_files_exist（代码文件存在性校验）——宿主未注入任何钩子时审查至少
 * 覆盖「声明的代码文件真实存在」，杜绝「零钩子 = 静态审查静默空操作」；
 * 宿主注入钩子时存在性校验仍保留（低成本前置防线，与宿主钩子叠加）。
 *
 * TS 移植说明：
 * - 零 IO：os/shutil/tempfile 动作经 FsSeam 注入（见 _types.ts），core
 *   不 import node:fs；未注入 fs 的实例触碰文件面时抛错（fail-closed）；
 * - 无 logger、无时间/随机 seam（确定性）；
 * - code_files_exist 需 fs 判定文件存在（Python 侧默认注入 stdlib 实现，
 *   TS 侧存在性检查的 fs 来自 ToolVetting 构造注入）。
 */
import { parse_permission } from '../permissions/permissions.js';
import { ToolSource, ToolManifest, ShadowRunResult, ShadowWrite, VettingCheck, VettingResult, VettingVerdict, pyRepr } from './_types.js';
import type { FsSeam, ShadowExecutor, StaticHook } from './_types.js';

export { ToolSource, ToolManifest, ShadowRunResult, ShadowWrite, VettingCheck, VettingResult, VettingVerdict } from './_types.js';
export type { FsSeam, ShadowExecutor, StaticHook } from './_types.js';

// 哈希声明形态（sha256 hex，64 字符）
const _HASH_LENGTH = 64;

/** hex 校验（对齐 Python int(digest, 16)：容忍首尾空白与 0x 前缀）。 */
function _is_hex(digest: string): boolean {
  const hex = digest.trim();
  return /^(?:0[xX])?[0-9a-fA-F]+$/.test(hex);
}

/** 异常 → 文案（Python str(exc) 的镜像）。 */
function _excText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Python inspect.isawaitable 判定（影子观察回调的同步/异步兼容）。 */
function _isAwaitable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** 跨平台 basename（模块内统一以 '/' 拼接影子工作区路径）。 */
function _basename(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/');
  return i === -1 ? norm : norm.slice(i + 1);
}

function _join(parent: string, child: string): string {
  return parent.endsWith('/') ? `${parent}${child}` : `${parent}/${child}`;
}

/** 目录内容快照：相对路径 → 文件字节数（执行前/后 diff 的依据）。 */
function _snapshot_tree(root: string, fs: FsSeam): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const path of fs.rglob(root).slice().sort()) {
    if (!fs.is_file(path)) continue;
    let rel = path.slice(root.length);
    if (rel.startsWith('/') || rel.startsWith('\\')) rel = rel.slice(1);
    if (rel === '') continue;
    const size = fs.stat_size(path);
    if (size === null) continue;
    snapshot[rel] = size;
  }
  return snapshot;
}

/** 目录递归拷贝（影子工作区模板；符号链接按链接复制防逃逸）。 */
function _copy_tree(source: string, target: string, fs: FsSeam): void {
  fs.mkdir(target);
  for (const entry of fs.iterdir(source)) {
    const name = _basename(entry);
    if (fs.is_symlink(entry)) {
      fs.symlink_to(fs.readlink(entry), _join(target, name));
    } else if (fs.is_dir(entry)) {
      _copy_tree(entry, _join(target, name), fs);
    } else if (fs.is_file(entry)) {
      fs.copy2(entry, _join(target, name));
    }
  }
}

/** 前后快照 diff → 写操作清单（新增/修改/删除）。 */
function _diff_writes(
  before: Record<string, number>,
  after: Record<string, number>,
): ShadowWrite[] {
  const writes: ShadowWrite[] = [];
  for (const path of Object.keys(after)) {
    const size = after[path] as number;
    if (!(path in before)) {
      writes.push(new ShadowWrite({ path, operation: 'write', size }));
    } else if ((before[path] as number) !== size) {
      writes.push(new ShadowWrite({ path, operation: 'modify', size }));
    }
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) {
      writes.push(new ShadowWrite({ path, operation: 'delete' }));
    }
  }
  return writes;
}

/** 常用静态审查前置钩子：代码文件存在性校验（宿主可复用；fs 由宿主注入）。 */
export function code_files_exist(
  code_paths: readonly string[],
  fs: FsSeam,
): string[] {
  const missing = code_paths.filter((p) => !fs.is_file(p));
  return missing.map((path) => `代码文件缺失: ${path}`);
}

/** 工具可信度闸门（清单校验 + 静态审查钩子 + 影子运行）。 */
export class ToolVetting {
  private readonly _static_hooks: readonly StaticHook[];
  private readonly _fs: FsSeam;

  constructor(init: { static_hooks?: readonly StaticHook[]; fs?: FsSeam } = {}) {
    // 默认附加 code_files_exist（ENG6-7）：宿主未注入/部分注入时静态审查
    // 恒有基础防线。存在性判定经注入 fs；未注入 fs = 触碰文件面时抛错。
    const fs = init.fs ?? unavailableFs();
    this._fs = fs;
    const existHook: StaticHook = (code_paths) => code_files_exist(code_paths, fs);
    this._static_hooks = [existHook, ...(init.static_hooks ?? [])];
  }

  /** 执行闸门：清单校验 → 静态审查 → 判定。 */
  async vet(
    manifest: ToolManifest,
    code_paths: readonly string[] = [],
    opts: { strict?: boolean } = {},
  ): Promise<VettingResult> {
    const strict = opts.strict ?? false;
    const checks: VettingCheck[] = [await this._check_manifest(manifest)];
    if (!(checks[0] as VettingCheck).ok) {
      return new VettingResult({
        ok: false,
        verdict: VettingVerdict.REJECTED,
        checks,
        reason: (checks[0] as VettingCheck).detail,
      });
    }
    const static_violations: string[] = [];
    for (let index = 0; index < this._static_hooks.length; index++) {
      const hook = this._static_hooks[index] as StaticHook;
      let violations: string[];
      try {
        violations = hook([...code_paths]);
      } catch (exc) {
        violations = [`静态审查钩子异常: ${_excText(exc)}`];
      }
      static_violations.push(...violations);
      checks.push(
        new VettingCheck({
          name: `static_hook_${index + 1}`,
          ok: violations.length === 0,
          detail: violations.join('；') || '通过',
        }),
      );
    }
    if (static_violations.length > 0) {
      // strict = 命中直接 rejected（高危形态）；默认命中降级 review（需人工确认）
      const verdict = strict ? VettingVerdict.REJECTED : VettingVerdict.REVIEW;
      return new VettingResult({
        ok: verdict === VettingVerdict.REVIEW,
        verdict,
        checks,
        reason: static_violations.slice(0, 5).join('；'),
      });
    }
    return new VettingResult({
      ok: true,
      verdict: VettingVerdict.VERIFIED,
      checks,
    });
  }

  /** 观察模式：独立影子工作区执行 + 写虚拟化（结果恒 untrusted）。 */
  async shadow_run(
    executor: ShadowExecutor,
    args: Record<string, unknown>,
    opts: { workdir: string },
  ): Promise<ShadowRunResult> {
    const workdir = opts.workdir;
    if (!this._fs.is_dir(workdir)) {
      return new ShadowRunResult({ ok: false, error: `影子工作区不存在: ${workdir}` });
    }
    const shadow_root = this._fs.mkdtemp('forge-shadow-');
    const shadow_dir = _join(shadow_root, 'work');
    try {
      _copy_tree(workdir, shadow_dir, this._fs);
      const before = _snapshot_tree(shadow_dir, this._fs);
      let output = '';
      try {
        const result = executor(args, shadow_dir);
        output = String(_isAwaitable(result) ? await result : result);
      } catch (exc) {
        return new ShadowRunResult({ ok: false, output, error: _excText(exc) });
      }
      const after = _snapshot_tree(shadow_dir, this._fs);
      const writes = _diff_writes(before, after);
      return new ShadowRunResult({ ok: true, writes, output });
    } finally {
      this._fs.rmtree(shadow_root, true);
    }
  }

  /** 清单校验：来源/签名/哈希/权限声明（逐项 fail-closed）。 */
  private async _check_manifest(manifest: ToolManifest): Promise<VettingCheck> {
    const violations: string[] = [];
    if (manifest.source === ToolSource.UNKNOWN && !manifest.signature) {
      violations.push('来源未知且无签名（签名缺失拒绝）');
    }
    for (const perm of manifest.permissions) {
      try {
        parse_permission(perm);
      } catch (exc) {
        violations.push(`权限声明非法: ${pyRepr(perm)}（${_excText(exc)}）`);
      }
    }
    for (const [path, digest] of Object.entries(manifest.hashes)) {
      if (digest.length !== _HASH_LENGTH) {
        violations.push(`哈希声明非法（须 sha256 hex ${_HASH_LENGTH} 字符）: ${pyRepr(path)}`);
        continue;
      }
      if (!_is_hex(digest)) {
        violations.push(`哈希声明非法（非合法 hex 字符）: ${pyRepr(path)}`);
      }
    }
    if (manifest.permissions.length === 0) {
      violations.push('未声明权限（fail-closed：无权限声明的工具拒绝挂载）');
    }
    const ok = violations.length === 0;
    return new VettingCheck({
      name: 'manifest',
      ok,
      detail: violations.join('；') || '清单校验通过',
    });
  }
}

/** 未注入 fs 时的兜底 seam：触碰文件面即抛错（zero-IO 核心的 fail-closed）。 */
function unavailableFs(): FsSeam {
  const raise = (): never => {
    throw new Error('文件系统 seam 未注入（zero-IO core；宿主须注入 fs 实现）');
  };
  return {
    mkdtemp: raise,
    rmtree: raise,
    is_dir: raise,
    is_file: raise,
    is_symlink: raise,
    readlink: raise,
    copy2: raise,
    symlink_to: raise,
    mkdir: raise,
    iterdir: raise,
    rglob: raise,
    stat_size: raise,
  };
}
