/**
 * growth.report 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/growth.ts 迁入）。
 * S6 改活线口径：GrowthPipeline（legacy growth 机制）已随无宿主消费遗留件删除，
 * 本命令报告受控进化活线的调参/自学习状态（MetaTuner + knowledge_set weight 条目）——
 * 命令 id 与只读报告语义不变（能读则读，无则返回 enabled + nulls）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { MetaTuner } from '@ink-ts/engine';

/** growth.report 结果（无装配 = enabled:false + 字段 null）。 */
export interface GrowthReportView {
  enabled: boolean;
  config_summary: Record<string, unknown> | null;
  weights_snapshot?: Record<string, unknown> | null;
  last_tuned_at?: number | null;
}

/** knowledge_set kind=weight 的字面量（引擎 KIND_WEIGHT 同值；勿引引擎内部名）。 */
const KIND_WEIGHT = 'weight';

export default function createGrowthReport(deps: HostBridgeDeps): BridgeHandler {
  /** growth.report：能读则读；无装配 = enabled + nulls（读面 fail-open）。 */
  const report: BridgeHandler = (): GrowthReportView => {
    const runtime = deps.runtime;
    const tuner = runtime.meta_tuner;
    const knowledgeSet = runtime.knowledge_set;
    const empty: GrowthReportView = {
      enabled: false,
      config_summary: null,
      weights_snapshot: null,
      last_tuned_at: null,
    };
    if (tuner === null || knowledgeSet === null) return empty;
    let weightsSnapshot: Record<string, unknown> | null = null;
    let lastTunedAt: number | null = null;
    try {
      const entries = knowledgeSet.entries(null, { include_archived: true });
      const weightEntry = entries.find((entry) => entry.kind === KIND_WEIGHT);
      if (weightEntry !== undefined) {
        weightsSnapshot =
          typeof weightEntry.data === 'object' && weightEntry.data !== null
            ? (weightEntry.data as Record<string, unknown>)
            : null;
        lastTunedAt = weightEntry.updated_at;
      }
    } catch {
      weightsSnapshot = null;
      lastTunedAt = null;
    }
    return {
      enabled: true,
      config_summary: {
        enabled: true,
        params: MetaTuner.load_params(knowledgeSet).to_dict(),
      },
      weights_snapshot: weightsSnapshot,
      last_tuned_at: lastTunedAt,
    };
  };

  return report;
}
