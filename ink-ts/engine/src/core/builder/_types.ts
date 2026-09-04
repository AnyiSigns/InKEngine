/**
 * 构建管线数据面（builder.py 移植）：产物类别/构建声明/构建产物/冒烟
 * 探针与结果的声明式形态，以及文件系统 seam（core 零 IO，fs 动作经宿主
 * 注入——见 Builder 装配）。
 *
 * 语义镜像 Python 的 frozen dataclass：只读字段 + 构造期校验（BuildSpec
 * 的 __post_init__：command/timeout/output_paths）+ to_dict/from_dict
 * 序列化往返。BuildKind 镜像 StrEnum 为「静态只读常量类」（对齐
 * graph_types.TerminateReason 既有口径）：字段存值面字符串，is_valid 做
 * 白名单校验；kind 字段即值字符串，无枚举实例概念。
 */
import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';

/** Python repr() 口径渲染（错误文案携带注入值形态；字符串带单引号）。 */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const record = value as { [key: string]: unknown };
    const parts = Object.keys(record).map((key) => `${pyRepr(key)}: ${pyRepr(record[key])}`);
    return `{${parts.join(', ')}}`;
  }
  return String(value);
}

// ── 产物类别（StrEnum 值面；声明式枚举） ───────────────────────────────────

export type BuildKindValue = 'js_bundle' | 'python_package' | 'service';

/** 构建产物类别（声明式枚举：前端 bundle/后端包/任意服务）。 */
export class BuildKind {
  static readonly JS_BUNDLE: BuildKindValue = 'js_bundle';
  static readonly PYTHON_PACKAGE: BuildKindValue = 'python_package';
  static readonly SERVICE: BuildKindValue = 'service';
  private static readonly _ALL: readonly string[] = [
    BuildKind.JS_BUNDLE,
    BuildKind.PYTHON_PACKAGE,
    BuildKind.SERVICE,
  ];
  /** 白名单校验（镜像 StrEnum 构造的 ValueError → 调用方按上下文包装）。 */
  static is_valid(value: string): boolean {
    return BuildKind._ALL.includes(value);
  }
  private constructor() {}
}

// ── 构建声明 ────────────────────────────────────────────────────────────────

/** 构建声明的默认超时（秒；与 Python 默认值一致）。 */
export const DEFAULT_BUILD_TIMEOUT = 120.0;

/**
 * 构建声明（白名单命令 + 产物路径清单）。
 *
 * kind: 构建产物类别；command: 构建命令（须在构建沙箱白名单内）；
 * args: 命令参数；workdir: 构建工作目录（产物读取的相对基准）；env:
 * 环境变量（透传沙箱 env 白名单）；timeout: 超时秒数（超时 kill，产物
 * 视为失败）；output_paths: 产物相对路径清单（拷贝进产物目录并哈希）；
 * meta: 扩展元数据（来源/版本说明等）。
 */
export class BuildSpec {
  readonly kind: BuildKindValue;
  readonly command: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly env: Readonly<Record<string, string>> | null;
  readonly timeout: number;
  readonly output_paths: readonly string[];
  readonly meta: Readonly<Record<string, unknown>>;

