/**
 * PathAssembler（组装编排层）——path_assembler.py「组装器 assemble」段移植。
 *
 * 只读路径组装器（出候选计划供观察/审计，不接执行路径）：① schema 反推
 * （纯算法正向链式搜索，目标相关度优先排序）；② LLM 草稿（使用方注入，重试
 * 上限 2，空/非 JSON 不重试直接兜底）；③ 证据评分 + beam top-k。先例层 =
 * 技能链（缓存未命中后、算法层前）；缓存命中 = 最优先直接返回（含图定义）。
 * 组装完成后不入缓存（入库 = 沉淀侧）；仅顶替机制（证据漂移/抽样重装后重组
 * 装比分更高）写缓存维护条目并留 fingerprint_replace 审计。本文件只编排：
 * 缓存/证据机制在 PathAssemblerBase，草稿/评分/多径在 PathAssemblerDraft。
 */

import { edge_evidence_from_dict } from '../edge_evidence/index.js';
import type { EdgeEvidence } from '../edge_evidence/index.js';
import { edge_evidence_to_dict } from '../edge_evidence/index.js';
import { graph_fingerprint } from '../fingerprint/fingerprint.js';
import { is_exploration_mode } from '../edge_evidence/index.js';
import type { NodeContract } from '../contracts/contracts.js';
import type { AssemblyRequest } from './types.js';
import { AssemblyCandidate, AssemblyEnvelope, PathAssemblyResult } from './types.js';
import {
  CANDIDATE_SOURCE_ALGORITHM,
  STATS_BEAM_EXTENSIONS,
  STATS_CACHE_HITS,
  STATS_CACHE_MISSES,
  STATS_CACHE_INVALIDATIONS,
  STATS_CACHE_REPLACEMENTS,
  STATS_EDGE_SCORE_CALLS,
  STATS_LLM_ATTEMPTS,
  STATS_REPAIR_ATTEMPTS,
} from './constants.js';
import { REPLACE_REASON_DRIFT, REPLACE_REASON_SAMPLE } from '../fingerprint_cache/index.js';
import type { FingerprintCacheEntry } from '../fingerprint_cache/index.js';
import { _forward_search } from './search.js';
import { validate_chain } from './validate.js';
import { assembly_audit_record } from './audit.js';
import { PathAssemblerDraft } from './_assembler_pipeline.js';
import type { _ChainSourceRepaired } from './_assembler_pipeline.js';

/**
 * 只读路径组装器（出候选计划供观察/审计，不接执行路径）。
 *
 * 消费方构造注入 registry/evidence_store/retriever/config/sink/now/cache/
 * model_id/cache_epsilon/rng/skill_provider（None = 对应层零参与）；机制开关
 * 关闭（config.enabled=False）时零生效；观测出口 = 组装候选事件 + 审计记录
 * （sink 承接落库）。
 */
