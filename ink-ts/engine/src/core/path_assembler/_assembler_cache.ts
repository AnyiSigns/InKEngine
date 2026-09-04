/**
 * PathAssembler 基类（依赖 + 池快照 + 证据索引 + 指纹缓存维护）——移植
 * path_assembler.py 组装器「构造/池/证据单查/缓存校验/命中构造/顶替」段。
 *
 * 拆分说明（≤350 行/文件）：本文件 = 继承链第一层 PathAssemblerBase（缓存与
 * 证据机制）；草稿层/评分/多径判据在 _assembler_pipeline.ts（PathAssemblerDraft
 *  extends PathAssemblerBase）；组装编排在 assembler.ts（PathAssembler extends
 * PathAssemblerDraft）——对外仍是一个 PathAssembler。`_now`/`_rng`/sink 注入式
 * （core 零时钟零随机零 IO），缓存命中构造经图定义重建（失败按未命中处理），
 * 顶替对比两侧同基线（ENG9a-5）。
 */

import { DEFAULT_CONTRACT_VERSION, EdgeEvidenceStore, cold_start_index, edge_score, is_exploration_mode } from '../edge_evidence/index.js';
import type { EdgeEvidence } from '../edge_evidence/index.js';
import { graph_fingerprint, request_fingerprint } from '../fingerprint/fingerprint.js';
import { evidence_drifted, fingerprint_replace_audit_record } from '../fingerprint_cache/index.js';
import type { FingerprintCacheEntry, FingerprintCacheStore } from '../fingerprint_cache/index.js';
import { GraphDefinitionError } from '../errors.js';
import { Graph } from '../graph/graph.js';
import type { NodeContract, PathAssemblyConfig } from '../contracts/contracts.js';
import type { NodeTypeRegistry } from '../registry/registry.js';
import type { Retriever } from '../retrieval/index.js';
import type { AssemblyRequest } from './types.js';
import { AssemblyCandidate, PathAssemblyResult } from './types.js';
import {
  CANDIDATE_SOURCE_CACHE,
  DEFAULT_CACHE_EPSILON,
  STATS_CACHE_HITS,
  STATS_CACHE_INVALIDATIONS,
  STATS_CACHE_REPLACEMENTS,
  STATS_EDGE_SCORE_CALLS,
} from './constants.js';
import type { _ContractView } from './validate.js';
import { _build_contract_views } from './validate.js';
import {
  _cached_chain_of,
  _evidence_index_from_rows,
  _graph_chain,
  _snapshot_edge,
  reorder_bindings_to_chain,
} from './snapshot.js';

/** 组装器构造选项（镜像 Python PathAssembler 关键字参）。 */
export interface PathAssemblerOptions {
  registry: NodeTypeRegistry;
  evidence_store?: EdgeEvidenceStore | null;
  retriever?: Retriever | null;
  config?: PathAssemblyConfig | null;
  sink?: ((record: Record<string, unknown>) => void) | null;
  now?: number | null;
  cache?: FingerprintCacheStore | null;
  model_id?: string;
  cache_epsilon?: number;
  rng?: (() => number) | null;
  skill_provider?: ((request: AssemblyRequest) => Promise<readonly unknown[]>) | null;
}

type Stats = Record<string, number>;

/**
 * 组装器依赖与缓存维护基座（对外不可见；供草稿/评分/编排层继承）。
 * 契约视图按池预解析一次（ENG9a-15）；域内证据全量只查一次（ENG9a-16）；
 * 缓存条目经三钉校验（契约版本快照/模型 id/证据漂移）判定可命中、漂移失效
 * 或钉死失效；命中候选 = 单候选结果（多径信号按候选不足即触发）；顶替只在
 * 重组装分更高时成立。
 */
export class PathAssemblerBase {
  protected readonly _registry: NodeTypeRegistry;
  protected readonly _evidence: EdgeEvidenceStore | null;
  protected readonly _retriever: Retriever | null;
  protected readonly _config: PathAssemblyConfig | null;
  protected readonly _sink: ((record: Record<string, unknown>) => void) | null;
  protected readonly _now: number | null;
  protected readonly _cache: FingerprintCacheStore | null;
  protected readonly _model_id: string;
  protected readonly _cache_epsilon: number;
  protected readonly _rng: () => number;
  protected readonly _skill_provider:
    | ((request: AssemblyRequest) => Promise<readonly unknown[]>)
    | null;

  constructor(options: PathAssemblerOptions) {
    this._registry = options.registry;
    this._evidence = options.evidence_store ?? null;
    this._retriever = options.retriever ?? null;
    this._config = options.config ?? null;
    this._sink = options.sink ?? null;
    this._now = options.now ?? null;
    this._cache = options.cache ?? null;
    this._model_id = options.model_id ?? '';
    this._cache_epsilon = Math.max(0.0, Number(options.cache_epsilon ?? DEFAULT_CACHE_EPSILON));
    this._rng = options.rng ?? Math.random;
    this._skill_provider = options.skill_provider ?? null;
  }

