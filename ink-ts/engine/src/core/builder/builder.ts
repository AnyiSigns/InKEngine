/**
 * 本机构建管线（builder.py 的 Builder 移植）：白名单命令 + 产物哈希 +
 * 冒烟门禁。
 *
 * 构建是机制、产物可回退：AI 生成/挂载的代码（前端组件/任意语言工具/
 * 服务）经沙箱白名单命令构建（超时/隔离）；产物（bundle/二进制）落
 * 补丁链管理——产物哈希命名（artifact_id 内容寻址）、可回退、可审计；
 * 构建产物必须过冒烟门禁（启动/连通/回归）才可 promote；构建失败 =
 * 保留现状 + 留痕。
 *
 * 安全边界：构建/冒烟命令一律经白名单沙箱（fail-closed：未在白名单的
 * 命令显式拒绝）；产物目录哈希命名（artifact_id 内容寻址，防产物篡改
 * 静默切换）；哈希校验 = 部署/回退前的强制门禁；产物相对路径越界防护
 * （拒绝绝对路径与 '..' 片段——声明可来自补丁链/AI 生成，路径穿越会让
 * 构建管线读取并落盘任意文件）。
 *
 * TS 移植说明：
 * - 零 IO：Path.resolve/is_dir/is_file/读文件/mkdir/copy2 经 BuildFs
 *   seam 注入（见 _types.ts）；未注入 fs 的实例触碰文件面时抛错
 *   （fail-closed，对齐 tool_vetting 的 unavailableFs 口径）；
 * - 沙箱副本：dataclasses.replace(sandbox, cwd=..., timeout=...) 以新建
 *   ProcessSandbox 表达（字段复制 + 覆盖 cwd/timeout），build/smoke 各按
 *   声明注入超时；
 * - 无 logger；时间 seam 确定性：built_at 经注入 clock 取 epoch 秒，未
 *   注入按 0（core 零时间依赖，宿主装配时注入真实时钟）；
 * - 哈希为纯 TS sha256（_sha256.ts，core 禁 node:crypto）。
 *
 * 状态标注（机制就绪 / 宿主接线点待定）：构建 + 冒烟门禁，由 build 类
 * 补丁/自进化产物路径在配方开关开启时调用（默认开关：关——未启用前机制
 * 可用但不经引擎自动触发；BuildFs 须宿主注入）。
 */
import { GraphDefinitionError } from '../errors.js';
import { is_absolute } from '../sandbox/_path.js';
import { ProcessSandbox } from '../sandbox/index.js';
import { sha256_hex } from './_sha256.js';
import {
  BuildArtifact,
  BuildKind,
  BuildSpec,
  pyRepr,
  SmokeProbe,
  SmokeResult,
  type BuildFs,
} from './_types.js';

export {
  BuildArtifact,
  BuildKind,
  BuildSpec,
  SmokeProbe,
  SmokeResult,
} from './_types.js';
export type { BuildFs, BuildKindValue } from './_types.js';

// 产物哈希算法契约（sha256，hex 64 字符，内容寻址引擎内置——见
// _sha256.ts）；artifact_id = 内容哈希 hex 的前 16 字符前缀。
const _ARTIFACT_ID_PREFIX = 16;

