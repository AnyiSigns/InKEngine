/**
 * 工具可信度闸门数据面（tool_vetting.py 移植）：来源分类/判定枚举、
 * 清单与逐项检查/影子运行/总体结果数据类，以及文件系统 seam（os/
 * shutil/tempfile 动作的注入面——TS core 零 IO，真实实现由宿主注入）。
 *
 * StrEnum 镜像为「静态只读常量类」（对齐 graph_types.TerminateReason 的
 * 既有口径）：字段存值面字符串，is_valid 做白名单校验；比对即值比对
 * （Python 的 ``verdict is VettingVerdict.REVIEW`` 等价于值相等）。
 */
import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';

/** Python repr() 口径渲染（错误消息携带注入值形态；字符串带单引号）。 */
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

// ── 来源分类（StrEnum 值面；清单校验的可信度分类） ──────────────────────────

export type ToolSourceValue = 'market' | 'github' | 'ai_generated' | 'unknown';

/** 工具来源（清单校验的可信度分类）。 */
export class ToolSource {
  static readonly MARKET: ToolSourceValue = 'market';
  static readonly GITHUB: ToolSourceValue = 'github';
  static readonly AI_GENERATED: ToolSourceValue = 'ai_generated';
  static readonly UNKNOWN: ToolSourceValue = 'unknown';
  private static readonly _ALL: readonly ToolSourceValue[] = [
    ToolSource.MARKET,
    ToolSource.GITHUB,
    ToolSource.AI_GENERATED,
    ToolSource.UNKNOWN,
  ];
  /** 白名单校验（镜像 StrEnum 构造的 ValueError → 调用方按上下文包装）。 */
  static is_valid(value: string): boolean {
    return (ToolSource._ALL as readonly string[]).includes(value);
  }
  private constructor() {}
}

// ── 判定枚举（StrEnum 值面；清单+审查的总体判定） ───────────────────────────

export type VettingVerdictValue = 'verified' | 'review' | 'rejected';

/** 清单+审查的总体判定（approved/review/rejected）。 */
export class VettingVerdict {
  static readonly VERIFIED: VettingVerdictValue = 'verified';
  static readonly REVIEW: VettingVerdictValue = 'review';
  static readonly REJECTED: VettingVerdictValue = 'rejected';
  private static readonly _ALL: readonly VettingVerdictValue[] = [
    VettingVerdict.VERIFIED,
    VettingVerdict.REVIEW,
    VettingVerdict.REJECTED,
  ];
  static is_valid(value: string): boolean {
    return (VettingVerdict._ALL as readonly string[]).includes(value);
  }
  private constructor() {}
}

// ── 数据类（Python @dataclass(frozen=True, slots=True) 镜像：只读 + freeze） ──

/** 工具清单（来源/签名/哈希/权限声明/SBOM，挂载前的身份声明）。 */
export class ToolManifest {
  readonly name: string;
  readonly source: ToolSourceValue;
  readonly signature: string | null;
  readonly hashes: Readonly<Record<string, string>>;
  readonly permissions: readonly string[];
  readonly dependencies: readonly string[];
  readonly meta: Readonly<Record<string, unknown>>;

  constructor(init: {
    name: string;
    source?: ToolSourceValue;
    signature?: string | null;
    hashes?: Record<string, string>;
    permissions?: readonly string[];
    dependencies?: readonly string[];
    meta?: Record<string, unknown>;
  }) {
    this.name = init.name;
    this.source = init.source ?? ToolSource.UNKNOWN;
    this.signature = init.signature ?? null;
    this.hashes = init.hashes ? { ...init.hashes } : {};
    this.permissions = init.permissions ? [...init.permissions] : [];
    this.dependencies = init.dependencies ? [...init.dependencies] : [];
    this.meta = init.meta ? { ...init.meta } : {};
    Object.freeze(this);
  }

  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = { name: this.name, source: this.source };
    if (this.signature) data['signature'] = this.signature;
    if (Object.keys(this.hashes).length > 0) data['hashes'] = { ...this.hashes };
    if (this.permissions.length > 0) data['permissions'] = [...this.permissions];
    if (this.dependencies.length > 0) data['dependencies'] = [...this.dependencies];
    if (Object.keys(this.meta).length > 0) data['meta'] = { ...this.meta };
    return data;
  }

  static from_dict(data: unknown): ToolManifest {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`工具清单非法: 期望 dict，收到 ${typeName(data)}`);
    }
    const name = data['name'];
    if (typeof name !== 'string' || name === '') {
      throw new GraphDefinitionError('工具清单缺 name（字符串）');
    }
    const sourceRaw = data['source'] === undefined ? ToolSource.UNKNOWN : data['source'];
    if (typeof sourceRaw !== 'string' || !ToolSource.is_valid(sourceRaw)) {
      throw new GraphDefinitionError(`工具 ${name} 的来源分类非法: ${pyRepr(sourceRaw)}`);
    }
    const signature = data['signature'];
    if (signature !== null && signature !== undefined && typeof signature !== 'string') {
      throw new GraphDefinitionError(`工具 ${name} 的 signature 须为字符串`);
    }
    const hashesRaw = data['hashes'] === undefined ? {} : data['hashes'];
    if (!isRecord(hashesRaw)) {
      throw new GraphDefinitionError(`工具 ${name} 的 hashes 须为文件 → 哈希 dict`);
    }
    for (const [path, digest] of Object.entries(hashesRaw)) {
      if (typeof path !== 'string' || typeof digest !== 'string') {
        throw new GraphDefinitionError(`工具 ${name} 的哈希声明非法: ${pyRepr(path)} → ${pyRepr(digest)}`);
      }
    }
    const itemsOf = (label: string, raw: unknown): string[] => {
      const items = raw === undefined ? [] : raw;
      if (
        !Array.isArray(items) ||
        !items.every((item) => typeof item === 'string' && item !== '')
      ) {
        throw new GraphDefinitionError(`工具 ${name} 的 ${label} 须为非空字符串清单`);
      }
      return items as string[];
    };
    const permissions = itemsOf('permissions', data['permissions']);
    const dependencies = itemsOf('dependencies', data['dependencies']);
    const metaRaw = data['meta'] === undefined ? {} : data['meta'];
    if (!isRecord(metaRaw)) {
      throw new GraphDefinitionError(`工具 ${name} 的 meta 须为 dict（${typeName(metaRaw)}）`);
    }
    return new ToolManifest({
      name,
      source: sourceRaw as ToolSourceValue,
      signature: signature === undefined ? null : signature,
      hashes: { ...(hashesRaw as Record<string, string>) },
      permissions,
      dependencies,
      meta: { ...metaRaw },
    });
  }
}

