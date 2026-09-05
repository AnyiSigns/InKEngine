/**
 * 本地运行时提供器（environments.py LocalProvider 移植，默认形态）。
 *
 * 就绪判定：spec.tools 全部可用（PATH 可寻）；缺工具且声明了安装命令 → 按
 * install_cmds 顺序经 ProcessSandbox 执行（命令须在白名单内，安装失败 = 实例
 * 标记 failed）；运行 = 白名单命令 + 工作目录限定（envs/<name>）+ 超时/输出
 * 截断（ProcessSandbox 现成）。环境声明变更（含版本约束变化）= 旧实例销毁
 * 重建——版本回退语义由声明回退（补丁链）驱动，实例跟随重建。注入 storage
 * 时安装/运行动作落审计（append-only）；未注入 = 跳过审计（审计是增强不是
 * 收紧）。
 *
 * core 零 IO 的 seam 化：工具查找（shutil.which）与工作目录创建
 * （Path.mkdir(parents=True, exist_ok=True)）是文件面动作，由宿主注入——
 * 缺省 fail-closed（触碰即抛错提示注入）；执行经 ProcessSandbox.spawner seam。
 * 审计的 ts/key 本属 time/uuid 副作用，改为注入 now/keyGen（缺省确定值，
 * 纯函数可复现）。
 *
 * 状态标注（机制就绪 / 宿主接线点待定）：本地环境提供器为默认形态，运行
 * 前须宿主注入 fs/进程 seam（which/mkdirs/ProcessSandbox.spawner 与审计
 * 存储）；引擎侧当前无装配消费方（接线点：宿主运行时装配
 * EnvironmentProviders）。
 */
import { GraphDefinitionError } from '../errors.js';
import { ProcessResult, ProcessSandbox } from '../sandbox/index.js';

import {
  ENV_AUDIT_COLLECTION,
  ENV_STATUS_DESTROYED,
  ENV_STATUS_FAILED,
  ENV_STATUS_INSTALLING,
  ENV_STATUS_READY,
  DEFAULT_ENVS_DIR,
} from './constants.js';
import { displayInstallCmd, parseInstallCmd } from './install_cmd.js';
import { pyRepr } from './_repr.js';
import { EnvironmentHandle, EnvironmentSpec, RuntimeKind } from './spec.js';
import type { EnvAuditStorage } from './_types.js';

/** 工具查找 seam（shutil.which 镜像：PATH 可寻返回路径；不可寻返回 null）。 */
export type ToolLookup = (tool: string) => string | null;

/** 目录创建 seam（Path.mkdir(parents=True, exist_ok=True) 镜像）。 */
export type Mkdirs = (path: string) => void;

/** 缺省时间源：确定值 0（镜像 ledger/audit_log 的 now 缺省）。 */
const DEFAULT_NOW = (): number => 0;

/** 缺省键片段源：固定 8 位十六进制（uuid4().hex[:8] 的确定复现）。 */
const DEFAULT_KEY_GEN = (): string => '00000000';

/** LocalProvider 注入面（文件/seam/时钟全部可注入，缺省零 IO 可复现）。 */
export interface LocalProviderOptions {
  envs_dir?: string;
  storage?: EnvAuditStorage | null;
  which?: ToolLookup;
  mkdirs?: Mkdirs;
  now?: () => number;
  keyGen?: () => string;
}

/** 未注入文件 seam 时的兜底：触碰文件面即抛错（zero-IO core 的 fail-closed）。 */
function _noFsSeam(what: string): never {
  throw new Error(`${what} 需要宿主文件执行体（LocalProvider seam 未注入）`);
}

/** Path(envs_dir) / spec.name 的词法镜像：name 绝对则整体替换；相对则 '/' 拼接。
 *  core 零 IO 不查宿主平台（'/' 在 Node fs 跨平台可用），命名段不做归一。 */
function _env_workdir(envs_dir: string, name: string): string {
  if (
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(name)
  ) {
    return name;
  }
  if (envs_dir === '') return name;
  if (envs_dir.endsWith('/') || envs_dir.endsWith('\\')) return `${envs_dir}${name}`;
  return `${envs_dir}/${name}`;
}

/** dataclasses.replace(self._sandbox, cwd=workdir) 镜像：换 cwd 复刻沙箱。 */
function _with_cwd(sandbox: ProcessSandbox, cwd: string): ProcessSandbox {
  return new ProcessSandbox(
    sandbox.allowlist,
    sandbox.timeout,
    cwd,
    sandbox.max_output,
    sandbox.env,
    sandbox.path,
    sandbox.spawner,
  );
}

/** 本地运行时提供器（默认形态：白名单安装 + 沙箱运行）。 */
export class LocalProvider {
  readonly name = 'local';
  private readonly _sandbox: ProcessSandbox;
  private readonly _envs_dir: string;
  private readonly _storage: EnvAuditStorage | null;
  private readonly _which: ToolLookup;
  private readonly _mkdirs: Mkdirs;
  private readonly _now: () => number;
  private readonly _key_gen: () => string;
  private readonly _instances: Map<string, EnvironmentHandle> = new Map();

  constructor(sandbox?: ProcessSandbox | null, options: LocalProviderOptions = {}) {
    this._sandbox = sandbox ?? new ProcessSandbox();
    this._envs_dir = options.envs_dir ?? DEFAULT_ENVS_DIR;
    this._storage = options.storage ?? null;
    this._which = options.which ?? (() => _noFsSeam('工具查找（which）'));
    this._mkdirs = options.mkdirs ?? (() => _noFsSeam('工作目录创建（mkdir）'));
    this._now = options.now ?? DEFAULT_NOW;
    this._key_gen = options.keyGen ?? DEFAULT_KEY_GEN;
  }

