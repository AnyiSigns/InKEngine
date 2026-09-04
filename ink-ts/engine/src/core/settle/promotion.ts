/**
 * 推荐先验自动晋升钩子（高强度证据路径 → 晋升登记 + 审计留痕）。
 *
 * 对标 ink_engine.core.settle 的 RecommendedPriorSettleHook：
 * 判据（与信任档推导同一组常数）：路径全通（成功归因）+ 每条遍历边 N≥30
 * 且成功率≥0.9 + 注入的 QualityGate 通过 + canary 通过——自动晋升为
 * 「推荐先验」（workflow 同等的组装先验待遇），晋升不需人工拍板；登记 =
 * 推荐先验记录（随审计 append-only），供组装先验消费。缺闸门注入 =
 * fail-closed 不晋升（高质量归纳前提不满足）；零 LLM。
 *
 * 持久化语义（ENG1-18）：进程内存集重启即丢——旧实现重启后同一路径会重复
 * 登记晋升（审计重复）。现支持 persisted_signatures（装配期从持久化去重键
 * 恢复）与 on_promoted（每次新晋升签名回调，宿主幂等 upsert 去重键）。TS
 * 无 tuple 哈希：路径签名 = 排序后的六元边键数组（记录形态 list(signature)），
 * 去重键 = 签名的 JSON 序列化（promotion_signature_key，宿主可复现）。
 */

import { EdgeEvidenceStore } from '../edge_evidence/store.js';
import { edge_evidence_to_dict, edge_key_to_dict } from '../edge_evidence/store.js';
import { edge_key_tuple } from '../edge_evidence/storage_seam.js';
import type { EdgeKey } from '../edge_evidence/_types.js';
import { EVENT_AUDIT_PROMOTION } from '../event_types/eventTypeSpecs.js';
import { now } from './_time.js';
import { UPDATE_SUCCESS } from './_constants.js';
import { derive_traversals, run_verdict } from './attribution.js';
import { recommended_prior_eligible } from './rules.js';
import { SettleContext, edge_key_str, traversal_edge_key } from './types.js';
import type { QualityGate } from './fingerprint.js';

/** 闸门/canary 的可选形态（结构性协议：evaluate(ctx) -> bool）。 */
export type PromotionGate = { evaluate(ctx: SettleContext): Promise<boolean> | boolean } | null;

/** 已晋升路径签名：排序后的边键六元组清单（对齐 Python tuple of key()）。 */
export type PromotionSignature = readonly string[][];

/** 签名 → 去重键（JSON 序列化；持久化恢复与宿主幂等 upsert 的稳定编码）。 */
export function promotion_signature_key(signature: PromotionSignature): string {
  return JSON.stringify(signature);
}

/** 晋升登记回调 / 去重键持久化回调。 */
export type PromotionSink = (record: Record<string, unknown>) => unknown;
export type OnPromoted = (signature: PromotionSignature) => unknown;

/**
 * 推荐先验自动晋升钩子：高强度证据路径 → 晋升登记 + 审计留痕。
 */
export class RecommendedPriorSettleHook {
  readonly #store: EdgeEvidenceStore;
  readonly #gate: QualityGate | null;
  readonly #canaryOk: ((ctx: SettleContext) => boolean) | null;
  readonly #sink: PromotionSink | null;
  readonly #modelId: string;
  readonly #onPromoted: OnPromoted | null;
  readonly promotions: Record<string, unknown>[] = [];
  /** 已晋升路径去重键（JSON 签名；随 persisted_signatures 恢复）。 */
  readonly #promoted: Set<string>;

  constructor(
    store: EdgeEvidenceStore,
    gate: QualityGate | null = null,
    opts: {
      canary_ok?: ((ctx: SettleContext) => boolean) | null;
      sink?: PromotionSink | null;
      model_id?: string;
      persisted_signatures?: ReadonlySet<string> | null;
      on_promoted?: OnPromoted | null;
    } = {},
  ) {
    this.#store = store;
    this.#gate = gate;
    this.#canaryOk = opts.canary_ok ?? null;
    this.#sink = opts.sink ?? null;
    this.#modelId = opts.model_id ?? '';
    this.#onPromoted = opts.on_promoted ?? null;
    this.#promoted = new Set<string>(opts.persisted_signatures ?? []);
  }

  async settle(ctx: SettleContext): Promise<void> {
    if (this.#gate === null) {
      return; // 无闸门 = fail-closed 不晋升
    }
    if (run_verdict(ctx) !== UPDATE_SUCCESS) {
      return;
    }
    const traversals = derive_traversals(ctx);
    if (traversals.length === 0) {
      return;
    }
    // 去重保序的边键清单（沿 Python dict.fromkeys 语义）
    const keys: EdgeKey[] = [];
    const seen = new Set<string>();
    for (const tr of traversals) {
      const key = traversal_edge_key(tr, ctx.domain);
      const sig = edge_key_str(key);
      if (seen.has(sig)) continue;
      seen.add(sig);
      keys.push(key);
    }
    const rows = [];
    for (const key of keys) {
      rows.push(await this.#store.get(key));
    }
    if (
      rows.some(
        (row) =>
          row === null || !recommended_prior_eligible(row.success_count, row.fail_count),
      )
    ) {
      return;
    }
    if (this.#canaryOk !== null && !this.#canaryOk(ctx)) {
      return;
    }
    const gatePassed = Boolean(await this.#gate.evaluate(ctx));
    if (!gatePassed) {
      return;
    }
    const signature: string[][] = keys
      .map((k) => [...edge_key_tuple(k)])
      .sort((a, b) => a.join('::').localeCompare(b.join('::')));
    const signatureKey = promotion_signature_key(signature);
    if (this.#promoted.has(signatureKey)) {
      return;
    }
    this.#promoted.add(signatureKey);
    if (this.#onPromoted !== null) {
      try {
        this.#onPromoted(signature);
      } catch {
        // Python 侧 logger.warning 留痕（忽略）；TS core 零日志 = 静默
      }
    }
    const record: Record<string, unknown> = {
      type: EVENT_AUDIT_PROMOTION,
      ts: now(),
      domain: ctx.domain,
      edges: keys.map((k) => edge_key_to_dict(k)),
      evidence: rows.map((row) => edge_evidence_to_dict(row!)),
      gate_passed: gatePassed,
      model_id: this.#modelId,
      trace_id: ctx.trace_id,
      // 去重键（宿主幂等 upsert 依据：重启后经 persisted_signatures 恢复，
      // 杜绝重复晋升登记——ENG1-18）
      signature: signature.map((tuple) => [...tuple]),
    };
    this.promotions.push(record);
    if (this.#sink !== null) {
      this.#sink(record);
    }
  }
}
