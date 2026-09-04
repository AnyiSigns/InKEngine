/**
 * 组装域数据形态（Python path_assembler.py 数据类段移植，1:1）。
 *
 * NodeSummary / AssemblyDraftContext = 草稿上下文的窗口条目与结构化输入；
 * DraftProvider = 草稿源协议（语义方向，拓扑合法性归系统校验）；AssemblyRequest
 * = 组装请求；AssemblyEnvelope = 预算信封；AssemblyCandidate = 单条候选路径
 * （产物 = 图定义数据）；CanaryVerdict = canary 验证结论；PathAssemblyResult
 * = 组装结果（只读候选清单 + 观测统计 + 留痕）。全部为纯数据形态（frozen
 * 语义由 readonly 表达），序列化 to_dict 可经 JSON 通道传递。
 */

import { required_field_names, produced_field_names } from '../link_validator/link_validator.js';
import type { NodeContract, QualityGate } from '../contracts/contracts.js';
import { SchemaSpec } from '../schema/schemaValidator.js';
import { StateSchema } from '../state/schema.js';
import { DEFAULT_CACHE_EPSILON, DEFAULT_DOMAIN, DEFAULT_DRAFT_TIMEOUT, DEFAULT_BEAM_WIDTH, DEFAULT_LLM_WINDOW, DEFAULT_MAX_PATH_LENGTH, DEFAULT_MAX_SAFETY_TIER, DEFAULT_TOP_K, LLM_RETRY_LIMIT } from './constants.js';
import type { Graph } from '../graph/graph.js';
import type { CanaryVerdict } from './canary.js';

/** 边证据索引键（ENG9a-17 类型别名）：(src_type, dst_type, src_contract_version,
 *  dst_contract_version, variant_hash) 五元组——类型级口径（variant_hash 空）。 */
export type EdgeIndexKey = readonly [string, string, string, string, string];

/** 结点契约摘要（草稿上下文的窗口条目；提示词措辞归使用方策略）。 */
export class NodeSummary {
  readonly type_name: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly safety_tier: number;

  constructor(init: {
    type_name: string;
    inputs?: readonly string[];
    outputs?: readonly string[];
    safety_tier?: number;
  }) {
    this.type_name = init.type_name;
    this.inputs = init.inputs ?? [];
    this.outputs = init.outputs ?? [];
    this.safety_tier = init.safety_tier ?? 0;
  }

  to_dict(): Record<string, unknown> {
    return {
      type_name: this.type_name,
      inputs: [...this.inputs],
      outputs: [...this.outputs],
      safety_tier: this.safety_tier,
    };
  }

  static from_contract(type_name: string, contract: NodeContract): NodeSummary {
    return new NodeSummary({
      type_name,
      inputs: [...required_field_names(contract.input_schema)].sort(),
      outputs: [...produced_field_names(contract.output_schema)].sort(),
      safety_tier: contract.safety_tier,
    });
  }
}

/** 草稿上下文（引擎组装的**结构化输入**；提示词模板归使用方）。 */
export class AssemblyDraftContext {
  readonly goal_fields: readonly string[];
  readonly entry_fields: readonly string[];
  readonly node_summaries: readonly NodeSummary[];
  readonly feedback: string;

  constructor(init: {
    goal_fields: readonly string[];
    entry_fields: readonly string[];
    node_summaries?: readonly NodeSummary[];
    feedback?: string;
  }) {
    this.goal_fields = init.goal_fields;
    this.entry_fields = init.entry_fields;
    this.node_summaries = init.node_summaries ?? [];
    this.feedback = init.feedback ?? '';
  }

  to_dict(): Record<string, unknown> {
    return {
      goal_fields: [...this.goal_fields],
      entry_fields: [...this.entry_fields],
      node_summaries: this.node_summaries.map((n) => n.to_dict()),
      feedback: this.feedback,
    };
  }
}

/** 草稿源协议（使用方注入；语义方向，拓扑合法性归系统校验）。 */
export interface DraftProvider {
  draft(context: AssemblyDraftContext): Promise<string>;
}

