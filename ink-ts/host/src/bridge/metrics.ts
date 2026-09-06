/**
 * metrics 命令面（snapshot）——回合指标会话窗口只读投影。
 *
 * 数据源 = runtime.turn_metrics（引擎 TurnMetrics 聚合：回合收尾
 * record_turn 计数；rounds/failures/failure_rate 同源 snapshot）。
 * host 只把引擎指标窗口投影为回合数/失败数/失败率（avg）+ 角色槽
 * 调用分布。无装配 = 结构化空态（available:false + 全零，不报错）。
 */

import { type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** metrics.snapshot 结果（失败率 = avg；无回合 = 0 不除零）。 */
export interface MetricsSnapshotView {
  available: boolean;
  rounds: number;
  failures: number;
  avg: number;
  last_error: string | null;
  llm_calls_by_role: Record<string, number>;
  /** 技能结晶计数（runtime.skill_crystallizer 装配态聚合；无 = 0）。 */
  crystallized: number;
}

export function buildMetricsHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  /** metrics.snapshot：回合指标会话窗口（无装配 = 空态）。 */
  const snapshot: BridgeHandler = (): MetricsSnapshotView => {
    const crystallized = deps.runtime.skill_crystallizer?.crystallized.length ?? 0;
    const turnMetrics = deps.runtime.turn_metrics;
    if (turnMetrics === null) {
      return {
        available: false,
        rounds: 0,
        failures: 0,
        avg: 0,
        last_error: null,
        llm_calls_by_role: {},
        crystallized,
      };
    }
    const data = turnMetrics.snapshot() as Record<string, unknown>;
    const rounds = typeof data['turns'] === 'number' ? data['turns'] : 0;
    const failures = typeof data['failures'] === 'number' ? data['failures'] : 0;
    const rate = typeof data['failure_rate'] === 'number' ? data['failure_rate'] : 0;
    const calls = data['llm_calls_by_role'];
    const lastError = data['last_error'];
    return {
      available: true,
      rounds,
      failures,
      avg: rate,
      last_error: typeof lastError === 'string' && lastError !== '' ? lastError : null,
      llm_calls_by_role: typeof calls === 'object' && calls !== null
        ? { ...(calls as Record<string, number>) }
        : {},
      crystallized,
    };
  };

  return new Map<string, BridgeHandler>([['metrics.snapshot', snapshot]]);
}
