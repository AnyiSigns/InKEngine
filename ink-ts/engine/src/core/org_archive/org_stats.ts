/**
 * 组织档案聚合统计形态（trail → 组织模式统计的数值面）。
 *
 * 轨迹（ExecutionTrail）作为组织档案聚合的单元被 ingest 后，逐条落到三类
 * 统计键上（转场模式 / 链模式 / 作用域使用），键级数值形态统一为本模块的
 * OrgStats：
 *
 * - 成败计数：count/success/failure/degraded（count = 三者和，序列化冗余携带
 *   便于人工核对，解析时以三者重算，防脏档错位）；
 * - 成本聚合：steps/cost/tokens/ms 各自求和 + 贡献数 _n（整条轨迹成本只对该
 *   轨迹涉及的每个键各记一次——均值含义 = 「含该模式/该作用域完成」的执行
 *   平均成本，属择优启发信号，精确到模式/作用域的逐步成本切分属运行时事件
 *   级归因，不在本数据面臆造）；
 * - 使用近度：first_seen_ms/last_seen_ms（键级最早/最近一次执行时刻）；
 * - 形态扩展：转场键带 fan_width_total/fan_width_n（并行档合计与观测数，
 *   均值 = 平均扇出/并行路数）。
 *
 * 归因口径（与 org_archive 配套）：模式/链统计对含该键的轨迹整条归因终态；
 * **作用域统计只对「该作用域自己收尾完成」的执行归因**（组织者/过路作用域不
 * 吸收子执行成败，避免主持人被下游失败误伤——组织决策层面的成败记在转场/链
 * 模式上）。因此作用域键的 count 即其自身完成次数，转场键另有并行档扩展。
 *
 * 本模块只做数值聚合与 dict 编解码，不含键/作用域语义（见 org_patterns）与
 * 择优判定（见 pruning）。解析对未知键忽略（存档版本容忍），字段出现但类型
 * 非法 = 显式抛错（fail-closed）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import type { TrailCost, TrailOutcome } from './execution_trail.js';

/** 单键聚合统计（三类统计键共用；扩展字段按键语义使用）。 */
export interface OrgStats {
  count: number;
  success: number;
  failure: number;
  degraded: number;
  cost_total: number;
  cost_n: number;
  tokens_total: number;
  tokens_n: number;
  ms_total: number;
  ms_n: number;
  steps_total: number;
  steps_n: number;
  first_seen_ms: number | null;
  last_seen_ms: number | null;
  /** 转场键扩展：并行档合计与观测数（均值 = 平均扇出/并行路数）。 */
  fan_width_total?: number;
  fan_width_n?: number;
}

/** 空统计（全零 + 未见时刻）。 */
export function empty_org_stats(): OrgStats {
  return {
    count: 0,
    success: 0,
    failure: 0,
    degraded: 0,
    cost_total: 0,
    cost_n: 0,
    tokens_total: 0,
    tokens_n: 0,
    ms_total: 0,
    ms_n: 0,
    steps_total: 0,
    steps_n: 0,
    first_seen_ms: null,
    last_seen_ms: null,
  };
}

/** 记一次观察（终态 + 可选成本 + 执行时刻；fan_width 为转场键扩展）。 */
export function record_observation(
  stats: OrgStats,
  outcome: TrailOutcome,
  cost: TrailCost | null | undefined,
  seen_ms: number,
  fan_width: number | null = null,
): void {
  stats.count += 1;
  if (outcome === 'success') stats.success += 1;
  else if (outcome === 'failure') stats.failure += 1;
  else stats.degraded += 1;
  if (cost !== null && cost !== undefined) {
    if (cost.cost !== undefined) {
      stats.cost_total += cost.cost;
      stats.cost_n += 1;
    }
    if (cost.tokens !== undefined) {
      stats.tokens_total += cost.tokens;
      stats.tokens_n += 1;
    }
    if (cost.ms !== undefined) {
      stats.ms_total += cost.ms;
      stats.ms_n += 1;
    }
    if (cost.steps !== undefined) {
      stats.steps_total += cost.steps;
      stats.steps_n += 1;
    }
  }
  if (stats.first_seen_ms === null || seen_ms < stats.first_seen_ms) {
    stats.first_seen_ms = seen_ms;
  }
  if (stats.last_seen_ms === null || seen_ms > stats.last_seen_ms) {
    stats.last_seen_ms = seen_ms;
  }
  if (fan_width !== null) {
    stats.fan_width_total = (stats.fan_width_total ?? 0) + fan_width;
    stats.fan_width_n = (stats.fan_width_n ?? 0) + 1;
  }
}

