/**
 * metrics.snapshot 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/metrics.ts
 * 迁入，语义零改）。回合指标会话窗口只读投影（失败率 = avg；无回合 = 0 不除零）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

/** metrics.snapshot 结果（失败率 = avg；无回合 = 0 不除零）。 */
export interface MetricsSnapshotView {
  available: boolean;
  rounds: number;
  /** 自动续跑轮计数（引擎回合指标 auto_turns 投影：round_id 前缀 `auto:`）。 */
  auto_rounds: number;
  failures: number;
  avg: number;
  last_error: string | null;
  llm_calls_by_role: Record<string, number>;
  /** 技能结晶计数（runtime.skill_crystallizer 装配态聚合；无 = 0）。 */
  crystallized: number;
}

export default function createMetricsSnapshot(deps: HostBridgeDeps): BridgeHandler {
  /** metrics.snapshot：回合指标会话窗口（无装配 = 空态）。 */
  const snapshot: BridgeHandler = (): MetricsSnapshotView => {
    const crystallized = deps.runtime.skill_crystallizer?.crystallized.length ?? 0;
    const turnMetrics = deps.runtime.turn_metrics;
    if (turnMetrics === null) {
      return {
        available: false,
        rounds: 0,
        auto_rounds: 0,
        failures: 0,
        avg: 0,
        last_error: null,
        llm_calls_by_role: {},
        crystallized,
      };
    }
    const data = turnMetrics.snapshot() as Record<string, unknown>;
    const rounds = typeof data['turns'] === 'number' ? data['turns'] : 0;
    const autoRounds = typeof data['auto_turns'] === 'number' ? data['auto_turns'] : 0;
    const failures = typeof data['failures'] === 'number' ? data['failures'] : 0;
    const rate = typeof data['failure_rate'] === 'number' ? data['failure_rate'] : 0;
    const calls = data['llm_calls_by_role'];
    const lastError = data['last_error'];
    return {
      available: true,
      rounds,
      auto_rounds: autoRounds,
      failures,
      avg: rate,
      last_error: typeof lastError === 'string' && lastError !== '' ? lastError : null,
      llm_calls_by_role: typeof calls === 'object' && calls !== null
        ? { ...(calls as Record<string, number>) }
        : {},
      crystallized,
    };
  };

  return snapshot;
}
