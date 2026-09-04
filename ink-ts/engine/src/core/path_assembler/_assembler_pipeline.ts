/**
 * PathAssembler 草稿/评分/多径层（继承链第二层 PathAssemblerDraft）——移植
 * path_assembler.py 组装器「检索窗口/草稿层/技能先例/证据评分/多径信号/冷启动
 * 指数/候选图构造」段。
 *
 * 草稿源 = 使用方注入协议（语义方向；JSON 解析/校验/修复/兜底全归本层）；
 * 重试上限经信封透传；空响应/非 JSON 不重试直接兜底。多径判据全链口径
 * （ENG9a-22）：证据聚合 = 整链成败计数（multipath.chain_evidence 同源，
 * multipath 模块未迁移前在 snapshot.ts 按同式实现），分差 = 全链平均分。
 */

import { MULTIPATH_GAP, MULTIPATH_MIN_N } from '../edge_evidence/index.js';
import type { EdgeEvidence } from '../edge_evidence/index.js';
import { cold_start_index } from '../edge_evidence/index.js';
import { Graph } from '../graph/graph.js';
import type { NodeContract } from '../contracts/contracts.js';
import type { Retriever } from '../retrieval/index.js';
import { RetrievedChunk } from '../retrieval/index.js';
import type { AssemblyRequest } from './types.js';
import { AssemblyCandidate, AssemblyDraftContext, AssemblyEnvelope, NodeSummary } from './types.js';
import {
  CANDIDATE_SOURCE_DRAFT,
  CANDIDATE_SOURCE_SKILL,
  STATS_LLM_ATTEMPTS,
  STATS_REPAIR_ATTEMPTS,
} from './constants.js';
import { sanitize_draft_feedback, parse_draft_chain } from './draft_parse.js';
import { validate_chain } from './validate.js';
import { repair_chain } from './repair.js';
import { InMemoryPoolRetriever } from './retrieval.js';
import { _graph_chain, chain_evidence_aggregate, type_level_index_of } from './snapshot.js';
import { PathAssemblerBase } from './_assembler_cache.js';
import type { _ContractView } from './validate.js';

type Stats = Record<string, number>;

/** 候选三元组：(链, 来源, 是否经修复算子修形)。 */
export type _ChainSourceRepaired = readonly [readonly string[], string, boolean];
/** 评分后四元组：(链, 来源, 修形标记, 全链平均证据分)。 */
export type _ScoredChain = readonly [readonly string[], string, boolean, number];

/** 单次调用超时包装（draft_timeout <=0 = 不设超时；护栏镜像 wait_for）。 */
function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('草稿源调用超时'));
    }, seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 草稿层/证据层基座（对外不可见；供 PathAssembler 继承）。检索窗口经注入
 * Retriever 协议（None = 内存暴力 top-N 兜底）；草稿源上下文窗口条目 =
 * NodeSummary 契约摘要；草稿链先校验、不可达则走算法自动修复（ENG9a-25
 * 信封参数透传），仍不可达 → 结构化反馈重试，耗尽转全量算法兜底。
 */
export class PathAssemblerDraft extends PathAssemblerBase {
  /** 草稿上下文窗口：检索 top-N 契约摘要（域过滤后第二层缩小）。 */
  protected async _window_summaries(
    request: AssemblyRequest,
    goal: readonly string[],
    pool: Record<string, NodeContract>,
    envelope: AssemblyEnvelope,
  ): Promise<readonly NodeSummary[]> {
    const retriever: Retriever = this._retriever ?? new InMemoryPoolRetriever(pool);
    const query = JSON.stringify({
      goal: [...goal].sort(),
      entry: [...request.entry_fields].sort(),
      pool: Object.keys(pool).sort(),
    });
    const window = Math.max(1, Math.min(Math.trunc(envelope.llm_window), Math.max(1, Object.keys(pool).length)));
    let chunks: RetrievedChunk[];
    try {
      chunks = await retriever.retrieve(query, { limit: window });
    } catch {
      chunks = await new InMemoryPoolRetriever(pool).retrieve(query, { limit: window });
    }
    const summaries: NodeSummary[] = [];
    for (const chunk of chunks) {
      const contract = pool[chunk.doc_id];
      if (contract === undefined) continue;
      summaries.push(NodeSummary.from_contract(chunk.doc_id, contract));
    }
    if (summaries.length === 0) {
      for (const type_name of Object.keys(pool).sort()) {
        summaries.push(NodeSummary.from_contract(type_name, pool[type_name]!));
        if (summaries.length >= window) break;
      }
    }
    return summaries;
  }