/** 构建/冒烟失败（产物保留现状，不 promote）。 */
export class BuildError extends GraphDefinitionError {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

/** Python 元组形态渲染（错误文案的 {args}，如 ('run', 'build')）。 */
function _pyTuple(items: readonly string[]): string {
  if (items.length === 0) return '()';
  if (items.length === 1) return `(${pyRepr(items[0]!)},)`;
  return `(${items.map(pyRepr).join(', ')})`;
}

/** 路径拼接：以基准路径的分隔风格接子路径（相对产物段经归一后并入）。 */
function _join_path(base: string, child: string): string {
  if (child === '') return base;
  const sep = base.includes('\\') ? '\\' : '/';
  const norm_child = child.replace(sep === '\\' ? /\//g : /\\/g, sep);
  if (base.endsWith('\\') || base.endsWith('/')) return base + norm_child;
  return base + sep + norm_child;
}

/** 构建沙箱副本：工作目录限定 + 按声明超时（dataclasses.replace 镜像）。 */
function _sandbox_with(
  sandbox: ProcessSandbox,
  cwd: string,
  timeout: number,
): ProcessSandbox {
  return new ProcessSandbox(
    [...sandbox.allowlist],
    timeout,
    cwd,
    sandbox.max_output,
    sandbox.env,
    sandbox.path,
    sandbox.spawner,
  );
}

/**
 * 文件内容 sha256（hex 64）。Python 分块流式读取（防大文件整读占内存）；
 * TS core 的字节来源经 BuildFs.read_bytes seam（流式实现属宿主细节），
 * 哈希编排留在本函数。
 */
export function _sha256_file(path: string, fs: BuildFs): string {
  return sha256_hex(fs.read_bytes(path));
}

/** 未注入 fs 时的兜底 seam：触碰文件面即抛错（zero-IO 核心 fail-closed）。 */
function unavailable_fs(): BuildFs {
  const raise = (): never => {
    throw new Error('文件系统 seam 未注入（zero-IO core；宿主须注入 fs 实现）');
  };
  return {
    resolve: raise,
    is_dir: raise,
    is_file: raise,
    read_bytes: raise,
    mkdir_parents: raise,
    copy_file: raise,
  };
}

/**
 * 本机构建管线（白名单命令 + 产物哈希 + 冒烟门禁）。
 *
 * 装配：sandbox（白名单命令沙箱，构建与冒烟共用）、artifact_dir（产物
 * 根目录，哈希命名子目录）、fs（文件执行体 seam，core 零 IO）、clock
 * （时间 seam，built_at 用）。构建失败 = 抛 BuildError 且不落产物记录
 * （保留现状 + 调用方留痕）。
 */
export class Builder {
  private readonly _sandbox: ProcessSandbox;
  private readonly _artifact_dir: string;
  private readonly _fs: BuildFs;
  private readonly _now: () => number;

  constructor(
    sandbox: ProcessSandbox,
    artifact_dir: string,
    options: { fs?: BuildFs; now?: () => number } = {},
  ) {
    this._sandbox = sandbox;
    this._artifact_dir = artifact_dir;
    this._fs = options.fs ?? unavailable_fs();
    this._now = options.now ?? (() => 0);
  }

  /** 执行构建：产物拷贝进内容寻址目录 + 文件级 sha256 哈希。 */
  async build(spec: BuildSpec): Promise<BuildArtifact> {
    // 构建命令须在沙箱白名单内（fail-closed）
    if (!this._sandbox.allowlist.includes(spec.command)) {
      throw new BuildError(
        `构建命令不在白名单: ${pyRepr(spec.command)}（fail-closed）`,
      );
    }
    const workdir = this._fs.resolve(spec.workdir);
    if (!this._fs.is_dir(workdir)) {
      throw new BuildError(`构建工作目录不存在: ${workdir}`);
    }
    // 构建沙箱副本：工作目录限定在构建目录（构建命令产出落在目录内），
    // 超时按声明注入（声明值与沙箱执行一致，超时 kill 归因于构建）
    const build_sandbox = _sandbox_with(this._sandbox, workdir, spec.timeout);
    const result = await build_sandbox.run(spec.command, [...spec.args]);
    if (result.timed_out) {
      throw new BuildError(
        `构建超时（>${spec.timeout}s）: ${spec.command} ${_pyTuple(spec.args)}`,
      );
    }
    if (result.exit_code !== 0) {
      const detail = result.stderr !== '' ? result.stderr : result.stdout;
      throw new BuildError(
        `构建失败: exit=${result.exit_code} ${detail.slice(0, 300)}`,
      );
    }
    if (spec.output_paths.length === 0) {
      throw new BuildError('构建声明未指定 output_paths（无产物可收）');
    }
    // 产物哈希 + 越界防护：拒绝绝对路径与 '..' 片段（声明可来自补丁链/
    // AI 生成，路径穿越会让构建管线读取并落盘任意文件）
    const files: Record<string, string> = {};
    const contents: string[] = [];
    for (const relative of spec.output_paths) {
      if (
        is_absolute(relative) ||
        relative.split(/[\\/]+/).some((seg) => seg === '..')
      ) {
        throw new BuildError(
          `产物路径越界（拒绝绝对路径/..）: ${pyRepr(relative)}`,
        );
      }
      const source = _join_path(workdir, relative);
      if (!this._fs.is_file(source)) {
        throw new BuildError(`产物缺失: ${relative}`);
      }
      const digest = _sha256_file(source, this._fs);
      files[relative] = digest;
      contents.push(digest);
    }
    // 内容寻址：产物 id = 类别 + 文件内容哈希前缀（防篡改切换）
    const joined = [...contents].sort().join('');
    const content_hash = sha256_hex(new TextEncoder().encode(joined));
    const artifact_id = `${spec.kind}-${content_hash.slice(0, _ARTIFACT_ID_PREFIX)}`;
    const target_dir = _join_path(this._artifact_dir, artifact_id);
    this._fs.mkdir_parents(target_dir);
    for (const relative of spec.output_paths) {
      this._fs.copy_file(
        _join_path(workdir, relative),
        _join_path(target_dir, relative),
      );
    }
    return new BuildArtifact({
      artifact_id,
      kind: spec.kind,
      files,
      built_at: this._now(),
      meta: { spec: spec.to_dict() },
    });
  }

  /** 冒烟门禁：探针命令经沙箱执行，退出码/超时判定（fail-closed）。 */
  async smoke(artifact: BuildArtifact, probe: SmokeProbe): Promise<SmokeResult> {
    // 探针命令须在白名单（fail-closed）；白名单外 = 冒烟不通过
    if (!this._sandbox.allowlist.includes(probe.command)) {
      return new SmokeResult({ ok: false, output: '冒烟命令不在白名单（fail-closed）' });
    }
    // 探针工作目录 = 产物目录（probe 在产物上下文中运行——产物内的可执行
    // 文件/依赖文件可被探针直接引用），超时按探针声明注入
    const smoke_sandbox = _sandbox_with(
      this._sandbox,
      this.artifact_dir(artifact),
      probe.timeout,
    );
    const result = await smoke_sandbox.run(probe.command, [...probe.args]);
    if (result.timed_out) {
      return new SmokeResult({
        ok: false,
        output: result.stdout,
        timed_out: true,
      });
    }
    return new SmokeResult({
      ok: result.exit_code === probe.expect_exit,
      output: result.stdout,
      exit_code: result.exit_code,
    });
  }

  /** 构建 + 冒烟强制门禁的统一上线入口（build 与 smoke 不可拆分）。 */
  async build_and_verify(
    spec: BuildSpec,
    probe: SmokeProbe,
  ): Promise<BuildArtifact> {
    // build 与 smoke 分离时宿主漏 smoke 即 promote——本入口把冒烟变成
    // 不可跳过的环节：产物必须过冒烟门禁（启动/连通/回归）才算可上线；
    // 冒烟失败 = 抛 BuildError（产物目录保留供排查，不产出自称成功的
    // 记录，调用方留痕后按失败处理）
    const artifact = await this.build(spec);
    const result = await this.smoke(artifact, probe);
    if (!result.ok) {
      const detail = result.timed_out
        ? `冒烟超时（>${probe.timeout}s）`
        : `冒烟未通过（exit=${result.exit_code}，期望 ${probe.expect_exit}）`;
      throw new BuildError(`${detail}: ${result.output.slice(0, 300)}`);
    }
    return artifact;
  }

  /** 哈希校验（部署/回退前强制门禁）：产物目录内文件与声明一致。 */
  verify_hash(artifact: BuildArtifact, name: string, digest: string): boolean {
    const declared = artifact.files[name];
    if (declared === undefined || declared !== digest) return false;
    const source = _join_path(this.artifact_dir(artifact), name);
    if (!this._fs.is_file(source)) return false;
    return _sha256_file(source, this._fs) === digest;
  }

  /** 产物目录路径（部署/挂载读取）。 */
  artifact_dir(artifact: BuildArtifact): string {
    return _join_path(this._artifact_dir, artifact.artifact_id);
  }
}