  constructor(init: {
    kind: BuildKindValue;
    command: string;
    args?: readonly string[];
    workdir?: string;
    env?: Readonly<Record<string, string>> | null;
    timeout?: number;
    output_paths?: readonly string[];
    meta?: Record<string, unknown>;
  }) {
    const args = init.args ?? [];
    const workdir = init.workdir ?? '.';
    const env = init.env ?? null;
    const timeout = init.timeout ?? DEFAULT_BUILD_TIMEOUT;
    const output_paths = init.output_paths ?? [];
    const meta = init.meta ?? {};
    if (!init.command) {
      throw new GraphDefinitionError('构建声明缺 command（白名单命令）');
    }
    if (timeout <= 0) {
      throw new GraphDefinitionError(`构建超时须为正数: ${timeout}`);
    }
    for (const path of output_paths) {
      if (typeof path !== 'string' || path === '') {
        throw new GraphDefinitionError('构建声明的 output_paths 须为非空相对路径清单');
      }
    }
    this.kind = init.kind;
    this.command = init.command;
    this.args = [...args];
    this.workdir = workdir;
    this.env = env === null ? null : { ...env };
    this.timeout = timeout;
    this.output_paths = [...output_paths];
    this.meta = { ...meta };
    Object.freeze(this);
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      kind: this.kind,
      command: this.command,
      workdir: this.workdir,
      timeout: this.timeout,
    };
    if (this.args.length > 0) data['args'] = [...this.args];
    if (this.env !== null && Object.keys(this.env).length > 0) {
      data['env'] = { ...this.env };
    }
    if (this.output_paths.length > 0) data['output_paths'] = [...this.output_paths];
    if (Object.keys(this.meta).length > 0) data['meta'] = { ...this.meta };
    return data;
  }

  static from_dict(data: unknown): BuildSpec {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `构建声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const kindRaw = data['kind'];
    if (typeof kindRaw !== 'string' || !BuildKind.is_valid(kindRaw)) {
      throw new GraphDefinitionError(`构建产物类别非法: ${pyRepr(kindRaw)}`);
    }
    const command = data['command'];
    if (typeof command !== 'string' || command === '') {
      throw new GraphDefinitionError('构建声明缺 command（字符串）');
    }
    const args = data['args'] ?? [];
    const output_paths = data['output_paths'] ?? [];
    for (const [label, items] of [
      ['args', args],
      ['output_paths', output_paths],
    ] as const) {
      if (
        !Array.isArray(items) ||
        !items.every((item) => typeof item === 'string' && item !== '')
      ) {
        throw new GraphDefinitionError(`构建声明的 ${label} 须为非空字符串清单`);
      }
    }
    const envRaw = data['env'];
    if (envRaw !== null && envRaw !== undefined && !isRecord(envRaw)) {
      throw new GraphDefinitionError('构建声明的 env 须为 dict');
    }
    const timeoutRaw = data['timeout'];
    const timeout =
      timeoutRaw === null ||
      timeoutRaw === undefined ||
      timeoutRaw === '' ||
      timeoutRaw === false
        ? DEFAULT_BUILD_TIMEOUT
        : Number(timeoutRaw);
    if (!Number.isFinite(timeout)) {
      throw new GraphDefinitionError(`构建声明的 timeout 非法: ${pyRepr(timeoutRaw)}`);
    }
    const metaRaw = data['meta'];
    if (metaRaw !== null && metaRaw !== undefined && !isRecord(metaRaw)) {
      throw new GraphDefinitionError('构建声明的 meta 须为 dict');
    }
    const workdirRaw = data['workdir'];
    const workdir =
      workdirRaw === null ||
      workdirRaw === undefined ||
      workdirRaw === ''
        ? '.'
        : String(workdirRaw);
    return new BuildSpec({
      kind: kindRaw as BuildKindValue,
      command,
      args: args as string[],
      workdir,
      env: envRaw === null || envRaw === undefined
        ? null
        : { ...(envRaw as Record<string, string>) },
      timeout,
      output_paths: output_paths as string[],
      meta: isRecord(metaRaw) ? { ...metaRaw } : {},
    });
  }
}

// ── 构建产物 ────────────────────────────────────────────────────────────────

/**
 * 构建产物（内容寻址：产物 id = 文件内容哈希派生的标识）。
 *
 * artifact_id: 产物 id（kind + 内容哈希前缀，防篡改切换）；kind: 产物
 * 类别；files: 文件 → sha256 hex 映射（部署/回退前的哈希门禁依据）；
 * built_at: 构建完成时间（epoch 秒）；meta: 构建源信息（spec 摘要等）。
 */
export class BuildArtifact {
  readonly artifact_id: string;
  readonly kind: string;
  readonly files: Readonly<Record<string, string>>;
  readonly built_at: number;
  readonly meta: Readonly<Record<string, unknown>>;

  constructor(init: {
    artifact_id: string;
    kind: string;
    files?: Record<string, string>;
    built_at?: number;
    meta?: Record<string, unknown>;
  }) {
    this.artifact_id = init.artifact_id;
    this.kind = init.kind;
    this.files = init.files ? { ...init.files } : {};
    this.built_at = init.built_at ?? 0.0;
    this.meta = init.meta ? { ...init.meta } : {};
    Object.freeze(this);
  }

  to_dict(): Record<string, unknown> {
    return {
      artifact_id: this.artifact_id,
      kind: this.kind,
      files: { ...this.files },
      built_at: this.built_at,
      meta: { ...this.meta },
    };
  }

  static from_dict(data: unknown): BuildArtifact {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `构建产物声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const artifact_id = data['artifact_id'];
    const kind = data['kind'];
    const files = data['files'];
    if (typeof artifact_id !== 'string' || artifact_id === '') {
      throw new GraphDefinitionError('构建产物缺 artifact_id（字符串）');
    }
    if (typeof kind !== 'string' || kind === '') {
      throw new GraphDefinitionError('构建产物缺 kind（字符串）');
    }
    if (!isRecord(files)) {
      throw new GraphDefinitionError('构建产物的 files 须为文件 → 哈希 dict');
    }
    const built_atRaw = data['built_at'];
    const built_at =
      built_atRaw === null ||
      built_atRaw === undefined ||
      built_atRaw === ''
        ? 0.0
        : Number(built_atRaw);
    const metaRaw = data['meta'];
    return new BuildArtifact({
      artifact_id,
      kind,
      files: files as Record<string, string>,
      built_at: Number.isFinite(built_at) ? built_at : 0.0,
      meta: isRecord(metaRaw) ? { ...metaRaw } : {},
    });
  }
}

