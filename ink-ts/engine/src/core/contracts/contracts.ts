/**
 * 结点契约与机制装配开关（声明式数据形态：类型化原子的输入/输出声明）。
 *
 * 结点契约把「某类型结点做什么」从代码提升为可序列化数据：输入/输出
 * schema（复用状态通道的 SchemaSpec 声明语言）声明结点消费与产出的状态
 * 通道字段；安全档与版本随契约落库——契约即数据，随图定义数据
 * （checkpoint/harness）持久化，旧版本契约快照服务审计复现与回退。
 *
 * 本模块只定义数据形态与窄接口，不含任何执行逻辑：
 *
 * - NodeContract：结点契约（schema 声明 + 安全档 + 版本）；
 * - PathAssemblyConfig：机制装配配置开关（默认全关）；
 * - PathAssemblyFlags：机制装配开关组（七块独立 feature flag）；
 * - QualityGate：产出质量判定窄协议（只定义接口，实现归使用方）。
 *
 * 契约可缺省：无契约结点不参与组装、仅可被手绘图引用（旧行为零破坏）。
 *
 * 收敛点（不改动 registry 文件，仅此处注明）：registry/registry_types.ts 的
 * NodeContract 占位接口（version/safety_tier + 可选 schema 的只读数据形状）落
 * 地后可由本模块 NodeContract 类收敛——注册面按契约登记时只读 version/
 * safety_tier，本类字段为只读且自带构造校验，可在 registry.ts 的类型标注处
 * 直接复用（register/contract_for 的 contract 参数）。图模块移植后节点类型
 * 契约判定即可改用本类判等，不必再依赖占位形状。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';
import { SchemaSpec } from '../schema/schemaValidator.js';

// 安全档三档（0 最严，与审批档 L0-L2 同阶）
export const SAFETY_TIER_MIN = 0;
export const SAFETY_TIER_MAX = 2;
// 契约版本下限（行为变更 = 升版，版本从 1 起）
export const CONTRACT_VERSION_MIN = 1;

// ── 机制装配开关的按名透传键（装配入口按名消费，缺省全关）──────────
// 宿主装配参数（rust 侧 BootOptions 透传的 JSON 键名，见壳侧
// path_assembly_data）按此键名接入：本模块只定义「按名读取」，
// 每个开关键对应一块机制（contract/edge_evidence/settle_hooks/
// pool_governance/assembler/multipath/fingerprint_cache），键名
// 保持不变——键名是装配协议的一部分。
export const BOOT_KEY_CONTRACT_ENABLED = 'path_assembly_contract_enabled';
export const BOOT_KEY_EDGE_EVIDENCE_ENABLED = 'path_assembly_edge_evidence_enabled';
export const BOOT_KEY_SETTLE_HOOKS_ENABLED = 'path_assembly_settle_hooks_enabled';
export const BOOT_KEY_POOL_GOVERNANCE_ENABLED = 'path_assembly_pool_governance_enabled';
export const BOOT_KEY_ASSEMBLER_ENABLED = 'path_assembly_assembler_enabled';
export const BOOT_KEY_MULTIPATH_ENABLED = 'path_assembly_multipath_enabled';
export const BOOT_KEY_FINGERPRINT_CACHE_ENABLED = 'path_assembly_fingerprint_cache_enabled';

// 透传键 → 开关字段（键名不改；装配入口按名读取后构造各块配置）
const BOOT_KEY_TO_FLAG: Record<string, string> = {
  [BOOT_KEY_CONTRACT_ENABLED]: 'contract_enabled',
  [BOOT_KEY_EDGE_EVIDENCE_ENABLED]: 'edge_evidence_enabled',
  [BOOT_KEY_SETTLE_HOOKS_ENABLED]: 'settle_hooks_enabled',
  [BOOT_KEY_POOL_GOVERNANCE_ENABLED]: 'pool_governance_enabled',
  [BOOT_KEY_ASSEMBLER_ENABLED]: 'assembler_enabled',
  [BOOT_KEY_MULTIPATH_ENABLED]: 'multipath_enabled',
  [BOOT_KEY_FINGERPRINT_CACHE_ENABLED]: 'fingerprint_cache_enabled',
};

// Python 语义的 repr：字符串带单引号，布尔/空值按字面呈现（错误消息对齐）。
function pyRepr(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

// Python int() 的有限镜像：整数数字（浮点按截断收敛）、整数字符串可转换，
// 布尔/空值/非数值一律拒绝（from_dict 的宽松读入口径）。
function toIntLike(value: unknown): { ok: boolean; value: number } {
  if (typeof value === 'boolean') return { ok: false, value: 0 };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, value: 0 };
    return { ok: true, value: Math.trunc(value) };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) return { ok: true, value: Number(trimmed) };
  }
  return { ok: false, value: 0 };
}

export interface NodeContractInit {
  input_schema?: SchemaSpec | null;
  output_schema?: SchemaSpec | null;
  safety_tier?: number;
  version?: number;
}

export class NodeContract {
  /** 本结点消费的状态通道字段声明（null = 不消费字段）。 */
  readonly input_schema: SchemaSpec | null;
  /** 本结点产出的状态通道字段声明（null = 不产出字段）。 */
  readonly output_schema: SchemaSpec | null;
  /** 安全档 0/1/2（默认 0 最严；与审批档同阶）。 */
  readonly safety_tier: number;
  /** 契约版本（结点行为变更 = 契约升版，旧版本随图定义快照保留）。 */
  readonly version: number;

  constructor(init: NodeContractInit = {}) {
    const input_schema = init.input_schema ?? null;
    const output_schema = init.output_schema ?? null;
    const safety_tier = init.safety_tier ?? 0;
    const version = init.version ?? 1;

    if (typeof safety_tier === 'boolean' || !Number.isInteger(safety_tier)) {
      throw new GraphDefinitionError(`契约安全档须为整数: ${pyRepr(safety_tier)}`);
    }
    if (safety_tier < SAFETY_TIER_MIN || safety_tier > SAFETY_TIER_MAX) {
      throw new GraphDefinitionError(
        `契约安全档越界: ${safety_tier}（仅 ${SAFETY_TIER_MIN}-${SAFETY_TIER_MAX} 三档）`,
      );
    }
    if (typeof version === 'boolean' || !Number.isInteger(version)) {
      throw new GraphDefinitionError(`契约版本须为整数: ${pyRepr(version)}`);
    }
    if (version < CONTRACT_VERSION_MIN) {
      throw new GraphDefinitionError(`契约版本须 ≥ ${CONTRACT_VERSION_MIN}: ${version}`);
    }
    for (const [label, schema] of [
      ['input_schema', input_schema],
      ['output_schema', output_schema],
    ] as const) {
      if (schema !== null && !(schema instanceof SchemaSpec)) {
        throw new GraphDefinitionError(`契约 ${label} 须为 SchemaSpec: ${typeName(schema)}`);
      }
    }

    this.input_schema = input_schema;
    this.output_schema = output_schema;
    this.safety_tier = safety_tier;
    this.version = version;
  }

  /** 序列化为数据形态（schema 声明内联，随图定义数据落库）。 */
  to_dict(): Record<string, unknown> {
    return {
      input_schema: this.input_schema !== null ? this.input_schema.to_dict() : null,
      output_schema: this.output_schema !== null ? this.output_schema.to_dict() : null,
      safety_tier: this.safety_tier,
      version: this.version,
    };
  }

  /** 反序列化（缺省键 = 默认值；旧数据无契约形态时由调用方传 null）。 */
  static from_dict(data: unknown): NodeContract {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`契约声明非法: 期望 dict，收到 ${typeName(data)}`);
    }
    for (const key of ['input_schema', 'output_schema']) {
      const raw = data[key];
      if (raw !== null && raw !== undefined && !isRecord(raw)) {
        throw new GraphDefinitionError(
          `契约 ${key} 声明非法: 期望 dict 或缺省，收到 ${typeName(raw)}`,
        );
      }
    }
    const safetyRaw = data['safety_tier'] ?? 0;
    const versionRaw = data['version'] ?? 1;
    if (typeof safetyRaw === 'boolean' || typeof versionRaw === 'boolean') {
      throw new GraphDefinitionError('契约安全档/版本不接受布尔值');
    }
    const tier = toIntLike(safetyRaw);
    const ver = toIntLike(versionRaw);
    if (!tier.ok || !ver.ok) {
      throw new GraphDefinitionError(
        `契约安全档/版本须为整数: ${pyRepr(safetyRaw)}/${pyRepr(versionRaw)}`,
      );
    }
    const inputData = data['input_schema'];
    const outputData = data['output_schema'];
    return new NodeContract({
      input_schema: inputData !== null && inputData !== undefined ? SchemaSpec.from_dict(inputData) : null,
      output_schema:
        outputData !== null && outputData !== undefined ? SchemaSpec.from_dict(outputData) : null,
      safety_tier: tier.value,
      version: ver.value,
    });
  }
}