/** 组装请求（输入声明：目标 + 域 + 安全档 + 质量闸门 + 草稿源）。 */
export class AssemblyRequest {
  readonly goal_schema: SchemaSpec | null;
  readonly entry_fields: readonly string[];
  readonly domain: string;
  readonly max_safety_tier: number;
  readonly quality_gate: QualityGate | null;
  readonly state_schema: StateSchema | null;
  readonly draft_provider: DraftProvider | null;
  readonly top_k: number;
  readonly graph_name: string | null;

  constructor(init: {
    goal_schema?: SchemaSpec | null;
    entry_fields?: readonly string[];
    domain?: string;
    max_safety_tier?: number;
    quality_gate?: QualityGate | null;
    state_schema?: StateSchema | null;
    draft_provider?: DraftProvider | null;
    top_k?: number;
    graph_name?: string | null;
  } = {}) {
    this.goal_schema = init.goal_schema ?? null;
    this.entry_fields = init.entry_fields ?? [];
    this.domain = init.domain ?? DEFAULT_DOMAIN;
    this.max_safety_tier = init.max_safety_tier ?? DEFAULT_MAX_SAFETY_TIER;
    this.quality_gate = init.quality_gate ?? null;
    this.state_schema = init.state_schema ?? null;
    this.draft_provider = init.draft_provider ?? null;
    this.top_k = init.top_k ?? DEFAULT_TOP_K;
    this.graph_name = init.graph_name ?? null;
  }

  /** 目标字段：必填字段优先；无必填声明 = 全部声明字段。 */
  goal_fields(): readonly string[] {
    if (this.goal_schema === null) return [];
    const required = [...required_field_names(this.goal_schema)].sort();
    if (required.length > 0) return required;
    return [...produced_field_names(this.goal_schema)].sort();
  }

  /** 序列化为数据形态（供 JSON 通道传递；运行态注入件不入键）。 */
  to_dict(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      domain: this.domain,
      max_safety_tier: this.max_safety_tier,
      top_k: this.top_k,
      entry_fields: [...this.entry_fields],
    };
    if (this.goal_schema !== null) data['goal_schema'] = this.goal_schema.to_dict();
    if (this.state_schema !== null) data['state_schema'] = this.state_schema.to_dict();
    if (this.graph_name !== null) data['graph_name'] = this.graph_name;
    return data;
  }

  /** 从数据形态重建（数据键 + 运行态注入件分列；缺省键 = 默认值）。 */
  static from_dict(
    data: Record<string, unknown>,
    inject: {
      quality_gate?: QualityGate | null;
      draft_provider?: DraftProvider | null;
      state_schema?: StateSchema | null;
    } = {},
  ): AssemblyRequest {
    const raw_goal = data['goal_schema'];
    const raw_state = data['state_schema'];
    let state_schema = inject.state_schema ?? null;
    if (raw_state !== null && raw_state !== undefined) {
      state_schema = StateSchema.from_dict(raw_state);
    }
    return new AssemblyRequest({
      goal_schema:
        raw_goal !== null && raw_goal !== undefined
          ? SchemaSpec.from_dict(raw_goal)
          : null,
      entry_fields: (data['entry_fields'] as readonly string[] | undefined) ?? [],
      domain: String(data['domain'] ?? DEFAULT_DOMAIN),
      max_safety_tier: Number(data['max_safety_tier'] ?? DEFAULT_MAX_SAFETY_TIER),
      quality_gate: inject.quality_gate ?? null,
      state_schema,
      draft_provider: inject.draft_provider ?? null,
      top_k: Number(data['top_k'] ?? DEFAULT_TOP_K),
      graph_name: (data['graph_name'] as string | null | undefined) ?? null,
    });
  }
}

/** 预算信封（组装资源上限；默认值引擎钉死，使用方仅覆盖权）。 */
export class AssemblyEnvelope {
  readonly beam_width: number;
  readonly max_path_length: number;
  readonly llm_retry_limit: number;
  readonly llm_draft: boolean;
  readonly llm_window: number;
  readonly draft_timeout: number;

