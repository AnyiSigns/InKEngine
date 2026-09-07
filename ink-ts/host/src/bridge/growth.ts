/**
 * growth 命令面（report）——自学习管线/调参状态只读报告。
 *
 * 数据源 = runtime 装配产物（能读则读，无则返回 enabled + nulls，不报错）：
 * growth_pipeline（GrowthPipeline：config.enabled/reuse_first + 诊断快照）
 * 与 knowledge_set（可调参数持久化为知识集 kind=weight 条目——权重条目
 * data = TunableParams.to_dict 形态；最近回写时刻 = 该条目 updated_at）。
 */

import type { GrowthCommand } from './commands.generated.js';
export { GROWTH_COMMANDS, type GrowthCommand } from './commands.generated.js';
import type { HostBridgeDeps } from './_types.js';
import type { BridgeHandler } from './_types.js';

/** growth.report 结果（无装配 = enabled:false + 字段 null）。 */
export interface GrowthReportView {
  enabled: boolean;
  config_summary: Record<string, unknown> | null;
  weights_snapshot?: Record<string, unknown> | null;
  last_tuned_at?: number | null;
}

/** knowledge_set kind=weight 的字面量（引擎 KIND_WEIGHT 同值；勿引引擎内部名）。 */
const KIND_WEIGHT = 'weight';


/** growth.report：能读则读；无装配 = enabled + nulls（读面 fail-open）。 */
export function buildGrowthCommands(deps: HostBridgeDeps): Readonly<Record<GrowthCommand, BridgeHandler>> {
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

  return { 'growth.report': report };
}