export class PathAssembler extends PathAssemblerDraft {
  /** 执行一次只读组装（出候选计划；不接执行路径）。
   *
   * 约束：机制开关关闭（config.enabled=False）时零生效；池子无带契约结点或
   * 目标无字段 = 空结果 + 原因。缓存参与（注入缓存实例时）：先例层命中最
   * 优先——命中直接返回缓存路径候选；未命中走既有组装三产出层。
   */
  async assemble(
    request: AssemblyRequest,
    envelope: AssemblyEnvelope | null = null,
  ): Promise<PathAssemblyResult> {
    if (this._config !== null && !this._config.enabled) return new PathAssemblyResult();
    const effective_envelope = envelope ?? new AssemblyEnvelope();
    const goal = request.goal_fields();
    if (goal.length === 0) {
      return new PathAssemblyResult({ fallback_reason: '目标 schema 未声明字段' });
    }
    const pool = this.contract_pool();
    if (Object.keys(pool).length === 0) {
      return new PathAssemblyResult({ fallback_reason: '结点池无带契约结点' });
    }
    const stats: Record<string, number> = {
      [STATS_BEAM_EXTENSIONS]: 0,
      [STATS_EDGE_SCORE_CALLS]: 0,
      [STATS_REPAIR_ATTEMPTS]: 0,
      [STATS_LLM_ATTEMPTS]: 0,
    };
    // ── 先例层：缓存命中（注入缓存实例时参与；未注入 = 零查找零写入）──
    const cache = this._cache;
    let cache_key: string | null = null;
    let entry: FingerprintCacheEntry | null = null;
    let comparable = false;
    let replace_reason: string | null = null;
    // 域内证据行只查一次（ENG9a-16）：缓存校验/顶替与组装评分共用
    let evidence_rows: readonly Record<string, unknown>[] | null = null;
    if (cache !== null && this._evidence !== null) {
      const edges = await this._evidence.list_edges(request.domain);
      evidence_rows = edges.map((e) => edge_evidence_to_dict(e));
    }
    const index = this._index_pool(pool);
    let evidence_index: Map<string, EdgeEvidence>;
    if (evidence_rows !== null) {
      evidence_index = this._evidence_index_from_rows(
        evidence_rows.map((row) => edge_evidence_from_dict(row)),
      );
    } else {
      evidence_index = await this._evidence_index(request.domain);
    }
    if (cache !== null) {
      stats[STATS_CACHE_HITS] = 0;
      stats[STATS_CACHE_MISSES] = 0;
      stats[STATS_CACHE_INVALIDATIONS] = 0;
      stats[STATS_CACHE_REPLACEMENTS] = 0;
      cache_key = this._cache_key(request, goal);
      entry = await cache.lookup(cache_key);
      if (entry === null) {
        stats[STATS_CACHE_MISSES] = 1;
      } else {
        const status = await this._validate_cache_entry(cache_key, entry, pool, evidence_rows, stats);
        if (status === 'drift') {
          comparable = true;
          replace_reason = REPLACE_REASON_DRIFT;
          stats[STATS_CACHE_MISSES] = 1;
        } else if (status === 'stale') {
          entry = null;
          stats[STATS_CACHE_MISSES] = 1;
        } else if (this._cache_epsilon > 0 && this._rng() < this._cache_epsilon) {
          comparable = true;
          replace_reason = REPLACE_REASON_SAMPLE;
          stats[STATS_CACHE_MISSES] = 1;
        } else {
          const hit = await this._result_from_cache(entry, stats, index, evidence_index);
          if (hit !== null) {
            if (this._sink !== null) this._sink(this._audit_record(request, goal, hit));
            return hit;
          }
          entry = null;
          stats[STATS_CACHE_MISSES] = 1;
        }
      }
    }
    // ① schema 反推（纯算法，全量搜索——无需上下文，池子规模解耦）
    const algorithm_chains = _forward_search(goal, request.entry_fields, pool, {
      beam_width: effective_envelope.beam_width,
      max_depth: effective_envelope.max_path_length,
      max_safety_tier: request.max_safety_tier,
      edge_score_lookup: (src: string, dst: string): number =>
        this._edge_score_of(src, dst, index, evidence_index, stats),
      stats,
      views: index,
    });
    const chains: _ChainSourceRepaired[] = [...(await this._skill_chains(request, pool))];
    for (const chain of algorithm_chains) {
      chains.push([chain, CANDIDATE_SOURCE_ALGORITHM, false]);
    }
    let llm_attempts = 0;
    let fallback_reason: string | null = null;
    // ② LLM 草稿（使用方注入；仅反推解不出时由使用方开启 llm_draft）
    if (effective_envelope.llm_draft && request.draft_provider !== null) {
      const [draft_chains, reason] = await this._draft_path(
        request,
        goal,
        pool,
        effective_envelope,
        stats,
      );
      chains.push(...draft_chains);
      llm_attempts = stats[STATS_LLM_ATTEMPTS] ?? 0;
      fallback_reason = reason;
      if (chains.length === 0 && reason === null) {
        fallback_reason = '草稿层未产出候选且算法层无解';
      }
    } else {
      stats[STATS_LLM_ATTEMPTS] = 0;
    }
    if (chains.length === 0) {
      return new PathAssemblyResult({
        fallback_reason: fallback_reason ?? '算法层未解出目标覆盖链',
        llm_attempts,
        stats: { ...stats },
      });
    }
    // 候选合法性兜底过滤（搜索/修复已保证，此处为序列化红线最终防线）
    const pairs: _ChainSourceRepaired[] = [];
    for (const [chain, source, repaired] of chains) {
      const [ok] = validate_chain(chain, {
        pool,
        goal_fields: goal,
        entry_fields: request.entry_fields,
        max_safety_tier: request.max_safety_tier,
        state_schema: request.state_schema,
        views: index,
      });
      if (ok) pairs.push([chain, source, repaired]);
    }
    if (pairs.length === 0) {
      return new PathAssemblyResult({
        fallback_reason: fallback_reason ?? '全部候选未通过合法性校验',
        llm_attempts,
        stats: { ...stats },
      });
    }
    // ③ 证据评分 + beam top-k（确定性序）
    const ranked = await this._rank_chains(pairs, index, evidence_index, stats);
    const top_k = Math.max(1, Math.trunc(request.top_k));
    const selected = ranked.slice(0, top_k);
    const candidates: AssemblyCandidate[] = [];
    for (let rankIndex = 0; rankIndex < selected.length; rankIndex++) {
      const [chain, source, repaired, score] = selected[rankIndex]!;
      candidates.push(
        new AssemblyCandidate({
          rank: rankIndex + 1,
          source,
          repaired,
          graph: this._build_graph(chain, pool, request, rankIndex + 1),
          score,
        }),
      );
    }
    const cold_index = await this._cold_start_index(ranked, index, evidence_index);
    const multipath = await this._multipath_signal(
      candidates.length > 0 ? candidates[0]! : null,
      candidates.length > 1 ? candidates[1]! : null,
      index,
      evidence_index,
    );
    const fingerprint = candidates.length > 0 ? graph_fingerprint(candidates[0]!.graph) : '';
    let result = new PathAssemblyResult({
      candidates,
      fingerprint,
      cold_start_index: cold_index,
      exploration_mode: is_exploration_mode(cold_index),
      multipath_signal: multipath,
      fallback_reason,
      llm_attempts,
      stats: { ...stats },
    });
    if (
      cache !== null &&
      cache_key !== null &&
      entry !== null &&
      comparable
    ) {
      await this._maybe_replace_cache_entry(
        cache,
        cache_key,
        entry,
        request,
        result,
        evidence_rows,
        replace_reason ?? '',
        stats,
      );
      // 顶替计数随内部统计字典更新，结果快照须重新按值拷贝（ENG9a-19）
      result = new PathAssemblyResult({ ...result, stats: { ...stats } });
    }
    if (this._sink !== null) {
      this._sink(this._audit_record(request, goal, result));
    }
    return result;
  }

  /** 组装审计记录（append-only 留痕；历史图定义快照随记录落库）。 */
  private _audit_record(
    request: AssemblyRequest,
    goal: readonly string[],
    result: PathAssemblyResult,
  ): Record<string, unknown> {
    return assembly_audit_record(request, goal, result, { ts: this._now ?? 0 });
  }
}