  /** 池子快照：注册表内全部带契约的类型（类型名 → 契约）。 */
  contract_pool(): Record<string, NodeContract> {
    const pool: Record<string, NodeContract> = {};
    for (const type_name of this._registry.types()) {
      const contract = this._registry.contract_for(type_name);
      if (contract !== undefined) pool[type_name] = contract as NodeContract;
    }
    return pool;
  }

  /** 池 → 预解析契约视图（ENG9a-15：字段名解析一次，校验/搜索复用）。 */
  protected _index_pool(pool: Record<string, NodeContract>): Record<string, _ContractView> {
    return _build_contract_views(pool);
  }

  /** 边证据索引（一次域内查询；组装全程在内存中计分——规模前提）。 */
  protected async _evidence_index(domain: string): Promise<Map<string, EdgeEvidence>> {
    if (this._evidence === null) return new Map();
    const rows = await this._evidence.list_edges(domain);
    return this._evidence_index_from_rows(rows);
  }

  /** 域内证据行 → 内存索引（ENG9a-16：缓存校验与组装评分共用同一份行）。 */
  protected _evidence_index_from_rows(rows: readonly EdgeEvidence[]): Map<string, EdgeEvidence> {
    return _evidence_index_from_rows(rows);
  }

  /** 缓存主键：请求侧纯函数（目标/入口字段序无关 + 域 + 档位 + 模型）。 */
  protected _cache_key(request: AssemblyRequest, goal: readonly string[]): string {
    return request_fingerprint({
      goal_fields: goal,
      entry_fields: request.entry_fields,
      domain: request.domain,
      max_safety_tier: request.max_safety_tier,
      model_id: this._model_id,
    });
  }

  /** 缓存条目失效（计数 + 语义化失效写入；reason 只留痕不落）。 */
  protected async _invalidate_cache(cache_key: string, reason: string, stats: Stats): Promise<void> {
    const cache = this._cache;
    if (cache === null) return;
    await cache.invalidate(cache_key, { reason });
    stats[STATS_CACHE_INVALIDATIONS] = (stats[STATS_CACHE_INVALIDATIONS] ?? 0) + 1;
  }

  /** 缓存条目三钉校验：契约版本快照 / 模型 id / 证据漂移。
   *  返回三态：hit=可命中；drift=证据漂移失效（条目保留供顶替对比）；
   *  stale=版本/模型钉死失效（降级不命中，不参与顶替）。 */
  protected async _validate_cache_entry(
    cache_key: string,
    entry: FingerprintCacheEntry,
    pool: Record<string, NodeContract>,
    evidence_rows: readonly Record<string, unknown>[] | null,
    stats: Stats,
  ): Promise<'hit' | 'drift' | 'stale'> {
    if (entry.model_id !== this._model_id) {
      await this._invalidate_cache(cache_key, '模型变更', stats);
      return 'stale';
    }
    for (const [type_name, version] of entry.contract_snapshot) {
      const contract = pool[type_name];
      if (contract !== undefined) {
        if (String(contract.version) !== version) {
          await this._invalidate_cache(cache_key, '契约版本漂移', stats);
          return 'stale';
        }
      } else if (version !== DEFAULT_CONTRACT_VERSION) {
        await this._invalidate_cache(cache_key, '类型已移除', stats);
        return 'stale';
      }
    }
    if (
      this._evidence !== null &&
      evidence_rows !== null &&
      evidence_drifted(entry.evidence_snapshot, evidence_rows)
    ) {
      await this._invalidate_cache(cache_key, '证据漂移', stats);
      return 'drift';
    }
    return 'hit';
  }

  /** 缓存路径证据分：按快照各边 s/f 计数重算（与组装评分同口径）。 */
  protected _score_from_snapshot(
    chain: readonly string[],
    snapshot_rows: readonly Record<string, unknown>[],
  ): number {
    let total = 0.0;
    let edge_count = 0;
    for (let i = 0; i + 1 < chain.length; i++) {
      const evidence = _snapshot_edge(snapshot_rows, chain[i]!, chain[i + 1]!);
      total += edge_score(evidence, { now: this._now }).score;
      edge_count += 1;
    }
    return edge_count > 0 ? total / edge_count : 0.0;
  }

  /** 冷启动指数（命中口径）：有快照证据的边数 / 候选边数。 */
  protected _cold_index_from_snapshot(
    chain: readonly string[],
    snapshot_rows: readonly Record<string, unknown>[],
  ): number {
    const candidate_edges = new Set<string>();
    let evidenced = 0;
    for (let i = 0; i + 1 < chain.length; i++) {
      const src = chain[i]!;
      const dst = chain[i + 1]!;
      const key = `${src}\u0000${dst}`;
      if (candidate_edges.has(key)) continue;
      candidate_edges.add(key);
      if (_snapshot_edge(snapshot_rows, src, dst) !== null) evidenced += 1;
    }
    return cold_start_index(evidenced, candidate_edges.size);
  }