  constructor(init: {
    beam_width?: number;
    max_path_length?: number;
    llm_retry_limit?: number;
    llm_draft?: boolean;
    llm_window?: number;
    draft_timeout?: number;
  } = {}) {
    this.beam_width = init.beam_width ?? DEFAULT_BEAM_WIDTH;
    this.max_path_length = init.max_path_length ?? DEFAULT_MAX_PATH_LENGTH;
    this.llm_retry_limit = init.llm_retry_limit ?? LLM_RETRY_LIMIT;
    this.llm_draft = init.llm_draft ?? false;
    this.llm_window = init.llm_window ?? DEFAULT_LLM_WINDOW;
    this.draft_timeout = init.draft_timeout ?? DEFAULT_DRAFT_TIMEOUT;
  }
}

/** 一条候选路径（产物 = 图定义数据，可序列化/重建/试跑）。 */
export class AssemblyCandidate {
  readonly rank: number;
  readonly source: string;
  readonly repaired: boolean;
  readonly graph: Graph;
  readonly score: number;

  constructor(init: {
    rank: number;
    source: string;
    repaired: boolean;
    graph: Graph;
    score?: number;
  }) {
    this.rank = init.rank;
    this.source = init.source;
    this.repaired = init.repaired;
    this.graph = init.graph;
    this.score = init.score ?? 0.0;
  }

  /** 候选链（类型名序；节点名 = 类型名，链内不重复）。 */
  get chain(): readonly string[] {
    return Object.keys(this.graph.node_bindings);
  }

  to_dict(): Record<string, unknown> {
    return {
      rank: this.rank,
      source: this.source,
      repaired: this.repaired,
      score: this.score,
      chain: [...this.chain],
      graph: this.graph.to_dict(),
    };
  }
}

/** 组装结果（只读候选清单 + 观测统计 + 验证/审计留痕）。 */
export class PathAssemblyResult {
  readonly candidates: readonly AssemblyCandidate[];
  readonly fingerprint: string;
  readonly cold_start_index: number;
  readonly exploration_mode: boolean;
  readonly multipath_signal: boolean;
  readonly fallback_reason: string | null;
  readonly llm_attempts: number;
  readonly stats: Record<string, number>;
  readonly canary: readonly CanaryVerdict[];
  readonly audit: readonly Record<string, unknown>[];

  constructor(init: {
    candidates?: readonly AssemblyCandidate[];
    fingerprint?: string;
    cold_start_index?: number;
    exploration_mode?: boolean;
    multipath_signal?: boolean;
    fallback_reason?: string | null;
    llm_attempts?: number;
    stats?: Record<string, number>;
    canary?: readonly CanaryVerdict[];
    audit?: readonly Record<string, unknown>[];
  } = {}) {
    this.candidates = init.candidates ?? [];
    this.fingerprint = init.fingerprint ?? '';
    this.cold_start_index = init.cold_start_index ?? 0.0;
    this.exploration_mode = init.exploration_mode ?? false;
    this.multipath_signal = init.multipath_signal ?? false;
    this.fallback_reason = init.fallback_reason ?? null;
    this.llm_attempts = init.llm_attempts ?? 0;
    this.stats = { ...(init.stats ?? {}) };
    this.canary = init.canary ?? [];
    this.audit = init.audit ?? [];
  }

  get is_empty(): boolean {
    return this.candidates.length === 0;
  }

  to_dict(): Record<string, unknown> {
    return {
      candidates: this.candidates.map((c) => c.to_dict()),
      fingerprint: this.fingerprint,
      cold_start_index: this.cold_start_index,
      exploration_mode: this.exploration_mode,
      multipath_signal: this.multipath_signal,
      fallback_reason: this.fallback_reason,
      llm_attempts: this.llm_attempts,
      stats: { ...this.stats },
      canary: this.canary.map((v) => v.to_dict()),
      audit: this.audit.map((r) => ({ ...r })),
    };
  }
}
