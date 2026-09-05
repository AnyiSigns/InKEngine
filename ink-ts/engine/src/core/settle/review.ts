// gate: 超限(352 行) - 策略边复审 + 池治理 settle 钩子同文件（同一 settle 域协议面，拆文件破坏评审/治理钩子索引面）
/**
 * 池治理登记钩子与策略边对抗复审钩子。
 *
 * 对标 ink_engine.core.settle 的 PoolGovernanceSettleHook /
 * PolicyEdgeReviewSettleHook：
 * - PoolGovernanceSettleHook：把 PoolGovernance 挂入 settle 钩子链（只登记
 *   不执行）。钩子本身不在 settle 路径做治理判定——治理判定由桥 op 触发
 *   （pool.snapshot 读快照、pool.evaluate 判定提案）；本钩子只把登记器注册
 *   进钩子链，使运行时持有可观测的治理状态（settle 占位 no-op）；
 * - PolicyEdgeReviewSettleHook：策略边对抗复审（对抗证据 → 自动提请 L2
 *   复审 + 复审前降级）。判据（评审文档第十三节坑六）：策略边失败累计≥5，
 *   或所在域非策略边证据均值反超其承诺 → 自动提请人工复审（L2 审批）并把
 *   该边降级为普通统计边。零 LLM：复审请求经审计事件
 *   （policy_edge_review_audit）留痕，审批裁决归宿主通道。
 *
 * 增量 + 限频（ENG1-9）：旧实现每 run 全量 list_edges + O(N) 遍历。现改为
 * 只评估本 run 触达的策略边（增量面）；域证据均值（非策略边全量扫描）带
 * 缓存，每 scan_interval 次触发评估重算一次（限频面）。
 */

import { EdgeEvidenceStore } from '../edge_evidence/store.js';
import { ORIGIN_RUNTIME } from '../edge_evidence/_types.js';
import type { EdgeEvidence } from '../edge_evidence/_types.js';
import { EVENT_AUDIT_POLICY_REVIEW } from '../event_types/eventTypeSpecs.js';
import { laplace_success } from '../edge_evidence/tier_model.js';
import { now } from './_time.js';
import { POLICY_REVIEW_DOMAIN_MIN_EDGES, TRACE_FAILED } from './_constants.js';
import { derive_traversals } from './attribution.js';
import { policy_edge_needs_review } from './rules.js';
import { SettleContext, edge_key_str, traversal_edge_key } from './types.js';
import { GOV_VERDICT_MERGE, PoolGovernance, PoolNodeSnapshot, weekly_proposal_usage } from '../pool_governance/pool_governance.js';
import type { PoolNodeSnapshotInit } from '../pool_governance/pool_governance_types.js';

// ── 池治理每回合自动跑（引擎自接线；settle 钩子真实现）───────────────────────

/** 单回合可应用的合并次数上限（收敛护栏：一次回合最多落地一次合并裁决，
 *  防证据多径下同回合批量近重复时合并动作失控/震荡）。 */
export const POOL_GOVERNANCE_MERGE_CAP_PER_ROUND = 1;

/** 池治理审计记录 type（set_audit 集合；与干预审计同集合 append-only）。 */
export const POOL_GOVERNANCE_AUDIT_TYPE = 'pool_governance_audit';

/** 池治理 settle 钩子的可注入面（store 缺失 = fail-closed 跳过并记原因）。 */
export interface PoolGovernanceSettleOptions {
  /** 引擎边证据存储（缺省 null = 无法判定，skip 留痕）。 */
  store?: EdgeEvidenceStore | null;
  /** 时钟（epoch 秒）；缺省 = settle/_time.now（可 set_now 冻结）。 */
  now?: (() => number) | null;
  /** 审计留痕回调（每条治理判定/失效登记记录调一次）。 */
  audit_sink?: ReviewSink | null;
  /** 候选结点类型产出字段解析（合并判定的字段面；缺省空 = 无法近重复）。 */
  node_fields?: ((node_type: string) => readonly string[]) | null;
  /** 单回合合并应用次数上限（缺省 = POOL_GOVERNANCE_MERGE_CAP_PER_ROUND）。 */
  merge_cap?: number;
}

