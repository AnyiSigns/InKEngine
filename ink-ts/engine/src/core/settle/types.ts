/**
 * 沉淀模块数据形态与主键编码（对标 ink_engine.core.settle 的 dataclass 层）。
 *
 * 本文件承载回放/归因/登记的数据载体：
 * - TraceStep：执行器轨迹中的一步（结点级成败留痕，不发射事件）。执行器
 *   在采集期就地改写 status/tokens（成败判定与成本归集在结点块收尾时
 *   定型），故实例可变、非冻结。member=True = 并行组成员步骤（不参与边
 *   遍历推导——成员间无图边语义，仅参与成败/审计统计）。
 * - Traversal：轨迹回放推导出的一条边遍历（连续执行且图中存在该边）。
 * - EdgeUpdate：归因更新计划（纯数据：成败 + 成本 + 增量；由存储钩子逐条落库）。
 * - SettleContext：一次 run 的沉淀上下文（引擎在收尾处组装，钩子只读消费）。
 *
 * 键编码（Python tuple 哈希在 TS 以字符串编码表达）：
 * - graph_path（tuple[str, ...]）→ path_key = JSON 序列化（沿 recovery 先例）；
 * - (graph_path, node) token 账键 → token_key = JSON 序列化拼尾结点名；
 * - EdgeKey 的等值语义 → edge_key_str = 六元序元 join('::')（证据快照索引与
 *   去重集合用；沿 InMemoryEdgeEvidenceStorage 的 toKey 口径）。
 */

import { DEFAULT_CONTRACT_VERSION } from '../edge_evidence/_types.js';
import type { EdgeKey } from '../edge_evidence/_types.js';
import type { Graph } from '../graph/graph.js';
import type { RunResult } from '../run_result/run_result.js';

// ── 主键编码（tuple 语义的字符串化）──

/** 图路径 → 图查找键（graph_path 的 JSON 序列化；与 recovery 键编码同源）。 */
export function path_key(graph_path: readonly string[]): string {
  return JSON.stringify(graph_path);
}

/** (图路径, 结点名) → 结点 token 账键（路径元组 JSON 序列化后拼结点名）。 */
export function token_key(graph_path: readonly string[], node: string): string {
  return JSON.stringify([...graph_path, node]);
}

/** EdgeKey → 字符串主键（六元序元 join('::')，等值语义替代）。 */
export function edge_key_str(key: EdgeKey): string {
  return [
    key.src_type,
    key.dst_type,
    key.src_contract_version,
    key.dst_contract_version,
    key.context_domain,
    key.variant_hash,
  ].join('::');
}

/** 遍历边 → 归因 EdgeKey（变体维度取 dst 变体指纹；域取上下文域）。 */
export function traversal_edge_key(tr: Traversal, context_domain: string): EdgeKey {
  return {
    src_type: tr.src_type,
    dst_type: tr.dst_type,
    src_contract_version: tr.src_contract_version,
    dst_contract_version: tr.dst_contract_version,
    context_domain,
    variant_hash: tr.dst_variant_hash,
  };
}

// ── TraceStep：执行器轨迹一步 ────────────────────────────────────────────────

export class TraceStep {
  graph_path: string[] | readonly string[];
  node: string;
  status: string; // TRACE_SUCCESS / TRACE_FAILED / TRACE_SKIPPED
  tokens: number; // 结点执行边界 token 计账（usage 帧纯算法归集）
  member: boolean; // 并行组成员步骤标记

  constructor(init: {
    graph_path: readonly string[] | null;
    node: string;
    status: string;
    tokens?: number;
    member?: boolean;
  }) {
    this.graph_path = init.graph_path ?? [];
    this.node = init.node;
    this.status = init.status;
    this.tokens = init.tokens ?? 0;
    this.member = init.member ?? false;
  }

  to_dict(): Record<string, unknown> {
    return {
      graph_path: [...this.graph_path],
      node: this.node,
      status: this.status,
      tokens: this.tokens,
    };
  }
}

