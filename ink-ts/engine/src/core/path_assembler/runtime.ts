/**
 * 组装指令运行期 PathAssemblyRuntime（path_assembler.py「组装指令入口」段移植）。
 *
 * 指令运行期：注册表/证据/开关/缓存/草稿源/技能先例的持有者；提供组装指令
 * 执行入口（assemble_plan）——组装 + canary 验证链路 + 审计留痕。canary 单回
 * 合执行依赖引擎执行器（executor 未迁移，见 canary.ts defer 预留），本层在
 * canary=True 时的执行验证会抛明确的未迁移错误；重建级验证与组装/审计/统计
 * 累计（canary=False 路径）完整可用。
 */

import { request_fingerprint } from '../fingerprint/fingerprint.js';
import type { NodeTypeRegistry } from '../registry/registry.js';
import type { EdgeEvidenceStore } from '../edge_evidence/index.js';
import type { Retriever } from '../retrieval/index.js';
import type { NodeContract, PathAssemblyConfig } from '../contracts/contracts.js';
import type { FingerprintCacheStore } from '../fingerprint_cache/index.js';
import type { AssemblyRequest } from './types.js';
import { AssemblyCandidate, AssemblyEnvelope, PathAssemblyResult } from './types.js';
import { CanaryVerdict } from './canary.js';
import {
  CANDIDATE_SOURCE_CACHE,
  DEFAULT_CACHE_EPSILON,
  STATS_CACHE_HITS,
} from './constants.js';
import { assembly_audit_record } from './audit.js';
import { canary_instantiate, canary_round } from './canary.js';
import { PathAssembler } from './assembler.js';
import type { PathAssemblerOptions } from './_assembler_cache.js';

type AuditSink = ((record: Record<string, unknown>) => void) | null;

/** 组装指令运行期（构造镜像 Python PathAssemblyRuntime 关键字参）。 */
export class PathAssemblyRuntime {
  readonly registry: NodeTypeRegistry;
  readonly evidence_store: EdgeEvidenceStore | null;
  readonly retriever: Retriever | null;
  readonly config: PathAssemblyConfig | null;
  readonly sink: AuditSink;
  readonly now: number | null;
  readonly canary: boolean;
  readonly cache: FingerprintCacheStore | null;
  readonly model_id: string;
  readonly cache_epsilon: number;
  readonly canary_timeout: number | null;
  readonly canary_options: unknown | null;
  readonly multipath_enabled: boolean;
  /** 组装统计累计（进程内跨调用聚合：stats 最后一跳的数据源）。 */
  stats_total: Record<string, number>;
  /** 技能先例提供器（异步；组装请求 → 候选技能链）。 */
  readonly skill_provider: ((request: AssemblyRequest) => Promise<readonly unknown[]>) | null;
  /** 最近一次组装请求的缓存主键（沉淀侧读取对齐写入键；空 = 尚未组装）。 */
  last_request_fingerprint: string;

  constructor(init: {
    registry: NodeTypeRegistry;
    evidence_store?: EdgeEvidenceStore | null;
    retriever?: Retriever | null;
    config?: PathAssemblyConfig | null;
    sink?: AuditSink;
    now?: number | null;
    canary?: boolean;
    cache?: FingerprintCacheStore | null;
    model_id?: string;
    cache_epsilon?: number;
    canary_timeout?: number | null;
    canary_options?: unknown | null;
    multipath_enabled?: boolean;
    stats_total?: Record<string, number>;
    skill_provider?: ((request: AssemblyRequest) => Promise<readonly unknown[]>) | null;
  }) {
    this.registry = init.registry;
    this.evidence_store = init.evidence_store ?? null;
    this.retriever = init.retriever ?? null;
    this.config = init.config ?? null;
    this.sink = init.sink ?? null;
    this.now = init.now ?? null;
    this.canary = init.canary ?? true;
    this.cache = init.cache ?? null;
    this.model_id = init.model_id ?? '';
    this.cache_epsilon = init.cache_epsilon ?? DEFAULT_CACHE_EPSILON;
    this.canary_timeout = init.canary_timeout ?? null;
    this.canary_options = init.canary_options ?? null;
    this.multipath_enabled = init.multipath_enabled ?? false;
    this.stats_total = { ...(init.stats_total ?? {}) };
    this.skill_provider = init.skill_provider ?? null;
    this.last_request_fingerprint = '';
  }

  /** 构造只读组装器（同源配置；单次绑定复用）。 */
  bind(): PathAssembler {
    const options: PathAssemblerOptions = {
      registry: this.registry,
      evidence_store: this.evidence_store,
      retriever: this.retriever,
      config: this.config,
      sink: this.sink ?? undefined,
      now: this.now,
      cache: this.cache,
      model_id: this.model_id,
      cache_epsilon: this.cache_epsilon,
      skill_provider: this.skill_provider,
    };
    return new PathAssembler(options);
  }

  /** 组装请求的缓存主键（请求侧纯函数；与组装查找/回馈同口径）。 */
  _request_cache_key(request: AssemblyRequest): string {
    return request_fingerprint({
      goal_fields: request.goal_fields(),
      entry_fields: request.entry_fields,
      domain: request.domain,
      max_safety_tier: request.max_safety_tier,
      model_id: this.model_id,
    });
  }

  /** 缓存路径执行结果回馈（执行失败强失效信号接线口）。未注入缓存时零参与。 */
  async report_cache_execution(request: AssemblyRequest, opts: { ok: boolean }): Promise<boolean> {
    if (this.cache === null) return false;
    const key = this._request_cache_key(request);
    return await this.cache.report(key, { ok: opts.ok });
  }

