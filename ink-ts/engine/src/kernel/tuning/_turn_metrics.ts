// 跨域契约模块 - 跨域类型 seam：run_result 回合指标聚合引用
/**
 * 回合指标聚合（tuning.py TurnMetrics dataclass 段移植）。
 *
 * 触发条件与聚合语义：meta 节点回合收尾时调用 record_*，snapshot 汇出
 * 结构化指标（调参输入，随评估记录可落库）。聚合口径：失败率 = 失败/回合
 * （无回合 = 0，不除零）；角色槽调用统计按 RoleModelStats 结构化
 * 快照并入——回落条目（via_fallback）以 `{role}→agent` 键留存（回落可
 * 观测不静默），非正计数为观测噪声（清零/非法输入），不并入。
 */

import { GraphDefinitionError } from '../../model/errors.js';
import type { JsonRecord } from '../../model/json.js';
import { isRecord } from '../../model/json.js';
import { role_call_label, type RoleCallStat } from '../../model/model_roles/index.js';

/** 自动续跑回合的 round_id 前缀（回合协议：自续轮 = `auto:` + 审计键片段；
 *  指标按此前缀给 auto 轮独立记账——生成侧与分类侧同源，防两处漂移）。 */
export const AUTO_ROUND_ID_PREFIX = 'auto:';

/** 按 round_id 判定是否为自动续跑轮（空/非字符串 = 否）。 */
export function is_auto_round_id(round_id: unknown): boolean {
  return typeof round_id === 'string' && round_id.startsWith(AUTO_ROUND_ID_PREFIX);
}

/** TurnMetrics 构造选项（Python dataclass 默认字段的 TS 映射）。 */
export interface TurnMetricsInit {
  turns?: number;
  /** 自动续跑（round_id 前缀 `auto:`）回合数；普通轮与 auto 轮同进 turns。 */
  auto_turns?: number;
  failures?: number;
  llm_calls_by_role?: Readonly<Record<string, number>>;
  last_error?: string;
}

/**
 * 回合指标聚合（引擎自承载：失败率/角色槽调用）。
 */
export class TurnMetrics {
  turns: number;
  /** 自动续跑回合计数（普通轮与 auto 轮同进 turns；本字段 = auto 独立口径）。 */
  auto_turns: number;
  failures: number;
  llm_calls_by_role: Record<string, number>;
  last_error: string;

  constructor(init: TurnMetricsInit = {}) {
    this.turns = init.turns ?? 0;
    this.auto_turns = init.auto_turns ?? 0;
    this.failures = init.failures ?? 0;
    this.llm_calls_by_role = init.llm_calls_by_role
      ? { ...init.llm_calls_by_role }
      : {};
    this.last_error = init.last_error ?? '';
  }

  /** 记录一个回合（失败标记 + 错误摘要——失败率/根因留痕）。round_id 供按
   *  前缀区分自动续跑轮（`auto:` 前缀 = auto 轮，独立计入 auto_turns）。 */
  record_turn(options: { failed?: boolean; error?: string; round_id?: string | null } = {}): void {
    const failed = options.failed ?? false;
    const error = options.error ?? '';
    this.turns += 1;
    if (is_auto_round_id(options.round_id)) {
      this.auto_turns += 1;
    }
    if (failed) {
      this.failures += 1;
      if (error) {
        this.last_error = error;
      }
    }
  }

  /** 并入角色槽调用统计（RoleModelStats.snapshot 结构化条目，逐角色累加）。
   *
   * 与角色槽统计同口径：回落条目（via_fallback）记作 `{role}→agent` 键
   * （来源回落可观测），非正计数为观测噪声（清零/非法输入），不并入。
   */
  record_llm_calls(stats: ReadonlyArray<RoleCallStat> | null = null): void {
    for (const entry of stats ?? []) {
      const value = Math.trunc(Number(entry.count));
      if (value <= 0) {
        continue;
      }
      const key = role_call_label(entry.role, entry.via_fallback);
      this.llm_calls_by_role[key] = (this.llm_calls_by_role[key] ?? 0) + value;
    }
  }

  /** 失败率（0-1；无回合 = 0，不除零）。 */
  get failure_rate(): number {
    return this.turns ? this.failures / this.turns : 0.0;
  }

  /** 汇出结构化指标（调参输入；可随评估记录落库/审计）。 */
  snapshot(): JsonRecord {
    return {
      turns: this.turns,
      auto_turns: this.auto_turns,
      failures: this.failures,
      failure_rate: this.failure_rate,
      llm_calls_by_role: { ...this.llm_calls_by_role },
      last_error: this.last_error,
    };
  }

  /** 从快照还原（评估记录回放/审计用）。 */
  static from_snapshot(data: unknown): TurnMetrics {
    if (!isRecord(data)) {
      throw new GraphDefinitionError('回合指标快照非法: 期望 dict');
    }
    const rawCalls = data['llm_calls_by_role'] ?? data['llm_calls_by_tier']; // 兼容历史挡位键
    const calls: Record<string, number> = {};
    if (isRecord(rawCalls)) {
      for (const [role, count] of Object.entries(rawCalls)) {
        calls[String(role)] = Math.trunc(Number(count));
      }
    }
    return new TurnMetrics({
      turns: Math.trunc(Number(data['turns'] ?? 0)),
      auto_turns: Math.trunc(Number(data['auto_turns'] ?? 0)),
      failures: Math.trunc(Number(data['failures'] ?? 0)),
      llm_calls_by_role: calls,
      last_error:
        data['last_error'] === undefined || data['last_error'] === null
          ? ''
          : String(data['last_error']),
    });
  }
}
