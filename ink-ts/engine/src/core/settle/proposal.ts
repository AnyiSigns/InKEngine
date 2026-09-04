/**
 * 失败点 → 新结点提案钩子（契约草案，非代码；评审走宿主 vetting）。
 *
 * 对标 ink_engine.core.settle 的 NodeProposalSettleHook：
 * 判据（同一失败点累计 N≥3 次或入边失败率>0.4）读边证据的历史统计；
 * 提案 = 登记记录（内存清单 + 可选回调），不执行任何决策。失败分类分流：
 * 仅能力缺口类（model / unknown）才提案，环境/配置类（permission/
 * validation/network）不污染评审队列。
 */

import { EdgeEvidenceStore } from '../edge_evidence/store.js';
import { now } from './_time.js';
import { CAPABILITY_GAP_CATEGORIES, TRACE_FAILED } from './_constants.js';
import { derive_traversals } from './attribution.js';
import { classify_failure, draft_node_contract, should_propose } from './rules.js';
import { SettleContext, traversal_edge_key } from './types.js';

/** 提案登记回调（记录形态 = 契约草案 + 归因上下文）。 */
export type ProposalSink = (record: Record<string, unknown>) => unknown;

/** 失败点提案钩子（只登记不决策；评审走宿主 vetting 通道）。 */
export class NodeProposalSettleHook {
  readonly #store: EdgeEvidenceStore;
  readonly #sink: ProposalSink | null;
  readonly proposals: Record<string, unknown>[] = [];

  constructor(store: EdgeEvidenceStore, opts: { proposal_sink?: ProposalSink | null } = {}) {
    this.#store = store;
    this.#sink = opts.proposal_sink ?? null;
  }

  async settle(ctx: SettleContext): Promise<void> {
    const category = classify_failure(ctx.result.error);
    // 失败分类分流：仅能力缺口类（model / unknown）才提案，环境/配置类
    // （permission/validation/network）不污染评审队列
    if (!CAPABILITY_GAP_CATEGORIES.has(category)) {
      return;
    }
    for (const tr of derive_traversals(ctx)) {
      if (tr.dst.status !== TRACE_FAILED) {
        continue;
      }
      const key = traversal_edge_key(tr, ctx.domain);
      const evidence = await this.#store.get(key);
      const fail = evidence !== null ? evidence.fail_count : 1;
      const success = evidence !== null ? evidence.success_count : 0;
      if (!should_propose(fail, success)) {
        continue;
      }
      const draft = draft_node_contract(tr.dst_type, {
        note:
          `失败点提案：入边 ${tr.src_type}→${tr.dst_type} ` +
          `失败 ${fail} 次 / 成功 ${success} 次（域 ${ctx.domain}）`,
      });
      const record: Record<string, unknown> = {
        ...draft,
        src_type: tr.src_type,
        domain: ctx.domain,
        failure_category: category,
        trace_id: ctx.trace_id,
        ts: now(),
      };
      this.proposals.push(record);
      if (this.#sink !== null) {
        this.#sink(record);
      }
    }
  }
}