/**
 * 池治理 settle 钩子（真实现；引擎每回合自动跑，默认 ON）。
 *
 * 每回合对引擎的边证据存储跑 PoolGovernance.evaluate：从本回合失败边的
 * dst 结点类型提炼池候选，按四规则（容量/死结点淘汰/近重复合并/提案预算）
 * 产出治理判定并应用**安全收敛**：
 * - allow（含 eviction_candidates）→ 死结点候选登记失效（invalidation
 *   审计，标记失效不物理删），预算扣减经治理日志计数；
 * - merge（字段近重复命中池内既有结点）→ 落 resolved 去重（后续回合同
 *   候选不再重复提请，跨回合稳定不震荡），单回合合并应用次数受
 *   merge_cap 上限护栏；
 * - reject（预算耗尽/容量满等）→ 只留痕，治理日志按周窗口扣预算。
 *
 * fail-closed 且确定性：store 缺失/空池/无候选 = 跳过并留 skip 原因
 * （不做「空数据全放行」的 fail-open 评估）；判定纯函数（pool_governance
 * 规则自带确定性 tie-break），本钩子不引入随机。
 *
 * 全部判定/失效/合并记录留审计（audit_sink；未注入 = 钩子内存 audits
 * 清单可读）。池内结点快照由边证据存储派生（dst 类型 = 池成员、usage =
 * 成功数、age = 距 last_used 天数）——无证据行 = 空池。
 */
export class PoolGovernanceSettleHook {
  readonly #governance: PoolGovernance;
  readonly #store: EdgeEvidenceStore | null;
  readonly #now: () => number;
  readonly #sink: ReviewSink | null;
  readonly #nodeFields: ((node_type: string) => readonly string[]) | null;
  readonly #mergeCap: number;
  /** 判定审计记录（append-only；audit_sink 的镜像源）。 */
  readonly audits: Record<string, unknown>[] = [];
  /** 跳过原因（append-only；空池/无候选/store 缺失可观测）。 */
  readonly skips: string[] = [];
  /** 已合并去重的候选键（domain\u001fnode_type：后续回合不再重复提请）。 */
  readonly _merge_resolved = new Set<string>();
  /** 已登记失效的池成员键（node_type：不重复失效登记）。 */
  readonly _invalidated = new Set<string>();

  constructor(governance: PoolGovernance, options: PoolGovernanceSettleOptions = {}) {
    this.#governance = governance;
    this.#store = options.store ?? null;
    this.#now = options.now ?? now;
    this.#sink = options.audit_sink ?? null;
    this.#nodeFields = options.node_fields ?? null;
    this.#mergeCap = Math.max(1, options.merge_cap ?? POOL_GOVERNANCE_MERGE_CAP_PER_ROUND);
  }

  get governance(): PoolGovernance {
    return this.#governance;
  }

  /** 池内结点快照（由边证据存储派生；无 store/无行 = 空池）。 */
  async _pool_snapshot(domain: string): Promise<PoolNodeSnapshot[]> {
    const store = this.#store;
    if (store === null) return [];
    const rows = await store.list_edges(domain);
    const byType = new Map<string, EdgeEvidence>();
    for (const row of rows) {
      if (row.key.dst_type === '') continue;
      const current = byType.get(row.key.dst_type);
      if (
        current === undefined
        || row.created_at > current.created_at
        || (row.created_at === current.created_at
          && row.success_count + row.fail_count > current.success_count + current.fail_count)
      ) {
        byType.set(row.key.dst_type, row);
      }
    }
    const nowValue = this.#now();
    const nodes: PoolNodeSnapshotInit[] = [];
    for (const [node_id, ev] of byType) {
      const lastUsed = ev.last_used_at ?? ev.created_at;
      nodes.push({
        node_id,
        usage_count: ev.success_count,
        promoted: false,
        age_days: lastUsed > 0 ? Math.max(0, (nowValue - lastUsed) / 86400) : 0,
        fields: this.#nodeFields !== null ? [...this.#nodeFields(node_id)] : [],
        domain,
      });
    }
    return nodes.map((n) => new PoolNodeSnapshot(n));
  }