  /** 技能先例链：技能值对象 → 类型链（重建失败/退化链 = 跳过）。
   *  消费时机 = 路径组装先例层（缓存未命中后、算法层前）。 */
  protected async _skill_chains(
    request: AssemblyRequest,
    pool: Record<string, NodeContract>,
  ): Promise<_ChainSourceRepaired[]> {
    const provider = this._skill_provider;
    if (provider === null) return [];
    let skills: readonly unknown[];
    try {
      skills = await provider(request);
    } catch {
      return [];
    }
    const chains: _ChainSourceRepaired[] = [];
    for (const skill of skills) {
      if (skill === null || typeof skill !== 'object') continue;
      const path = (skill as Record<string, unknown>)['path'];
      if (path === null || typeof path !== 'object' || Array.isArray(path)) continue;
      let graph: Graph;
      try {
        graph = Graph.from_dict(path as Record<string, unknown>, {
          registry: this._registry,
          validate: true,
        });
      } catch {
        continue;
      }
      const node_chain = _graph_chain(graph);
      const type_chain = node_chain
        .filter((name) => graph.node_bindings[name] !== undefined)
        .map((name) => graph.node_bindings[name]!.type_name);
      if (type_chain.length < 2) continue;
      chains.push([type_chain, CANDIDATE_SOURCE_SKILL, false]);
    }
    return chains;
  }

  /** 草稿层：草稿源 → 逐边校验 → 算法自动修复；空/非 JSON 不重试。
   *  返回 (候选链清单, 兜底原因)；兜底原因非 None = 草稿路径失败，
   *  ALGORITHM 层候选即为全量算法重组装兜底。 */
  protected async _draft_path(
    request: AssemblyRequest,
    goal: readonly string[],
    pool: Record<string, NodeContract>,
    envelope: AssemblyEnvelope,
    stats: Stats,
  ): Promise<[_ChainSourceRepaired[], string | null]> {
    const provider = request.draft_provider;
    if (provider === null) return [[], null];
    const summaries = await this._window_summaries(request, goal, pool, envelope);
    let feedback = '';
    let fallback_reason: string | null = null;
    const max_calls = Math.max(1, Math.trunc(envelope.llm_retry_limit) + 1);
    for (let attempts = 1; attempts <= max_calls; attempts++) {
      stats[STATS_LLM_ATTEMPTS] = attempts;
      const context = new AssemblyDraftContext({
        goal_fields: goal,
        entry_fields: request.entry_fields,
        node_summaries: summaries,
        feedback,
      });
      let raw: string;
      try {
        const pending = provider.draft(context);
        raw =
          envelope.draft_timeout > 0
            ? await withTimeout(pending, envelope.draft_timeout)
            : await pending;
      } catch {
        // 草稿源异常/超时兜底：不重试，直接转算法层兜底（详情不外泄给提示词）
        return [[], `草稿源调用异常（共 ${attempts} 次调用）`];
      }
      const chain = parse_draft_chain(raw);
      if (chain === null) {
        // 空响应/非 JSON：不重试直接兜底（重试闭环对环境抖动无意义）
        return [[], `草稿解析失败（空响应或非 JSON，共 ${attempts} 次调用）`];
      }
      const [ok, reasons] = validate_chain(chain, {
        pool,
        goal_fields: goal,
        entry_fields: request.entry_fields,
        max_safety_tier: request.max_safety_tier,
        state_schema: request.state_schema,
      });
      if (ok) return [[[chain, CANDIDATE_SOURCE_DRAFT, false]], null];
      // 语义偏好 vs 结构可达冲突：先走算法自动修复
      stats[STATS_REPAIR_ATTEMPTS] = (stats[STATS_REPAIR_ATTEMPTS] ?? 0) + 1;
      const repaired = repair_chain(chain, {
        pool,
        goal_fields: goal,
        entry_fields: request.entry_fields,
        max_safety_tier: request.max_safety_tier,
        state_schema: request.state_schema,
        beam_width: envelope.beam_width,
        max_depth: envelope.max_path_length,
      });
      if (repaired !== null) {
        const [okRepaired] = validate_chain(repaired, {
          pool,
          goal_fields: goal,
          entry_fields: request.entry_fields,
          max_safety_tier: request.max_safety_tier,
          state_schema: request.state_schema,
        });
        if (okRepaired) return [[[repaired, CANDIDATE_SOURCE_DRAFT, true]], null];
      }
      // 重试反馈只回结构化理由码 + 白名单类型名（模型自造结点名原文不拼回）
      feedback = sanitize_draft_feedback(reasons, pool);
      fallback_reason = '草稿非法且算法修复不可达（重试耗尽，转全量算法重组装兜底）';
    }
    return [[], fallback_reason ?? '草稿未通过校验且修复不可达'];
  }

