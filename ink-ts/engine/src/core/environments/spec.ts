/**
 * 环境声明（EnvironmentSpec，纯数据）+ 运行时类别 + 实例句柄。
 *
 * 环境是数据：声明随补丁链版本化/回退（运行时清单/安装命令白名单/版本约束），
 * 提供器是机制。EnvironmentSpec 为 frozen dataclass 镜像：只读字段 + freeze；
 * dataclass 值相等语义由 equals 表达（提供器按声明变更判定销毁重建的依据）。
 *
 * RuntimeKind 为 StrEnum 镜像（静态只读常量类，字段即取值）；is_valid 做白名单
 * 校验（from_dict 镜像 StrEnum 构造的 ValueError → 调用方按上下文包装）。
 */
import { GraphDefinitionError } from '../errors.js';
import { deepEqual, isRecord, typeName } from '../json.js';

import { copyInstallCmd, validateInstallCmd, type InstallCmd } from './install_cmd.js';
import { ENV_STATUS_READY } from './constants.js';
import { pyRepr } from './_repr.js';

/** 运行时类别取值（local/web_bridge/container）。 */
export type RuntimeKindValue = 'local' | 'web_bridge' | 'container';

/** 运行时类别（声明式枚举：本地/浏览器/容器）。 */
export class RuntimeKind {
  static readonly LOCAL: RuntimeKindValue = 'local';
  static readonly WEB_BRIDGE: RuntimeKindValue = 'web_bridge';
  static readonly CONTAINER: RuntimeKindValue = 'container';
  private static readonly _ALL: readonly string[] = [
    RuntimeKind.LOCAL,
    RuntimeKind.WEB_BRIDGE,
    RuntimeKind.CONTAINER,
  ];
  /** 白名单校验（镜像 StrEnum 成员集；非法运行时由调用方包装为 GraphDefinitionError）。 */
  static is_valid(value: string): boolean {
    return RuntimeKind._ALL.includes(value);
  }
  private constructor() {}
}

/**
 * 环境声明（纯数据：运行时清单 = 数据，随补丁链版本化）。
 *
 * Attributes:
 *   name: 环境名（集内唯一）。
 *   runtime: 运行时类别（local/web_bridge/container）。
 *   tools: 需要的工具命令清单（本地运行时可用性判定/白名单安装）。
 *   install_cmds: 安装命令白名单（缺失工具时的懒装命令；命令本身须在白名单内
 *     才能执行——安装也走沙箱）。条目两种形态：字符串（shlex 分词）或结构化
 *     {cmd, args}（命令与参数分离，推荐形态）。
 *   version: 运行时版本约束（null = 不限定）。
 *   meta: 扩展元数据（来源/说明等，宿主语义）。
 */
export class EnvironmentSpec {
  readonly name: string;
  readonly runtime: RuntimeKindValue;
  readonly tools: readonly string[];
  readonly install_cmds: readonly InstallCmd[];
  readonly version: string | null;
  readonly meta: Readonly<Record<string, unknown>>;

  constructor(init: {
    name: string;
    runtime?: RuntimeKindValue;
    tools?: readonly string[];
    install_cmds?: readonly InstallCmd[];
    version?: string | null;
    meta?: Readonly<Record<string, unknown>>;
  }) {
    this.name = init.name;
    this.runtime = init.runtime ?? RuntimeKind.LOCAL;
    this.tools = init.tools ? [...init.tools] : [];
    this.install_cmds = init.install_cmds ? init.install_cmds.map(copyInstallCmd) : [];
    this.version = init.version ?? null;
    this.meta = init.meta ? { ...init.meta } : {};
    // __post_init__ 镜像：声明期校验，非法声明在构造即拒绝
    if (!this.name) {
      throw new GraphDefinitionError('环境声明缺 name');
    }
    if (!RuntimeKind.is_valid(this.runtime)) {
      throw new GraphDefinitionError(
        `环境 ${this.name} 的 runtime 非法: ${pyRepr(this.runtime)}`,
      );
    }
    for (const tool of this.tools) {
      if (typeof tool !== 'string' || tool === '') {
        throw new GraphDefinitionError(`环境 ${this.name} 的 tools 须为非空命令字符串清单`);
      }
    }
    for (const cmd of this.install_cmds) validateInstallCmd(cmd, this.name);
    Object.freeze(this);
  }