  /** 组装指令：组装 + canary 验证链路 + 审计留痕。
   *
   * 产物（AssemblyResult.to_dict）= 候选图定义数据 + 统计 + canary 结论 +
   * 审计记录；缓存命中候选须过 canary 验证（失败 = 强失效 + 立即重组装）；
   * 命中且全部验证通过时直接复用首批 verdict（ENG9a-7：验证成本不翻倍）。
   * 机制开关关闭（config.enabled=False）时零生效；envelope 全程透传（ENG9a-3）。 */
  async assemble_plan(
    request: AssemblyRequest,
    opts: { envelope?: AssemblyEnvelope | null; audit_sink?: AuditSink } = {},
  ): Promise<PathAssemblyResult> {
    if (this.config !== null && !this.config.enabled) return new PathAssemblyResult();
    const assembler = this.bind();
    this.last_request_fingerprint = this._request_cache_key(request);
    const result = await assembler.assemble(request, opts.envelope ?? null);
    const ts = this.now ?? 0;
    let hit_verdicts: CanaryVerdict[] | null = null;
    if (this.cache !== null && (result.stats[STATS_CACHE_HITS] ?? 0) > 0) {
      // 命中候选先行验证：失败 = 强失效 + 立即重组装
      hit_verdicts = [];
      for (const candidate of result.candidates) {
        hit_verdicts.push(await this._verify_candidate(candidate, { ts }));
      }
      if (hit_verdicts.some((verdict) => !verdict.ok)) {
        await this.report_cache_execution(request, { ok: false });
        const reassembled = await assembler.assemble(request, opts.envelope ?? null);
        hit_verdicts = null;
        return this._finish(request, reassembled, ts, opts.audit_sink ?? null, hit_verdicts);
      }
    }
    return this._finish(request, result, ts, opts.audit_sink ?? null, hit_verdicts);
  }

  /** 组装收尾：审计记录组装 + 候选 canary 结论 + 留痕/统计累计。 */
  private async _finish(
    request: AssemblyRequest,
    result: PathAssemblyResult,
    ts: number,
    audit_sink: AuditSink,
    hit_verdicts: readonly CanaryVerdict[] | null,
  ): Promise<PathAssemblyResult> {
    const goal = request.goal_fields();
    const records: Record<string, unknown>[] = [
      assembly_audit_record(request, goal, result, { ts }),
    ];
    if (result.candidates.length === 0) {
      const empty = new PathAssemblyResult({ ...result, audit: records });
      this._emit_audit(records, audit_sink);
      this._accumulate_stats(empty);
      return empty;
    }
    const verdicts: CanaryVerdict[] = [];
    for (let index = 0; index < result.candidates.length; index++) {
      const candidate = result.candidates[index]!;
      let verdict: CanaryVerdict;
      if (
        hit_verdicts !== null &&
        index < hit_verdicts.length &&
        candidate.source === CANDIDATE_SOURCE_CACHE
      ) {
        verdict = hit_verdicts[index]!;
      } else {
        verdict = await this._verify_candidate(candidate, { ts });
      }
      verdicts.push(verdict);
      records.push({
        ts,
        domain: request.domain,
        fingerprint: verdict.digest,
        verdict: verdict.to_dict(),
      });
    }
    const finished = new PathAssemblyResult({
      ...result,
      canary: verdicts,
      audit: records,
    });
    this._emit_audit(records, audit_sink);
    this._accumulate_stats(finished);
    return finished;
  }

  /** 本次组装统计并入运行期累计（stats 最后一跳的数据源）。 */
  _accumulate_stats(result: PathAssemblyResult): void {
    for (const [key, value] of Object.entries(result.stats)) {
      this.stats_total[key] = (this.stats_total[key] ?? 0) + Math.trunc(Number(value));
    }
  }

  /** 单候选验证：重建（结构校验）→ 可选单回合（stub 执行）。
   *  canary=True 时的单回合执行依赖 executor（未迁移），会抛未迁移错误。 */
  async _verify_candidate(candidate: AssemblyCandidate, opts: { ts: number }): Promise<CanaryVerdict> {
    const graphData = candidate.to_dict()['graph'] as Record<string, unknown>;
    let rebuilt;
    try {
      rebuilt = canary_instantiate(graphData, { registry: this.registry });
    } catch (exc) {
      return new CanaryVerdict({
        rank: candidate.rank,
        digest: candidate.graph.digest(),
        ok: false,
        error: `重建失败: ${String(exc)}`,
      });
    }
    if (!this.canary) {
      return new CanaryVerdict({
        rank: candidate.rank,
        digest: rebuilt.digest(),
        ok: true,
        executed: false,
      });
    }
    try {
      const round_result = await canary_round(rebuilt, {
        options: this.canary_options,
        canary_timeout: this.canary_timeout,
      });
      return new CanaryVerdict({
        rank: candidate.rank,
        digest: rebuilt.digest(),
        ok: round_result.ok,
        executed: true,
        terminal: round_result.reason,
        error: round_result.ok ? null : `异常收尾（${round_result.reason}）`,
      });
    } catch (exc) {
      void opts.ts;
      if (exc instanceof Error && exc.message.includes('未迁移')) throw exc;
      return new CanaryVerdict({
        rank: candidate.rank,
        digest: rebuilt.digest(),
        ok: false,
        executed: true,
        error: `单回合执行失败: ${String(exc)}`,
      });
    }
  }

  /** 审计记录逐条回调（audit_sink None = 静默跳过）。 */
  _emit_audit(records: readonly Record<string, unknown>[], audit_sink: AuditSink): void {
    if (audit_sink === null) return;
    for (const record of records) {
      audit_sink({ ...record });
    }
  }
}
