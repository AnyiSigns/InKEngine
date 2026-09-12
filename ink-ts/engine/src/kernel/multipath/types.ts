/**
 * 多径机制输入数据形态（隔离试跑候选的进程内载体）。
 *
 * 候选链路类型原属组装域（path_assembler/types.ts）；组装机制退役后，
 * 多径 = 隔离试跑基座（KEEP），其输入形态（候选路径 + 请求声明）随之
 * 收编到本机制——纯数据形态（readonly），序列化 to_dict 可经 JSON 通道
 * 传递。
 */

import { required_field_names, produced_field_names } from '../../core/link_validator/link_validator.js';
import type { QualityGate } from '../../model/contracts/contracts.js';
import { SchemaSpec } from '../../model/schema/schemaValidator.js';
import { StateSchema } from '../../core/state/schema.js';
import type { Graph } from '../../model/graph/graph.js';

/** 默认域（与组装域常量同值：general）。 */
const DEFAULT_DOMAIN = 'general';
/** 默认候选数（top_k 缺省）。 */
const DEFAULT_TOP_K = 8;
/** 默认安全档上限（常规任务 0；≥1 视为高风险放行 k>2）。 */
const DEFAULT_MAX_SAFETY_TIER = 0;

/** 草稿源协议（结构化输入 → 图草稿；多径只透传不消费）。 */
export interface DraftProvider {
  draft(context: unknown): Promise<string>;
}

/** 候选执行请求（目标 + 域 + 安全档 + 质量闸门声明）。 */
export class AssemblyRequest {
  readonly goal_schema: SchemaSpec | null;
  readonly entry_fields: readonly string[];
  readonly domain: string;
  readonly max_safety_tier: number;
  readonly quality_gate: QualityGate | null;
  readonly state_schema: StateSchema | null;
  readonly draft_provider: DraftProvider | null;
  readonly top_k: number;

  constructor(init: {
    goal_schema?: SchemaSpec | null;
    entry_fields?: readonly string[];
    domain?: string;
    max_safety_tier?: number;
    quality_gate?: QualityGate | null;
    state_schema?: StateSchema | null;
    draft_provider?: DraftProvider | null;
    top_k?: number;
  } = {}) {
    this.goal_schema = init.goal_schema ?? null;
    this.entry_fields = init.entry_fields ?? [];
    this.domain = init.domain ?? DEFAULT_DOMAIN;
    this.max_safety_tier = init.max_safety_tier ?? DEFAULT_MAX_SAFETY_TIER;
    this.quality_gate = init.quality_gate ?? null;
    this.state_schema = init.state_schema ?? null;
    this.draft_provider = init.draft_provider ?? null;
    this.top_k = init.top_k ?? DEFAULT_TOP_K;
  }

  /** 目标字段：必填字段优先；无必填声明 = 全部声明字段。 */
  goal_fields(): readonly string[] {
    if (this.goal_schema === null) return [];
    const required = [...required_field_names(this.goal_schema)].sort();
    if (required.length > 0) return required;
    return [...produced_field_names(this.goal_schema)].sort();
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