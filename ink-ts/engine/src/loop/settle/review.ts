/**
 * 策略边对抗复审钩子（PolicyEdgeReviewSettleHook）。
 *
 * 策略边对抗复审（对抗证据 → 自动提请 L2 复审 + 复审前降级）。判据（评审
 * 文档第十三节坑六）：策略边失败累计≥5，或所在域非策略边证据均值反超其
 * 承诺 → 自动提请人工复审（L2 审批）并把该边降级为普通统计边。零 LLM：
 * 复审请求经审计事件（policy_edge_review_audit）留痕，审批裁决归宿主通道。
 *
 * 增量 + 限频（ENG1-9）：旧实现每 run 全量 list_edges + O(N) 遍历。现改为
 * 只评估本 run 触达的策略边（增量面）；域证据均值（非策略边全量扫描）带
 * 缓存，每 scan_interval 次触发评估重算一次（限频面）。
 *
 * （池治理钩子 PoolGovernanceSettleHook 已随 pool_governance 机制退役。）
 */

import { EdgeEvidenceStore } from '../../core/edge_evidence/store.js';
import { ORIGIN_RUNTIME } from '../../core/edge_evidence/_types.js';
import type { EdgeEvidence } from '../../core/edge_evidence/_types.js';
import { EVENT_AUDIT_POLICY_REVIEW } from '../../model/event_types/eventTypeSpecs.js';
import { laplace_success } from '../../core/edge_evidence/tier_model.js';
import { now } from './_time.js';
import { POLICY_REVIEW_DOMAIN_MIN_EDGES, TRACE_FAILED } from '../../model/settle/_constants.js';
import { derive_traversals } from './attribution.js';
import { policy_edge_needs_review } from './rules.js';
import { SettleContext, edge_key_str, traversal_edge_key } from '../../model/settle/types.js';

// ── 策略边对抗复审钩子（ENG1-9 增量 + 限频）──────────────────────────────────

/** 复审登记回调（记录形态 = 审计事件 dict）。 */
export type ReviewSink = (record: Record<string, unknown>) => unknown;

/**
 * 策略边对抗复审钩子（对抗证据 → 自动提请 L2 复审 + 复审前降级）。
 * 复审请求经审计事件（policy_edge_review_audit）留痕，审批裁决归宿主通道。
 * 降级去重：边证据 put(policy=false) 本身持久（重启后不再触达），去重集合
 * 另随 state 持久化 seam 恢复/写回（跨重启签名不丢）。
 */
export class PolicyEdgeReviewSettleHook {
  readonly #store: EdgeEvidenceStore;
  readonly #sink: ReviewSink | null;
  readonly #scanInterval: number;
  readonly #onDowngraded: ((key: string) => unknown) | null;
  readonly reviews: Record<string, unknown>[] = [];
  /** 已降级边去重键（降级后不再重复提请；边主键字符串编码）。 */
  readonly _downgraded = new Set<string>();
  /** 域证据均值限频缓存（domain → 均值；重算间隔 = scan_interval）。 */
  readonly _domain_average_cache: Record<string, number> = {};
  /** 距上次域均值重算的 run 数（domain → 计数）。 */
  readonly _runs_since_refresh: Record<string, number> = {};

  constructor(
    store: EdgeEvidenceStore,
    opts: {
      sink?: ReviewSink | null;
      scan_interval?: number;
      /** 持久化降级签名集合（装配期从持久 records 恢复；重启不重复提请）。 */
      persisted_downgraded?: ReadonlySet<string> | null;
      /** 新降级签名回调（宿主/装配面幂等持久化去重键）。 */
      on_downgraded?: ((key: string) => unknown) | null;
    } = {},
  ) {
    this.#store = store;
    this.#sink = opts.sink ?? null;
    this.#scanInterval = Math.max(1, opts.scan_interval ?? 10);
    this.#onDowngraded = opts.on_downgraded ?? null;
    for (const key of opts.persisted_downgraded ?? []) this._downgraded.add(key);
  }

  /** 本 run 触达的策略边（增量评估面，按边主键去重）。 */
  async _touched_policy_edges(ctx: SettleContext): Promise<EdgeEvidence[]> {
    const seen = new Set<string>();
    const touched: EdgeEvidence[] = [];
    for (const tr of derive_traversals(ctx)) {
      const key = traversal_edge_key(tr, ctx.domain);
      const keyStr = edge_key_str(key);
      if (seen.has(keyStr)) {
        continue;
      }
      seen.add(keyStr);
      const edge = await this.#store.get(key);
      if (edge !== null && edge.policy) {
        touched.push(edge);
      }
    }
    return touched;
  }

  /** 域证据均值（限频缓存：每 scan_interval 次评估重算一次）。 */
  async _domain_average(domain: string): Promise<number | null> {
    const runs = this._runs_since_refresh[domain] ?? 0;
    const cached = this._domain_average_cache[domain];
    if (cached !== undefined && runs < this.#scanInterval) {
      this._runs_since_refresh[domain] = runs + 1;
      return cached;
    }
    const all = await this.#store.list_edges(domain);
    const nonPolicy = all.filter((e) => !e.policy);
    this._runs_since_refresh[domain] = 1;
    if (nonPolicy.length < POLICY_REVIEW_DOMAIN_MIN_EDGES) {
      delete this._domain_average_cache[domain];
      return null;
    }
    const avg =
      nonPolicy.reduce((acc, e) => acc + laplace_success(e.success_count, e.fail_count), 0) /
      nonPolicy.length;
    this._domain_average_cache[domain] = avg;
    return avg;
  }

  async settle(ctx: SettleContext): Promise<void> {
    const touched = await this._touched_policy_edges(ctx);
    if (touched.length === 0) {
      return; // 增量：本 run 未触达策略边 = 无复审需求，零全量扫描
    }
    const domainAverageP = await this._domain_average(ctx.domain);
    for (const edge of touched) {
      const [needs, reason] = policy_edge_needs_review(edge, {
        domain_average_p: domainAverageP,
      });
      if (!needs) {
        continue;
      }
      const keyStr = edge_key_str(edge.key);
      if (this._downgraded.has(keyStr)) {
        continue;
      }
      // 复审前降级为普通统计边（policy=False：不再 τ=1.0/豁免衰减）
      await this.#store.put({
        key: edge.key,
        success_count: edge.success_count,
        fail_count: edge.fail_count,
        avg_cost: edge.avg_cost,
        policy: false,
        origin: ORIGIN_RUNTIME,
        last_used_at: edge.last_used_at,
        created_at: edge.created_at,
      });
      // 降级已持久化后去重（边证据 policy=false 跨重启不再触达）
      this._downgraded.add(keyStr);
      if (this.#onDowngraded !== null) {
        try {
          this.#onDowngraded(keyStr);
        } catch {
          // Python 侧 logger.warning 留痕（忽略）；TS core 零日志 = 静默
        }
      }
      const record: Record<string, unknown> = {
        type: EVENT_AUDIT_POLICY_REVIEW,
        ts: now(),
        domain: ctx.domain,
        src_type: edge.key.src_type,
        dst_type: edge.key.dst_type,
        reason,
        action: 'downgraded_to_statistical',
        review_tier: 'l2',
        trace_id: ctx.trace_id,
      };
      this.reviews.push(record);
      if (this.#sink !== null) {
        this.#sink(record);
      }
    }
  }
}
