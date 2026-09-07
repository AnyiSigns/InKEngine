/**
 * pool 命令面（snapshot / evaluate）——池治理判定只读面与登记入口。
 *
 * 数据源 = runtime.pool_governance（引擎池治理登记器；settle 每回合判定
 * 后 append-only 登记 {node_id, ts, verdict, reasons, eviction_candidates,
 * merge_target, budget_remaining}）。snapshot 只读登记记录 + 派生计数；
 * evaluate 调引擎 evaluate 只登记不执行（无任何越权写路径）。无登记器 /
 * 无登记记录 = 结构化空态（last_round:null，不报错不编造）。
 *
 * 计数均为登记记录字段的透传投影：verdict 按原值计数（不解释语义）；
 * 死结点候选 = eviction_candidates 合计、近重复 = merge_target 非空行数；
 * 周预算已用 = 登记 ts 落在最近一周窗口的行数（now = runtime 时钟 seam，
 * 与引擎登记同源），余量 = 最近一条登记的 budget_remaining。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 引擎 PoolGovernance 登记器结构面（runtime 装配产物，结构即契约）。 */
interface PoolGovernanceLike {
  log: Array<Record<string, unknown>>;
  evaluate(
    proposal: Record<string, unknown>,
    snapshot: Record<string, unknown>,
  ): { to_dict(): Record<string, unknown> };
}

/** 周窗口秒数（与引擎 weekly 预算口径一致；记录时间窗投影用）。 */
const WEEK_SECONDS = 7 * 24 * 3600;

/** 快照窗口最多返回的登记条数（newest first）。 */
const LOG_WINDOW = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function governanceOrNull(deps: HostBridgeDeps): PoolGovernanceLike | null {
  const governance = deps.runtime.pool_governance;
  if (governance === null) return null;
  return governance as unknown as PoolGovernanceLike;
}

/** 派生计数（登记记录字段透传投影；now = runtime 时钟与引擎同源）。 */
function deriveCounts(
  log: readonly Record<string, unknown>[],
  now: number,
): Record<string, unknown> {
  const verdictCounts: Record<string, number> = {};
  const nodeIds = new Set<string>();
  let evictionCandidates = 0;
  let merges = 0;
  let weeklyUsed = 0;
  const cutoff = now - WEEK_SECONDS;
  for (const record of log) {
    const nodeId = record['node_id'];
    if (typeof nodeId === 'string' && nodeId !== '') nodeIds.add(nodeId);
    const verdict = record['verdict'];
    if (typeof verdict === 'string' && verdict !== '') {
      verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
    }
    const candidates = record['eviction_candidates'];
    if (Array.isArray(candidates)) {
      evictionCandidates += candidates.filter((id) => typeof id === 'string' && id !== '').length;
    }
    const mergeTarget = record['merge_target'];
    if (typeof mergeTarget === 'string' && mergeTarget !== '') merges += 1;
    const ts = record['ts'];
    if (ts === undefined || ts === null || Number(ts) >= cutoff) weeklyUsed += 1;
  }
  return {
    pool_count: nodeIds.size,
    verdict_counts: verdictCounts,
    dead_node_candidates: evictionCandidates,
    near_duplicate_merges: merges,
    weekly_budget_used: weeklyUsed,
  };
}

/** 最近一条登记的预算余量（无登记 = null）。 */
function lastBudgetRemaining(log: readonly Record<string, unknown>[]): number | null {
  const last = log.length > 0 ? log[log.length - 1] : null;
  const value = last?.['budget_remaining'];
  return value === undefined || value === null ? null : toNumber(value);
}

/** pool 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const POOL_COMMANDS = [
  'pool.snapshot',
  'pool.evaluate',
] as const;

export type PoolCommand = (typeof POOL_COMMANDS)[number];

export function buildPoolCommands(deps: HostBridgeDeps): Readonly<Record<PoolCommand, BridgeHandler>> {
  /** pool.snapshot：池治理登记快照 + 派生计数（无登记 = 空态）。 */
  const snapshot: BridgeHandler = (): Record<string, unknown> => {
    const governance = governanceOrNull(deps);
    if (governance === null) {
      return {
        available: false,
        entries: [],
        counts: { pool_count: 0, dead_node_candidates: 0, near_duplicate_merges: 0 },
        last_round: null,
        degraded: true,
      };
    }
    const log = governance.log;
    const now = deps.runtime._r_now();
    const windowRows = [...log].reverse().slice(0, LOG_WINDOW);
    const last: Record<string, unknown> | null = log.length > 0 ? log[log.length - 1]! : null;
    const lastRound = last === null
      ? null
      : {
          node_id: typeof last['node_id'] === 'string' ? last['node_id'] : null,
          verdict: typeof last['verdict'] === 'string' ? last['verdict'] : null,
          ts: typeof last['ts'] === 'number' ? last['ts'] : null,
          budget_remaining: lastBudgetRemaining(log),
        };
    return {
      available: true,
      governance_log: windowRows,
      counts: {
        ...deriveCounts(log, now),
        evaluations: log.length,
        weekly_budget_remaining: lastBudgetRemaining(log),
      },
      last_round: lastRound,
      degraded: false,
    };
  };

  /** pool.evaluate：对给定提案跑一次引擎四规则判定（只登记不越权写）。 */
  const evaluate: BridgeHandler = async (raw): Promise<Record<string, unknown>> => {
    const governance = governanceOrNull(deps);
    if (governance === null) {
      return { available: false, evaluated: false };
    }
    const params = isRecord(raw) ? raw : {};
    const proposal = isRecord(params['proposal']) ? (params['proposal'] as Record<string, unknown>) : null;
    const nodeId = proposal?.['node_id'];
    if (proposal === null || typeof nodeId !== 'string' || nodeId === '') {
      throw new BridgeError('pool.evaluate 需 proposal.node_id', 'invalid_params');
    }
    const rawFields = proposal['fields'];
    const fields = Array.isArray(rawFields)
      ? rawFields.filter((field): field is string => typeof field === 'string' && field !== '')
      : [];
    const snapshotInput = isRecord(params['snapshot']) ? (params['snapshot'] as Record<string, unknown>) : {};
    const snapshot: Record<string, unknown> = {};
    const poolCount = Number(snapshotInput['pool_count']);
    if (Number.isFinite(poolCount) && poolCount >= 0) snapshot['pool_count'] = Math.trunc(poolCount);
    const usedThisWeek = Number(snapshotInput['used_this_week']);
    if (Number.isFinite(usedThisWeek) && usedThisWeek >= 0) snapshot['used_this_week'] = Math.trunc(usedThisWeek);
    const rawNodes = snapshotInput['pool_nodes'];
    if (Array.isArray(rawNodes)) {
      snapshot['pool_nodes'] = rawNodes
        .filter(isRecord)
        .filter((node) => typeof node['node_id'] === 'string' && node['node_id'] !== '')
        .map((node) => ({ node_id: node['node_id'], fields: Array.isArray(node['fields']) ? node['fields'] : [] }));
    }
    const cosine = Number(snapshotInput['duplicate_cosine']);
    if (Number.isFinite(cosine)) snapshot['duplicate_cosine'] = cosine;
    const verdict = governance.evaluate({ node_id: nodeId, fields }, snapshot);
    return { available: true, evaluated: true, ...verdict.to_dict() };
  };

  return {
    'pool.snapshot': snapshot,
    'pool.evaluate': evaluate,
  };
}