/** 成功占比（无观测 = 0）。 */
export function success_rate(stats: OrgStats): number {
  return stats.count === 0 ? 0 : stats.success / stats.count;
}

/** 失败占比（failure + degraded 同计为负面信号；无观测 = 0）。 */
export function failure_rate(stats: OrgStats): number {
  return stats.count === 0 ? 0 : (stats.failure + stats.degraded) / stats.count;
}

/** 读非负整数（缺省 0；出现须为整数，非法抛错）。 */
function _uint(raw: unknown, where: string): number {
  if (raw === undefined) return 0;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new GraphDefinitionError(`${where} 非法: 期望非负整数，收到 ${String(raw)}`);
  }
  return raw;
}

/** 读非负有限数或 null（缺省 null；非法抛错）。 */
function _nullable_num(raw: unknown, where: string): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new GraphDefinitionError(`${where} 非法: 期望非负有限数，收到 ${String(raw)}`);
  }
  return raw;
}

/** 解析统计 dict（未知键忽略；count 以成败三者重算，防脏档错位）。 */
export function org_stats_from_dict(data: unknown): OrgStats {
  if (!isRecord(data)) {
    throw new GraphDefinitionError('聚合统计须为 dict');
  }
  const success = _uint(data['success'], 'stats.success');
  const failure = _uint(data['failure'], 'stats.failure');
  const degraded = _uint(data['degraded'], 'stats.degraded');
  const stats: OrgStats = {
    ...empty_org_stats(),
    count: success + failure + degraded,
    success,
    failure,
    degraded,
    cost_total: _nullable_num(data['cost_total'], 'stats.cost_total') ?? 0,
    cost_n: _uint(data['cost_n'], 'stats.cost_n'),
    tokens_total: _nullable_num(data['tokens_total'], 'stats.tokens_total') ?? 0,
    tokens_n: _uint(data['tokens_n'], 'stats.tokens_n'),
    ms_total: _nullable_num(data['ms_total'], 'stats.ms_total') ?? 0,
    ms_n: _uint(data['ms_n'], 'stats.ms_n'),
    steps_total: _nullable_num(data['steps_total'], 'stats.steps_total') ?? 0,
    steps_n: _uint(data['steps_n'], 'stats.steps_n'),
    first_seen_ms: _nullable_num(data['first_seen_ms'], 'stats.first_seen_ms'),
    last_seen_ms: _nullable_num(data['last_seen_ms'], 'stats.last_seen_ms'),
  };
  const fanWidthTotal = _nullable_num(data['fan_width_total'], 'stats.fan_width_total');
  const fanWidthN = _uint(data['fan_width_n'], 'stats.fan_width_n');
  if (fanWidthTotal !== null && fanWidthN > 0) {
    stats.fan_width_total = fanWidthTotal;
    stats.fan_width_n = fanWidthN;
  }
  return stats;
}

/** 序列化统计 dict（count 冗余携带；扩展字段只在有值时落键）。 */
export function org_stats_to_dict(stats: OrgStats): Record<string, unknown> {
  const data: Record<string, unknown> = {
    count: stats.count,
    success: stats.success,
    failure: stats.failure,
    degraded: stats.degraded,
    cost_total: stats.cost_total,
    cost_n: stats.cost_n,
    tokens_total: stats.tokens_total,
    tokens_n: stats.tokens_n,
    ms_total: stats.ms_total,
    ms_n: stats.ms_n,
    steps_total: stats.steps_total,
    steps_n: stats.steps_n,
    first_seen_ms: stats.first_seen_ms,
    last_seen_ms: stats.last_seen_ms,
  };
  if (stats.fan_width_total !== undefined && stats.fan_width_n !== undefined && stats.fan_width_n > 0) {
    data['fan_width_total'] = stats.fan_width_total;
    data['fan_width_n'] = stats.fan_width_n;
  }
  return data;
}