// ── Traversal：一条边遍历（轨迹回放推导；连续执行且图中存在该边）──

export class Traversal {
  readonly graph_path: readonly string[];
  readonly src: TraceStep;
  readonly dst: TraceStep;
  readonly src_type: string;
  readonly dst_type: string;
  readonly src_contract_version: string;
  readonly dst_contract_version: string;
  readonly src_variant_hash: string;
  readonly dst_variant_hash: string;

  constructor(init: {
    graph_path: readonly string[];
    src: TraceStep;
    dst: TraceStep;
    src_type: string;
    dst_type: string;
    src_contract_version: string;
    dst_contract_version: string;
    src_variant_hash?: string;
    dst_variant_hash?: string;
  }) {
    this.graph_path = init.graph_path;
    this.src = init.src;
    this.dst = init.dst;
    this.src_type = init.src_type;
    this.dst_type = init.dst_type;
    this.src_contract_version = init.src_contract_version;
    this.dst_contract_version = init.dst_contract_version;
    this.src_variant_hash = init.src_variant_hash ?? '';
    this.dst_variant_hash = init.dst_variant_hash ?? '';
    Object.freeze(this);
  }
}

// ── EdgeUpdate：归因更新计划（纯数据，由存储钩子逐条落库）──

export class EdgeUpdate {
  readonly key: EdgeKey;
  readonly kind: string; // UPDATE_SUCCESS / UPDATE_FAIL
  readonly cost: number;
  readonly delta: number; // 增量（成功 +1；失败 = 加权分摊 blame 量）

  constructor(init: { key: EdgeKey; kind: string; cost: number; delta?: number }) {
    this.key = init.key;
    this.kind = init.kind;
    this.cost = init.cost;
    this.delta = init.delta ?? 1;
    Object.freeze(this);
  }
}

// ── SettleContext：一次 run 的沉淀上下文 ─────────────────────────────────────
// 引擎在 run 收尾处组装注入；钩子只读消费。图/账两字典以字符串键承载
// （path_key / token_key 编码，见文件头）。

/** SettleContext 构造选项（graph_path/round_id 缺省按 Python dataclass 默认）。 */
export interface SettleContextInit {
  thread_id: string;
  round_id: string | null;
  trace_id: string;
  domain: string;
  steps: readonly TraceStep[] | TraceStep[];
  node_tokens?: Map<string, number> | null;
  graphs?: Map<string, Graph> | null;
  result: RunResult;
}

export class SettleContext {
  thread_id: string;
  round_id: string | null;
  trace_id: string;
  domain: string;
  steps: TraceStep[];
  node_tokens: Map<string, number>;
  graphs: Map<string, Graph>;
  result: RunResult;

  constructor(init: SettleContextInit) {
    this.thread_id = init.thread_id;
    this.round_id = init.round_id;
    this.trace_id = init.trace_id;
    this.domain = init.domain;
    this.steps = [...init.steps];
    this.node_tokens = init.node_tokens ?? new Map<string, number>();
    this.graphs = init.graphs ?? new Map<string, Graph>();
    this.result = init.result;
  }
}

// ── 结点身份解析 ─────────────────────────────────────────────────────────────

/**
 * 结点 → [类型名, 契约版本, 变体指纹]：声明式绑定取注册类型与配置内版本，
 * 以及可选 variant_hash（节点配置/提示词变体指纹，空 = 类型级兼容）；
 * 直挂函数取结点名 + 缺省版本 + 空变体。
 */
export function node_identity(
  graph: Graph | null,
  node: string,
): [string, string, string] {
  if (graph === null) {
    return [node, DEFAULT_CONTRACT_VERSION, ''];
  }
  const binding = graph.node_bindings[node];
  if (binding !== undefined) {
    const config = binding.config;
    const version = String(config.contract_version ?? DEFAULT_CONTRACT_VERSION);
    const variantHash = String(config.variant_hash ?? '');
    return [binding.type_name, version, variantHash];
  }
  return [node, DEFAULT_CONTRACT_VERSION, ''];
}