// ── 冒烟探针与结果 ──────────────────────────────────────────────────────────

/**
 * 冒烟探针（构建产物 promote 前的启动/回归验证声明）。
 *
 * command: 探针命令（须在构建沙箱白名单内）；args: 命令参数；timeout:
 * 超时秒数（超时 = 冒烟失败）；expect_exit: 期望退出码（默认 0 = 成功）。
 */
export class SmokeProbe {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout: number;
  readonly expect_exit: number;

  constructor(init: {
    command: string;
    args?: readonly string[];
    timeout?: number;
    expect_exit?: number;
  }) {
    this.command = init.command;
    this.args = init.args ? [...init.args] : [];
    this.timeout = init.timeout ?? 30.0;
    this.expect_exit = init.expect_exit ?? 0;
    Object.freeze(this);
  }
}

/** 冒烟结果（门禁判定依据）。 */
export class SmokeResult {
  readonly ok: boolean;
  readonly output: string;
  readonly timed_out: boolean;
  readonly exit_code: number;

  constructor(init: {
    ok: boolean;
    output?: string;
    timed_out?: boolean;
    exit_code?: number;
  }) {
    this.ok = init.ok;
    this.output = init.output ?? '';
    this.timed_out = init.timed_out ?? false;
    this.exit_code = init.exit_code ?? 0;
    Object.freeze(this);
  }
}

// ── 文件系统 seam（core 零 IO；宿主注入 node:fs 实现） ────────────────────

/**
 * 构建文件执行体 seam：Builder 的全部文件动作（目录判定/内容读取/产物
 * 落盘拷贝）经此注入。真实实现由宿主提供（node:fs 后端，路径语义即宿主
 * 平台语义）；本模块只按这些原语表达哈希/拷贝/落盘编排。未注入时触碰
 * 文件面抛错（fail-closed，不静默）。
 */
export interface BuildFs {
  /** Path.resolve() 镜像：绝对化归一（相对路径以宿主 CWD 为基准）。 */
  resolve(path: string): string;
  /** path.is_dir()。 */
  is_dir(path: string): boolean;
  /** path.is_file()。 */
  is_file(path: string): boolean;
  /** 文件内容整读（_sha256_file 的字节来源；分块流式属宿主实现细节）。 */
  read_bytes(path: string): Uint8Array;
  /** Path.mkdir(parents=True, exist_ok=True)：含父目录的目录创建。 */
  mkdir_parents(path: string): void;
  /** shutil.copy2(source, target)：拷贝文件（产物目录落盘）。 */
  copy_file(source: string, target: string): void;
}
