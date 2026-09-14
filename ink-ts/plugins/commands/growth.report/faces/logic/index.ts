/**
 * growth.report 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/growth.ts 迁入，
 * 语义零改）。自学习管线/调参状态只读报告（能读则读，无则返回 enabled + nulls）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

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
    const pipeline = deps.runtime.growth_pipeline;
    const knowledgeSet = deps.runtime.knowledge_set;
    const empty: GrowthReportView = {
      enabled: false,
      config_summary: null,
      weights_snapshot: null,
      last_tuned_at: null,
    };
    if (pipeline === null) return empty;
    let weightsSnapshot: Record<string, unknown> | null = null;
    let lastTunedAt: number | null = null;
    if (knowledgeSet !== null) {
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
    }
    return {
      enabled: pipeline.config.enabled,
      config_summary: {
        enabled: pipeline.config.enabled,
        reuse_first: pipeline.config.reuse_first,
        ...pipeline.snapshot(),
      },
      weights_snapshot: weightsSnapshot,
      last_tuned_at: lastTunedAt,
    };
  };

  return report;
}