  /** 证据评分 + beam top-k：全链边证据分平均值排序（确定性 tie-break）。
   *  平均而非求和：零证据时每条边同取先验下界，求和会系统性偏好长链；
   *  平均 + 链长升序 = 证据相同时偏短链。 */
  protected async _rank_chains(
    chains: readonly _ChainSourceRepaired[],
    index: Record<string, _ContractView>,
    evidence_index: Map<string, EdgeEvidence>,
    stats: Stats,
  ): Promise<_ScoredChain[]> {
    const scored: _ScoredChain[] = [];
    for (const [chain, source, repaired] of chains) {
      let total = 0.0;
      for (let i = 0; i + 1 < chain.length; i++) {
        total += this._edge_score_of(chain[i]!, chain[i + 1]!, index, evidence_index, stats);
      }
      const edges = Math.max(1, chain.length - 1);
      scored.push([chain, source, repaired, total / edges]);
    }
    const seen = new Set<string>();
    const unique: _ScoredChain[] = [];
    for (const item of scored) {
      const key = item[0].join('\u0000');
      if (seen.has(key)) continue; // 同链去重（保留先出现者 = 算法层优先）
      seen.add(key);
      unique.push(item);
    }
    unique.sort((a, b) => {
      if (a[3] !== b[3]) return b[3] - a[3];
      if (a[0].length !== b[0].length) return a[0].length - b[0].length;
      return compareChains(a[0], b[0]);
    });
    return unique;
  }

  /** 候选全链平均证据分（与 _rank_chains 同口径：逐边评分取平均）。 */
  protected _chain_average_score(
    candidate: AssemblyCandidate,
    index: Record<string, _ContractView>,
    evidence_index: Map<string, EdgeEvidence>,
  ): number {
    const chain = candidate.chain;
    if (chain.length < 2) return 0.0;
    let total = 0.0;
    for (let i = 0; i + 1 < chain.length; i++) {
      total += this._edge_score_of(chain[i]!, chain[i + 1]!, index, evidence_index, {});
    }
    return total / (chain.length - 1);
  }

  /** 冷启动指数 = 有证据边数 / 候选边数（候选 0 = 0.0）。 */
  protected async _cold_start_index(
    chains: readonly _ScoredChain[],
    index: Record<string, _ContractView>,
    evidence_index: Map<string, EdgeEvidence>,
  ): Promise<number> {
    const candidate_edges = new Set<string>();
    let evidenced = 0;
    for (const [chain] of chains) {
      for (let i = 0; i + 1 < chain.length; i++) {
        const src = chain[i]!;
        const dst = chain[i + 1]!;
        const pair = `${src}\u0000${dst}`;
        if (candidate_edges.has(pair)) continue;
        candidate_edges.add(pair);
        const srcVersion =
          index[src] !== undefined ? String(index[src]!.contract.version) : '1';
        const dstVersion =
          index[dst] !== undefined ? String(index[dst]!.contract.version) : '1';
        const key = [src, dst, srcVersion, dstVersion, ''].join('\u0000');
        if (evidence_index.has(key)) evidenced += 1;
      }
    }
    return cold_start_index(evidenced, candidate_edges.size);
  }

  /** 多径触发信号（全链口径，与排序同基准；只给信号不裁决）。
   *  判据与 multipath 汇流同源（ENG9a-22）：候选证据全链成败计数聚合，
   *  样本数 = 全链合计，分差 = 全链平均分差，阈值复用 MULTIPATH_MIN_N/
   *  MULTIPATH_GAP。 */
  protected async _multipath_signal(
    top1: AssemblyCandidate | null,
    top2: AssemblyCandidate | null,
    index: Record<string, _ContractView>,
    evidence_index: Map<string, EdgeEvidence>,
  ): Promise<boolean> {
    if (top1 === null || top2 === null) return true;
    const type_level_index = type_level_index_of(evidence_index);
    const c1 = chain_evidence_aggregate(top1, type_level_index);
    const c2 = chain_evidence_aggregate(top2, type_level_index);
    const n1 = c1.success_total + c1.fail_total;
    const n2 = c2.success_total + c2.fail_total;
    if (n1 < MULTIPATH_MIN_N || n2 < MULTIPATH_MIN_N) return true;
    const s1 = this._chain_average_score(top1, index, evidence_index);
    const s2 = this._chain_average_score(top2, index, evidence_index);
    return Math.abs(s1 - s2) < MULTIPATH_GAP;
  }

  /** 候选链 → 图定义数据（节点 = 类型绑定 + 契约快照；线性链）。
   *  候选图名 = 域固定名（ENG9a-18）：排名变化不改变图身份。 */
  protected _build_graph(
    chain: readonly string[],
    pool: Record<string, NodeContract>,
    request: AssemblyRequest,
    rank: number,
  ): Graph {
    void rank;
    const graph = new Graph({
      name: request.graph_name ?? `assembly.${request.domain}`,
      entry: chain[0]!,
    });
    for (const name of chain) {
      graph.add_node_type(name, name, {}, pool[name]!);
    }
    for (let i = 0; i + 1 < chain.length; i++) {
      graph.add_edge(chain[i]!, chain[i + 1]!);
    }
    graph.add_exit(chain[chain.length - 1]!);
    return graph;
  }
}

/** 两个链的字典序比较（逐项字符串序）。 */
export function compareChains(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}