export interface PathAssemblyConfigInit {
  enabled?: boolean;
}

export class PathAssemblyConfig {
  /** 机制入口开关（False = 机制不参与任何运行路径；默认全关）。 */
  readonly enabled: boolean;

  constructor(init: PathAssemblyConfigInit = {}) {
    this.enabled = init.enabled ?? false;
  }

  to_dict(): Record<string, unknown> {
    return { enabled: this.enabled };
  }

  static from_dict(data: unknown): PathAssemblyConfig {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`装配配置声明非法: 期望 dict，收到 ${typeName(data)}`);
    }
    return new PathAssemblyConfig({ enabled: Boolean(data['enabled'] ?? false) });
  }
}

export interface PathAssemblyFlagsInit {
  contract_enabled?: boolean;
  edge_evidence_enabled?: boolean;
  settle_hooks_enabled?: boolean;
  pool_governance_enabled?: boolean;
  assembler_enabled?: boolean;
  multipath_enabled?: boolean;
  fingerprint_cache_enabled?: boolean;
}

export class PathAssemblyFlags {
  /** 结点契约 + 链接校验器。 */
  readonly contract_enabled: boolean;
  /** 边证据存储（评分与统计）。 */
  readonly edge_evidence_enabled: boolean;
  /** 沉淀钩子（成败/成本归集、失败点提案）。 */
  readonly settle_hooks_enabled: boolean;
  /** 结点池治理（容量/淘汰/合并/提案预算）。 */
  readonly pool_governance_enabled: boolean;
  /** 路径组装器（schema 反推/草稿/证据评分）。 */
  readonly assembler_enabled: boolean;
  /** 多径执行 + 汇流裁决。 */
  readonly multipath_enabled: boolean;
  /** 指纹缓存。 */
  readonly fingerprint_cache_enabled: boolean;