/** 单项闸门结果（清单/静态审查/观察模式，逐项可审计）。 */
export class VettingCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;

  constructor(init: { name: string; ok: boolean; detail?: string }) {
    this.name = init.name;
    this.ok = init.ok;
    this.detail = init.detail ?? '';
    Object.freeze(this);
  }
}

/** 影子运行记录的写操作（写虚拟化：只记录不落真实工作区）。 */
export class ShadowWrite {
  readonly path: string;
  readonly operation: string;
  readonly size: number;

  constructor(init: { path: string; operation: string; size?: number }) {
    this.path = init.path;
    this.operation = init.operation;
    this.size = init.size ?? 0;
    Object.freeze(this);
  }
}

/** 观察模式结果（行为证据：写操作清单 + 输出，恒标记 untrusted）。 */
export class ShadowRunResult {
  readonly ok: boolean;
  readonly writes: readonly ShadowWrite[];
  readonly output: string;
  readonly error: string | null;
  readonly untrusted: boolean;

  constructor(init: {
    ok: boolean;
    writes?: readonly ShadowWrite[];
    output?: string;
    error?: string | null;
    untrusted?: boolean;
  }) {
    this.ok = init.ok;
    this.writes = init.writes ? [...init.writes] : [];
    this.output = init.output ?? '';
    this.error = init.error ?? null;
    this.untrusted = init.untrusted ?? true;
    Object.freeze(this);
  }
}

/** vetting 总体结果（判定 + 逐项检查 + 观察证据）。 */
export class VettingResult {
  readonly ok: boolean;
  readonly verdict: VettingVerdictValue;
  readonly checks: readonly VettingCheck[];
  readonly shadow: ShadowRunResult | null;
  readonly reason: string;

  constructor(init: {
    ok: boolean;
    verdict: VettingVerdictValue;
    checks?: readonly VettingCheck[];
    shadow?: ShadowRunResult | null;
    reason?: string;
  }) {
    this.ok = init.ok;
    this.verdict = init.verdict;
    this.checks = init.checks ? [...init.checks] : [];
    this.shadow = init.shadow ?? null;
    this.reason = init.reason ?? '';
    Object.freeze(this);
  }

  to_dict(): Record<string, unknown> {
    return {
      ok: this.ok,
      verdict: this.verdict,
      checks: this.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
      shadow:
        this.shadow === null
          ? null
          : {
              ok: this.shadow.ok,
              writes: this.shadow.writes.map((w) => ({
                path: w.path,
                operation: w.operation,
                size: w.size,
              })),
              untrusted: this.shadow.untrusted,
            },
      reason: this.reason,
    };
  }
}

// ── 钩子与 seam 形态 ───────────────────────────────────────────────────────

/** 静态审查钩子签名：代码文件清单 → 违规描述清单（空 = 通过）。 */
export type StaticHook = (code_paths: readonly string[]) => string[];

/** 影子运行观察回调：executor(args, shadow_workdir) → 任意结果/可等待结果。 */
export type ShadowExecutor = (
  args: Record<string, unknown>,
  shadow_workdir: string,
) => unknown | Promise<unknown>;

/**
 * 文件系统 seam：os/shutil/tempfile 动作的注入面（核心零 IO）。真实实现由
 * 宿主注入（node:fs 后端）；本模块只按这些原语表达拷贝/快照/diff 机制。
 * 路径一律以字符串表达；mkdtemp/rmtree/copy2/symlink_to 对齐对应 stdlib 语义。
 */
export interface FsSeam {
  /** tempfile.mkdtemp(prefix)：建唯一临时目录，返回其路径。 */
  mkdtemp(prefix: string): string;
  /** shutil.rmtree(path, ignore_errors)：整树删除；ignore_errors=true 吞错。 */
  rmtree(path: string, ignore_errors: boolean): void;
  /** path.is_dir()。 */
  is_dir(path: string): boolean;
  /** path.is_file()。 */
  is_file(path: string): boolean;
  /** entry.is_symlink()。 */
  is_symlink(path: string): boolean;
  /** os.readlink(path)：读符号链接指向。 */
  readlink(path: string): string;
  /** shutil.copy2(source, target)：拷贝文件并保留元数据。 */
  copy2(source: string, target: string): void;
  /** target 处建符号链接指向 link_target（对齐 symlink_to）。 */
  symlink_to(link_target: string, link_path: string): void;
  /** Path.mkdir(parents=True, exist_ok=True)：含父目录的目录创建。 */
  mkdir(path: string): void;
  /** path.iterdir()：直接子项完整路径清单。 */
  iterdir(path: string): string[];
  /** path.rglob('*')：全部递归后代完整路径清单。 */
  rglob(path: string): string[];
  /** stat().st_size：文件字节数；失败（OSError）返回 null（快照跳过）。 */
  stat_size(path: string): number | null;
}
