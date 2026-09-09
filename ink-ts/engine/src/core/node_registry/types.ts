/**
 * 结点类型注册记录（声明式注册表数据：node_registry:<set> 集合的登记行）。
 *
 * 决策 4：结点类型注册 = 数据化注册表——类型声明（契约/缺省配置/执行体绑定名/
 * 来源/状态）持久登记，重启恢复，治理动作可经受控通道回写登记。本文件只承载
 * 登记行数据形态（序列化/反序列化），不带执行语义。
 *
 * 状态语义：active = 参与运行时注册与契约池；disabled = 治理 disable 淘汰
 * （执行体不注册、不入池，登记行保留可审计）；archived = 归档（同上，供归档
 * 追溯）。执行体绑定（executor）为绑定名，不存闭包——引擎内置类型形如
 * `engine:<type>`，宿主/agent 注入类型由装配面提供绑定解析。
 */

import { NodeContract } from '../contracts/contracts.js';
import { isRecord } from '../json.js';
import { GraphDefinitionError } from '../errors.js';

/** 登记状态（active 参与运行时注册与契约池；disabled/archived 过滤不注册）。 */
export type NodeRegistrationStatus = 'active' | 'disabled' | 'archived';

/** 登记来源（seed=引擎内置池种子 / host=宿主 / agent=智能体 / governance=池治理）。 */
export type NodeRegistrationProvenance = 'seed' | 'host' | 'agent' | 'governance';

/** 治理建议字段（replace/merge 目标留在数据，由人/agent 走提案路径确认）。 */
export interface NodeRegistrationSuggestion {
  kind: 'replace' | 'merge';
  merge_into?: string;
  reason?: string;
  ts?: number;
}

/** 结点 flags（仅 true 语义有效：terminal=终态候选 / loop=可回环）。 */
export interface NodeRegistrationFlags {
  terminal?: boolean;
  loop?: boolean;
}

/** 登记行构造输入（宽松键，缺省取默认值）。 */
export interface NodeRegistrationInit {
  type_name: string;
  contract?: NodeContract | null;
  config_defaults?: Record<string, unknown>;
  /** 结点类别（§2.1 六类；缺省 = 未知类别，仍可注册/组装）。 */
  kind?: string | null;
  /** 展示标签（缺省 = 类型名）。 */
  label?: string | null;
  /** 描述（注册目录/池读面展示）。 */
  description?: string | null;
  /** 结点 flags（terminal=终态候选 / loop=可回环；空 flags = 无）。 */
  flags?: NodeRegistrationFlags | null;
  /** 执行体绑定名（引擎内置 `engine:<type>`；宿主/agent 类型由装配面绑定）。 */
  executor?: string;
  provenance?: NodeRegistrationProvenance;
  status?: NodeRegistrationStatus;
  archived_reason?: string | null;
  suggestion?: NodeRegistrationSuggestion | null;
  registered_at?: number;
  updated_at?: number;
}

/** 归一 flags：只保留 true 值键；空 flags 归一 null（flags 无语义信息不落序列化）。 */
function _clean_registration_flags(flags: NodeRegistrationFlags | null | undefined): NodeRegistrationFlags | null {
  if (flags === null || flags === undefined) return null;
  const out: NodeRegistrationFlags = {};
  if (flags.terminal === true) out.terminal = true;
  if (flags.loop === true) out.loop = true;
  return out.terminal === true || out.loop === true ? out : null;
}

/** 声明式结点类型注册行（数据形态；受控写通道见 NodeRegistryStore）。 */
export class NodeRegistration {
  readonly type_name: string;
  readonly contract: NodeContract | null;
  readonly config_defaults: Record<string, unknown>;
  readonly kind: string | null;
  readonly label: string | null;
  readonly description: string | null;
  readonly flags: NodeRegistrationFlags | null;
  readonly executor: string;
  readonly provenance: NodeRegistrationProvenance;
  readonly status: NodeRegistrationStatus;
  readonly archived_reason: string | null;
  readonly suggestion: NodeRegistrationSuggestion | null;
  readonly registered_at: number;
  readonly updated_at: number;

  constructor(init: NodeRegistrationInit) {
    this.type_name = init.type_name;
    this.contract = init.contract ?? null;
    this.config_defaults = { ...(init.config_defaults ?? {}) };
    this.kind = init.kind ?? null;
    this.label = init.label ?? null;
    this.description = init.description ?? null;
    this.flags = _clean_registration_flags(init.flags);
    this.executor = init.executor ?? `engine:${init.type_name}`;
    this.provenance = init.provenance ?? 'seed';
    this.status = init.status ?? 'active';
    this.archived_reason = init.archived_reason ?? null;
    this.suggestion = init.suggestion ?? null;
    this.registered_at = init.registered_at ?? 0;
    this.updated_at = init.updated_at ?? this.registered_at;
  }

  /** 是否参与运行时注册与契约池（active 才注册）。 */
  is_active(): boolean {
    return this.status === 'active';
  }