  /** dataclass 值相等镜像（提供器判断「声明已变更」的同一口径）。 */
  equals(other: EnvironmentSpec): boolean {
    return (
      this.name === other.name &&
      this.runtime === other.runtime &&
      deepEqual(this.tools, other.tools) &&
      deepEqual(this.install_cmds, other.install_cmds) &&
      this.version === other.version &&
      deepEqual(this.meta, other.meta)
    );
  }

  /** 序列化（空 tools/install_cmds/version/meta 省略，镜像 to_dict 布尔口径）。 */
  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = { name: this.name, runtime: this.runtime };
    if (this.tools.length > 0) data['tools'] = [...this.tools];
    if (this.install_cmds.length > 0) {
      data['install_cmds'] = this.install_cmds.map((cmd) =>
        typeof cmd === 'string' ? cmd : copyInstallCmd(cmd),
      );
    }
    if (this.version) data['version'] = this.version;
    if (Object.keys(this.meta).length > 0) data['meta'] = { ...this.meta };
    return data;
  }

  /** 从声明 dict 还原（镜像 from_dict：get(k) or 缺省 的布尔口径全对齐）。 */
  static from_dict(data: unknown): EnvironmentSpec {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`环境声明非法: 期望 dict，收到 ${typeName(data)}`);
    }
    const name = data['name'];
    if (typeof name !== 'string' || name === '') {
      throw new GraphDefinitionError('环境声明缺 name（字符串）');
    }
    const rawRuntime = data['runtime'] === undefined ? RuntimeKind.LOCAL : data['runtime'];
    if (typeof rawRuntime !== 'string' || !RuntimeKind.is_valid(rawRuntime)) {
      throw new GraphDefinitionError(`环境 ${name} 的 runtime 非法: ${pyRepr(rawRuntime)}`);
    }
    const rawTools = data['tools'];
    const tools = rawTools ? rawTools : [];
    if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === 'string' && tool !== '')) {
      throw new GraphDefinitionError(`环境 ${name} 的 tools 须为非空命令字符串清单`);
    }
    const rawCmds = data['install_cmds'];
    const cmds = rawCmds ? rawCmds : [];
    if (!Array.isArray(cmds)) {
      throw new GraphDefinitionError(`环境 ${name} 的 install_cmds 须为清单`);
    }
    for (const cmd of cmds) validateInstallCmd(cmd, name);
    const version = data['version'] ?? null;
    if (version !== null && typeof version !== 'string') {
      throw new GraphDefinitionError(`环境 ${name} 的 version 须为字符串`);
    }
    const rawMeta = data['meta'];
    if (rawMeta !== null && rawMeta !== undefined && !isRecord(rawMeta)) {
      throw new GraphDefinitionError(`环境 ${name} 的 meta 须为 dict`);
    }
    return new EnvironmentSpec({
      name,
      runtime: rawRuntime as RuntimeKindValue,
      tools: tools as string[],
      install_cmds: cmds as InstallCmd[],
      version,
      meta: rawMeta ? { ...rawMeta } : undefined,
    });
  }
}

/** 环境实例句柄（提供器 ensure 的产物，宿主持有用于运行/销毁；状态可迁移）。 */
export class EnvironmentHandle {
  env_id: string;
  spec: EnvironmentSpec;
  status: string;
  workdir: string | null;
  error: string | null;

  constructor(init: {
    env_id: string;
    spec: EnvironmentSpec;
    status?: string;
    workdir?: string | null;
    error?: string | null;
  }) {
    this.env_id = init.env_id;
    this.spec = init.spec;
    this.status = init.status ?? ENV_STATUS_READY;
    this.workdir = init.workdir ?? null;
    this.error = init.error ?? null;
  }
}