  /** 按声明提供环境（幂等：已就绪且声明未变返回既有实例；声明变更销毁重建）。 */
  async ensure(spec: EnvironmentSpec): Promise<EnvironmentHandle> {
    if (spec.runtime !== RuntimeKind.LOCAL) {
      throw new GraphDefinitionError(
        `本地提供器不承接 ${spec.runtime} 环境: ${spec.name}`,
      );
    }
    const existing = this._instances.get(spec.name);
    if (existing !== undefined && existing.status === ENV_STATUS_READY) {
      if (existing.spec.equals(spec)) return existing;
      // 声明已变更（含版本约束）：旧实例按当前声明销毁重建——环境形态跟随声明
      await this.destroy(existing);
    }
    const missing = spec.tools.filter((tool) => this._which(tool) === null);
    if (missing.length > 0 && spec.install_cmds.length > 0) {
      await this._install(spec);
    } else if (missing.length > 0) {
      const handle = this._make_handle(spec, ENV_STATUS_FAILED);
      handle.error = `工具缺失且未声明安装命令: ${pyRepr(missing)}`;
      this._instances.set(spec.name, handle);
      return handle;
    }
    const handle = this._make_handle(spec);
    this._instances.set(spec.name, handle);
    return handle;
  }

  /** 销毁实例（幂等：已销毁静默成功，实例从注册表移除）。 */
  async destroy(handle: EnvironmentHandle): Promise<void> {
    handle.status = ENV_STATUS_DESTROYED;
    this._instances.delete(handle.spec.name);
  }

  /** 运行白名单命令（工作目录限定 envs/<name>；未就绪返回 -1 结果不执行）。 */
  async run(
    handle: EnvironmentHandle,
    command: string,
    args: readonly string[] = [],
  ): Promise<ProcessResult> {
    if (handle.status !== ENV_STATUS_READY) {
      return new ProcessResult(-1, '', `环境未就绪: ${handle.status}`);
    }
    const workdir = handle.workdir ?? '.';
    this._mkdirs(workdir);
    const runSandbox = _with_cwd(this._sandbox, workdir);
    const result = await runSandbox.run(command, args);
    await this._audit({
      action: 'run',
      env: handle.spec.name,
      command: `${command} ${args.join(' ')}`.trim(),
      ok: result.exit_code === 0,
    });
    return result;
  }

  /** 懒装：按 install_cmds 顺序执行（命令须在白名单，安装失败 = 实例 failed）。 */
  private async _install(spec: EnvironmentSpec): Promise<void> {
    const handle = this._make_handle(spec, ENV_STATUS_INSTALLING);
    this._instances.set(spec.name, handle);
    const workdir = handle.workdir ?? '.';
    this._mkdirs(workdir);
    const installSandbox = _with_cwd(this._sandbox, workdir);
    try {
      for (const cmd of spec.install_cmds) {
        // 结构化解析：字符串形态 shlex 分词（引号安全），结构化 (cmd, args) 直取
        const [command, args] = parseInstallCmd(cmd);
        if (!command || !this._sandbox.allowlist.includes(command)) {
          throw new GraphDefinitionError(
            `安装命令不在白名单: ${pyRepr(cmd)}（fail-closed）`,
          );
        }
        const result = await installSandbox.run(command, args);
        if (result.exit_code !== 0) {
          throw new GraphDefinitionError(
            `安装失败 [${pyRepr(cmd)}]: exit=${result.exit_code} ${result.stderr.slice(0, 200)}`,
          );
        }
      }
    } catch (exc) {
      handle.status = ENV_STATUS_FAILED;
      handle.error = exc instanceof Error ? exc.message : String(exc);
      await this._audit({
        action: 'install',
        env: spec.name,
        command: spec.install_cmds.map(displayInstallCmd).join('; '),
        ok: false,
        detail: handle.error.slice(0, 200),
      });
      throw exc;
    }
    handle.status = ENV_STATUS_READY;
    await this._audit({
      action: 'install',
      env: spec.name,
      command: spec.install_cmds.map(displayInstallCmd).join('; '),
      ok: true,
    });
  }

  /** 环境动作留痕（append-only；无 storage 或写失败一律跳过——审计是增强）。 */
  private async _audit(input: {
    action: string;
    env: string;
    command: string;
    ok: boolean;
    detail?: string;
  }): Promise<void> {
    if (this._storage === null) return;
    const ts = this._now();
    const record: Record<string, unknown> = {
      action: input.action,
      env: input.env,
      command: input.command.slice(0, 500),
      ok: input.ok,
      ts,
    };
    if (input.detail !== undefined && input.detail !== '') record['detail'] = input.detail;
    const key = `${ts.toFixed(3)}-${this._key_gen().slice(0, 8)}`;
    try {
      await this._storage.put_record(ENV_AUDIT_COLLECTION, key, record);
    } catch {
      // 审计失败不阻断环境动作（审计是增强不是收紧）
    }
  }

  /** 句柄构造：env_id = 环境名，workdir 限定在 envs/<name>。 */
  private _make_handle(
    spec: EnvironmentSpec,
    status: string = ENV_STATUS_READY,
  ): EnvironmentHandle {
    return new EnvironmentHandle({
      env_id: spec.name,
      spec,
      status,
      workdir: _env_workdir(this._envs_dir, spec.name),
    });
  }
}