  /** 命中构造：缓存路径图定义重建 → 单候选结果（含图定义，可走 canary）。
   *  重建失败（退化条目仅携指纹/结构损坏）= 按未命中处理。多径信号按全链
   *  口径（ENG9a-22：命中路径不再硬编码 False；候选不足即触发）。 */
  protected async _result_from_cache(
    entry: FingerprintCacheEntry,
    stats: Stats,
    index: Record<string, _ContractView> | null = null,
    evidence_index: Map<string, EdgeEvidence> | null = null,
  ): Promise<PathAssemblyResult | null> {
    let graph: Graph;
    try {
      graph = Graph.from_dict(entry.path, { registry: this._registry, validate: true });
    } catch (exc) {
      if (exc instanceof GraphDefinitionError) return null; // 重建失败按未命中
      throw exc;
    }
    const chain = _graph_chain(graph);
    if (chain.length === Object.keys(graph.node_bindings).length) {
      reorder_bindings_to_chain(graph, chain);
    }
    const type_chain = chain
      .filter((name) => graph.node_bindings[name] !== undefined)
      .map((name) => graph.node_bindings[name]!.type_name);
    const score = this._score_from_snapshot(type_chain, entry.evidence_snapshot);
    const cold_index = this._cold_index_from_snapshot(type_chain, entry.evidence_snapshot);
    const candidate = new AssemblyCandidate({
      rank: 1,
      source: CANDIDATE_SOURCE_CACHE,
      repaired: false,
      graph,
      score,
    });
    const multipath =
      index !== null && evidence_index !== null
        ? await this._multipath_signal(candidate, null, index, evidence_index)
        : false;
    stats[STATS_CACHE_HITS] = (stats[STATS_CACHE_HITS] ?? 0) + 1;
    return new PathAssemblyResult({
      candidates: [candidate],
      fingerprint: graph_fingerprint(graph),
      cold_start_index: cold_index,
      exploration_mode: is_exploration_mode(cold_index),
      multipath_signal: multipath,
      llm_attempts: 0,
      stats: { ...stats },
    });
  }

  /** 多径触发信号（全链口径，与排序同基准；只给信号不裁决）——按语义在
   *  草稿/评分层（PathAssemblerDraft）实现覆盖；本层只表达「候选不足即触发」
   *  与缓存命中单候选的默认分支。 */
  protected async _multipath_signal(
    _top1: AssemblyCandidate | null,
    _top2: AssemblyCandidate | null,
    _index: Record<string, _ContractView>,
    _evidence_index: Map<string, EdgeEvidence>,
  ): Promise<boolean> {
    return _top1 === null || _top2 === null;
  }

  /** 顶替对比：失效/抽样重装后的重组装结果与缓存条目标的分比较，更高才
   *  顶替（fingerprint_replace 审计留痕）。顶替写入 = 缓存维护写（新路径 +
   *  当前证据快照，计数清零重新起算）。 */
  protected async _maybe_replace_cache_entry(
    cache: FingerprintCacheStore,
    cache_key: string,
    entry: FingerprintCacheEntry,
    request: AssemblyRequest,
    result: PathAssemblyResult,
    evidence_rows: readonly Record<string, unknown>[] | null,
    replace_reason: string,
    stats: Stats,
  ): Promise<void> {
    if (result.is_empty) return;
    const new_score = result.candidates[0]!.score;
    // 顶替判据两侧同基线（ENG9a-5）：缓存分用当前证据行重算
    const cached_score = this._score_from_snapshot(_cached_chain_of(entry), evidence_rows ?? []);
    if (new_score <= cached_score) return;
    const new_graph = result.candidates[0]!.graph;
    stats[STATS_CACHE_REPLACEMENTS] = (stats[STATS_CACHE_REPLACEMENTS] ?? 0) + 1;
    if (this._sink !== null) {
      this._sink(
        fingerprint_replace_audit_record({
          domain: request.domain,
          fingerprint: graph_fingerprint(new_graph),
          old_fingerprint: entry.path_fingerprint,
          reason: replace_reason,
          old_score: cached_score,
          new_score,
          ts: this._now ?? 0,
        }),
      );
    }
    await cache.upsert(cache_key, {
      path: new_graph.to_dict(),
      evidence_snapshot: evidence_rows ?? [],
      model_id: this._model_id,
      gate_passed: true,
      path_fingerprint: graph_fingerprint(new_graph),
      domain: request.domain,
    });
  }

  /** 边证据分（评分公式复用 edge_evidence；零证据 = 先验下界）。 */
  protected _edge_score_of(
    src: string,
    dst: string,
    index: Record<string, _ContractView>,
    evidence_index: Map<string, EdgeEvidence>,
    stats: Stats,
  ): number {
    const srcVersion =
      index[src] !== undefined ? String(index[src]!.contract.version) : DEFAULT_CONTRACT_VERSION;
    const dstVersion =
      index[dst] !== undefined ? String(index[dst]!.contract.version) : DEFAULT_CONTRACT_VERSION;
    const key = [src, dst, srcVersion, dstVersion, ''].join('\u0000');
    const evidence = evidence_index.get(key) ?? null;
    const score = edge_score(evidence, { now: this._now }).score;
    stats[STATS_EDGE_SCORE_CALLS] = (stats[STATS_EDGE_SCORE_CALLS] ?? 0) + 1;
    return score;
  }
}