  /** 当轮失败边 dst 类型候选（去重；只对失败 dst 提炼——成功轮无候选）。 */
  _round_candidates(ctx: SettleContext): string[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const tr of derive_traversals(ctx)) {
      if (tr.dst.status !== TRACE_FAILED) continue;
      const key = traversal_edge_key(tr, ctx.domain);
      const dst = key.dst_type;
      if (dst === '' || seen.has(dst)) continue;
      seen.add(dst);
      candidates.push(dst);
    }
    return candidates;
  }

  /** 留痕一条判定审计（内存镜像 + audit_sink 转发）。 */
  #record(record: Record<string, unknown>): void {
    this.audits.push(record);
    if (this.#sink !== null) {
      try {
        this.#sink(record);
      } catch {
        // 审计回调失败只跳过（观测不阻断）
      }
    }
  }

  async settle(ctx: SettleContext): Promise<void> {
    const store = this.#store;
    if (store === null) {
      this.skips.push('边证据存储缺失（fail-closed：不做空数据放行判定）');
      return;
    }
    const candidates = this._round_candidates(ctx);
    if (candidates.length === 0) {
      // 空池/无候选：跳过（健康回合不消耗治理预算，也不产噪音判定）
      return;
    }
    const poolNodes = await this._pool_snapshot(ctx.domain);
    const nowValue = this.#now();
    let mergesApplied = 0;
    for (const dst of candidates) {
      const resolveKey = `${ctx.domain}\u001f${dst}`;
      if (this._merge_resolved.has(resolveKey)) {
        continue; // 已合并去重：不重复提请（跨回合稳定）
      }
      const fields = this.#nodeFields !== null ? [...this.#nodeFields(dst)] : [];
      const snapshot = {
        pool_count: poolNodes.length,
        used_this_week: weekly_proposal_usage(this.#governance.log, { now: nowValue }),
        pool_nodes: poolNodes,
      };
      const verdict = this.#governance.evaluate({ node_id: dst, fields }, snapshot);
      const verdictDict = verdict.to_dict();
      const record: Record<string, unknown> = {
        type: POOL_GOVERNANCE_AUDIT_TYPE,
        ts: nowValue,
        domain: ctx.domain,
        round_id: ctx.round_id ?? '',
        thread_id: ctx.thread_id,
        trace_id: ctx.trace_id,
        candidate: dst,
        ...verdictDict,
      };
      if (verdict.verdict === GOV_VERDICT_MERGE) {
        if (mergesApplied >= this.#mergeCap) {
          record['skipped_reason'] = `单回合合并应用超上限（${this.#mergeCap}）`;
          this.#record(record);
          continue;
        }
        mergesApplied += 1;
        this._merge_resolved.add(resolveKey);
      }
      if (verdict.eviction_required) {
        for (const nodeId of verdict.eviction_candidates) {
          if (this._invalidated.has(`${ctx.domain}\u001f${nodeId}`)) continue;
          this._invalidated.add(`${ctx.domain}\u001f${nodeId}`);
          const invalidation: Record<string, unknown> = {
            type: POOL_GOVERNANCE_AUDIT_TYPE,
            action: 'invalidate',
            ts: nowValue,
            domain: ctx.domain,
            node_id: nodeId,
            reason: '死结点淘汰（零调用且超龄，池治理自动登记）',
          };
          this.#record(invalidation);
        }
      }
      this.#record(record);
    }
  }
}

// ── 策略边对抗复审钩子（ENG1-9 增量 + 限频）──────────────────────────────────

/** 复审登记回调（记录形态 = 审计事件 dict）。 */
export type ReviewSink = (record: Record<string, unknown>) => unknown;

/**
 * 策略边对抗复审钩子（对抗证据 → 自动提请 L2 复审 + 复审前降级）。
 * 复审请求经审计事件（policy_edge_review_audit）留痕，审批裁决归宿主通道。
 */
export class PolicyEdgeReviewSettleHook {
  readonly #store: EdgeEvidenceStore;
  readonly #sink: ReviewSink | null;
  readonly #scanInterval: number;
  readonly reviews: Record<string, unknown>[] = [];
  /** 已降级边去重键（降级后不再重复提请；边主键字符串编码）。 */
  readonly _downgraded = new Set<string>();
  /** 域证据均值限频缓存（domain → 均值；重算间隔 = scan_interval）。 */
  readonly _domain_average_cache: Record<string, number> = {};
  /** 距上次域均值重算的 run 数（domain → 计数）。 */
  readonly _runs_since_refresh: Record<string, number> = {};

  constructor(
    store: EdgeEvidenceStore,
    opts: { sink?: ReviewSink | null; scan_interval?: number } = {},
  ) {
    this.#store = store;
    this.#sink = opts.sink ?? null;
    this.#scanInterval = Math.max(1, opts.scan_interval ?? 10);
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
      this._downgraded.add(keyStr);
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