  /** 序列化为登记行（schema 声明内联；随记录落库/恢复）。 */
  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      type_name: this.type_name,
      contract: this.contract !== null ? this.contract.to_dict() : null,
      config_defaults: { ...this.config_defaults },
      executor: this.executor,
      provenance: this.provenance,
      status: this.status,
      registered_at: this.registered_at,
      updated_at: this.updated_at,
    };
    if (this.kind !== null) data['kind'] = this.kind;
    if (this.label !== null) data['label'] = this.label;
    if (this.description !== null) data['description'] = this.description;
    if (this.flags !== null) data['flags'] = { ...this.flags };
    if (this.archived_reason !== null) data['archived_reason'] = this.archived_reason;
    if (this.suggestion !== null) data['suggestion'] = { ...this.suggestion };
    return data;
  }

  /** 反序列化（缺省键 = 默认值；畸形行抛错由调用方跳过留痕）。 */
  static from_dict(data: unknown): NodeRegistration {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `结点类型登记行非法: 期望 dict，收到 ${typeof data}`,
      );
    }
    const type_name = data['type_name'];
    if (!type_name || typeof type_name !== 'string') {
      throw new GraphDefinitionError('结点类型登记行缺 type_name（字符串）');
    }
    let contract: NodeContract | null = null;
    const rawContract = data['contract'];
    if (rawContract !== null && rawContract !== undefined) {
      contract = NodeContract.from_dict(rawContract);
    }
    const rawConfig = data['config_defaults'];
    if (rawConfig !== null && rawConfig !== undefined && !isRecord(rawConfig)) {
      throw new GraphDefinitionError(`登记行 ${type_name} 的 config_defaults 须为 dict`);
    }
    const rawKind = data['kind'];
    if (rawKind !== undefined && rawKind !== null && typeof rawKind !== 'string') {
      throw new GraphDefinitionError(`登记行 ${type_name} 的 kind 须为字符串`);
    }
    const rawLabel = data['label'];
    if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== 'string') {
      throw new GraphDefinitionError(`登记行 ${type_name} 的 label 须为字符串`);
    }
    const rawDescription = data['description'];
    if (
      rawDescription !== undefined
      && rawDescription !== null
      && typeof rawDescription !== 'string'
    ) {
      throw new GraphDefinitionError(`登记行 ${type_name} 的 description 须为字符串`);
    }
    let flags: NodeRegistrationFlags | null = null;
    const rawFlags = data['flags'];
    if (rawFlags !== undefined && rawFlags !== null) {
      if (!isRecord(rawFlags)) {
        throw new GraphDefinitionError(`登记行 ${type_name} 的 flags 须为 dict`);
      }
      const terminal = rawFlags['terminal'];
      if (terminal !== undefined && typeof terminal !== 'boolean') {
        throw new GraphDefinitionError(`登记行 ${type_name} 的 flags.terminal 须为布尔`);
      }
      const loop = rawFlags['loop'];
      if (loop !== undefined && typeof loop !== 'boolean') {
        throw new GraphDefinitionError(`登记行 ${type_name} 的 flags.loop 须为布尔`);
      }
      flags = { terminal, loop };
    }
    const rawSuggestion = data['suggestion'];
    let suggestion: NodeRegistrationSuggestion | null = null;
    if (rawSuggestion !== null && rawSuggestion !== undefined) {
      if (!isRecord(rawSuggestion) || rawSuggestion['kind'] === undefined) {
        throw new GraphDefinitionError(`登记行 ${type_name} 的 suggestion 形态非法`);
      }
      const kind = String(rawSuggestion['kind']);
      if (kind !== 'replace' && kind !== 'merge') {
        throw new GraphDefinitionError(`登记行 ${type_name} 的 suggestion.kind 非法: ${kind}`);
      }
      const mergeInto = rawSuggestion['merge_into'];
      suggestion = {
        kind,
        merge_into: mergeInto === undefined ? undefined : String(mergeInto),
        reason: rawSuggestion['reason'] === undefined ? undefined : String(rawSuggestion['reason']),
        ts: rawSuggestion['ts'] === undefined ? undefined : Number(rawSuggestion['ts']),
      };
    }
    const rawStatus = String(data['status'] ?? 'active');
    if (rawStatus !== 'active' && rawStatus !== 'disabled' && rawStatus !== 'archived') {
      throw new GraphDefinitionError(`登记行 ${type_name} 的 status 非法: ${rawStatus}`);
    }
    const rawProvenance = String(data['provenance'] ?? 'seed');
    if (
      rawProvenance !== 'seed'
      && rawProvenance !== 'host'
      && rawProvenance !== 'agent'
      && rawProvenance !== 'governance'
    ) {
      throw new GraphDefinitionError(`登记行 ${type_name} 的 provenance 非法: ${rawProvenance}`);
    }
    return new NodeRegistration({
      type_name,
      contract,
      config_defaults: rawConfig === null || rawConfig === undefined ? {} : { ...(rawConfig as Record<string, unknown>) },
      kind: rawKind === undefined || rawKind === null ? null : (rawKind as string),
      label: rawLabel === undefined || rawLabel === null ? null : (rawLabel as string),
      description:
        rawDescription === undefined || rawDescription === null
          ? null
          : (rawDescription as string),
      flags,
      executor: data['executor'] === undefined ? undefined : String(data['executor']),
      provenance: rawProvenance as NodeRegistrationProvenance,
      status: rawStatus as NodeRegistrationStatus,
      archived_reason:
        data['archived_reason'] === undefined || data['archived_reason'] === null
          ? null
          : String(data['archived_reason']),
      suggestion,
      registered_at: Number(data['registered_at'] ?? 0),
      updated_at: Number(data['updated_at'] ?? data['registered_at'] ?? 0),
    });
  }
}

/** 登记集合名（按集隔离的动态集合，前缀受守卫）。 */
export const NODE_REGISTRY_COLLECTION_PREFIX = 'node_registry:';

export function node_registry_collection(set_id: string): string {
  return `${NODE_REGISTRY_COLLECTION_PREFIX}${set_id}`;
}