  constructor(init: PathAssemblyFlagsInit = {}) {
    this.contract_enabled = init.contract_enabled ?? false;
    this.edge_evidence_enabled = init.edge_evidence_enabled ?? false;
    this.settle_hooks_enabled = init.settle_hooks_enabled ?? false;
    this.pool_governance_enabled = init.pool_governance_enabled ?? false;
    this.assembler_enabled = init.assembler_enabled ?? false;
    this.multipath_enabled = init.multipath_enabled ?? false;
    this.fingerprint_cache_enabled = init.fingerprint_cache_enabled ?? false;
  }

  to_dict(): Record<string, unknown> {
    return {
      contract_enabled: this.contract_enabled,
      edge_evidence_enabled: this.edge_evidence_enabled,
      settle_hooks_enabled: this.settle_hooks_enabled,
      pool_governance_enabled: this.pool_governance_enabled,
      assembler_enabled: this.assembler_enabled,
      multipath_enabled: this.multipath_enabled,
      fingerprint_cache_enabled: this.fingerprint_cache_enabled,
    };
  }

  /** 按 BOOT_KEY_* 长键形态序列化（与 from_boot 读取口径一致）。 */
  to_boot_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const [bootKey, flag] of Object.entries(BOOT_KEY_TO_FLAG)) {
      data[bootKey] = this[flag as keyof PathAssemblyFlags] as boolean;
    }
    return data;
  }

  /** 按名读取装配参数（未知键忽略；缺省键 = false = 默认全关）。 */
  static from_boot(data: unknown): PathAssemblyFlags {
    if (data === null || data === undefined) return new PathAssemblyFlags();
    const values: Record<string, boolean> = {};
    if (isRecord(data)) {
      for (const [bootKey, flag] of Object.entries(BOOT_KEY_TO_FLAG)) {
        values[flag] = Boolean(data[bootKey] ?? false);
      }
    }
    return new PathAssemblyFlags(values as PathAssemblyFlagsInit);
  }

  /** 组装器块开关形态（装配入口接线用；默认全关）。 */
  as_path_assembly_config(): PathAssemblyConfig {
    return new PathAssemblyConfig({ enabled: this.assembler_enabled });
  }
}

/**
 * 产出质量判定窄协议（组装请求注入；只定义接口，实现归使用方）。
 *
 * 按域提供产出质量判定（领域名 + 产出物 → 布尔结论）；布尔结论随
 * 沉淀钩子落库（settle 只记录布尔值，不做判定本身）。未注入闸门时
 * 使用方走 fail-closed 降级链。判定可同步或异步——调用点按引擎既有
 * 协议惯例检测 thenable。
 */
export interface QualityGate {
  judge(domain: string, artifact: unknown): boolean | Promise<boolean>;
}
