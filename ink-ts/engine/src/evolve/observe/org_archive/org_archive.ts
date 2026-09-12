/**
 * 组织档案（OrgArchive：轨迹 → 组织模式统计的纯聚合容器）。
 *
 * 组织档案 = 组织模式（scope×channel 组合）跨会话统计（§六）：把一条条轨迹
 * （ExecutionTrail）ingest 进来，累积三类键级统计：
 *
 * - 转场模式 patterns：一次转场（A→B，形态+提交契约，含并行档聚合）；
 * - 链模式 chains：两跳连续转场（A→R→C，中继短路化择优的观察源）；
 * - 作用域使用 scopes：作用域**自己收尾完成**的执行统计（组织者/过路作用域
 *   不吸收子执行成败——组织决策成败记在转场/链模式上，作用域资产级成败按
 *   自身完成衡量，见 org_stats 归因口径）。
 *
 * 纯内存数据容器（JSON 进 JSON 出，无 IO）：ingest/query 全是纯函数，to_dict/
 * from_dict 提供稳定存档形态，供后续 GuardedStorage 集合（受控通道）与事件流
 * 接线消费——本模块不触碰存储、不产演化动作。
 *
 * 统计口径（模块级约定）：
 * - 一次轨迹的终态与成本，对该轨迹涉及的每个模式键各记一次（去重后）——成本
 *   均值 = 「含该模式/该作用域完成」的执行平均成本，属择优启发信号；
 * - 并行档 fan_width 随转场 hop 的 count 聚合（平均扇出 = 并行几路信号的种子）；
 * - 时刻 seen = ingest 注入 now（缺省 = 轨迹 ended_at_ms ?? 0），驱动使用近度。
 */

import { CHANNEL_COMMIT_FULL, type ChannelCommit, type ChannelShape } from '../../../model/channels/channel_spec.js';
import { GraphDefinitionError } from '../../../model/errors.js';
import { isRecord } from '../../../model/json.js';
import { parse_execution_trail, validate_execution_trail, type ExecutionTrail } from './execution_trail.js';
import {
  chain_key_of,
  chain_pattern_key,
  chains_of_trail,
  scope_usage_of_trail,
  transition_key_of,
  transition_pattern_key,
  transitions_of_trail,
} from './org_patterns.js';
import {
  empty_org_stats,
  org_stats_from_dict,
  org_stats_to_dict,
  record_observation,
  type OrgStats,
} from './org_stats.js';

/** 组织档案存档 schema 版本。 */
export const ORG_ARCHIVE_SCHEMA_VERSION = 1;

/** 档案聚合结果条目（键 + 统计，供上层窗口/择优消费）。 */
export interface OrgArchiveEntry<T = OrgStats> {
  key: string;
  stats: T;
}

/** 组织档案：轨迹 → 模式统计的纯聚合容器。 */
export class OrgArchive {
  readonly schema_version = ORG_ARCHIVE_SCHEMA_VERSION;
  #patterns = new Map<string, OrgStats>();
  #chains = new Map<string, OrgStats>();
  #scopes = new Map<string, OrgStats>();
  #ingested = 0;

  /** 已 ingest 的轨迹条数。 */
  ingested_count(): number {
    return this.#ingested;
  }

  /** ingest 一条轨迹（结构须合法；now 缺省 = 轨迹 ended_at_ms）。 */
  ingest(trail: ExecutionTrail, now_ms?: number): void {
    validate_execution_trail(trail);
    const seen = now_ms ?? trail.ended_at_ms ?? 0;
    const cost = trail.cost ?? null;

    // 作用域使用：只对收尾作用域归因（该作用域自己完成本次执行）
    const usage = scope_usage_of_trail(trail);
    const scopeStats = this.#scopes.get(usage.terminal) ?? empty_org_stats();
    record_observation(scopeStats, trail.outcome, cost, seen);
    this.#scopes.set(usage.terminal, scopeStats);

    for (const transition of transitions_of_trail(trail)) {
      const key = transition_key_of(transition);
      const stats = this.#patterns.get(key) ?? empty_org_stats();
      record_observation(stats, trail.outcome, cost, seen, transition.fan_width);
      this.#patterns.set(key, stats);
    }

    for (const chain of chains_of_trail(trail)) {
      const key = chain_key_of(chain);
      const stats = this.#chains.get(key) ?? empty_org_stats();
      record_observation(stats, trail.outcome, cost, seen);
      this.#chains.set(key, stats);
    }

    this.#ingested += 1;
  }

  /** ingest 一条轨迹字典（先解析再 ingest；非法记录显式抛错）。 */
  ingest_record(data: unknown, now_ms?: number): void {
    this.ingest(parse_execution_trail(data), now_ms);
  }

  /** 查询转场模式统计（commit 缺省 = 全量回传；无观测 = null）。 */
  transition_stats(
    from: string,
    to: string,
    shape: ChannelShape,
    commit: ChannelCommit = CHANNEL_COMMIT_FULL,
  ): OrgStats | null {
    const stats = this.#patterns.get(transition_pattern_key(from, to, shape, commit));
    return stats === undefined ? null : { ...stats };
  }

  /** 按转场模式键查询（无观测 = null）。 */
  transition_stats_by_key(key: string): OrgStats | null {
    const stats = this.#patterns.get(key);
    return stats === undefined ? null : { ...stats };
  }

  /** 查询链模式统计（提交契约缺省 = 全量回传；无观测 = null）。 */
  chain_stats(
    a: string,
    mid: string,
    c: string,
    shape1: ChannelShape,
    commit1: ChannelCommit = CHANNEL_COMMIT_FULL,
    shape2: ChannelShape,
    commit2: ChannelCommit = CHANNEL_COMMIT_FULL,
  ): OrgStats | null {
    const stats = this.#chains.get(
      chain_pattern_key(a, mid, c, shape1, commit1, shape2, commit2),
    );
    return stats === undefined ? null : { ...stats };
  }

  /** 按链模式键查询（无观测 = null）。 */
  chain_stats_by_key(key: string): OrgStats | null {
    const stats = this.#chains.get(key);
    return stats === undefined ? null : { ...stats };
  }

  /** 查询作用域使用统计（无观测 = null）。 */
  scope_usage(scope: string): OrgStats | null {
    const stats = this.#scopes.get(scope);
    return stats === undefined ? null : { ...stats };
  }

  /** 转场模式条目（insertion 序；统计为副本，防别名改写）。 */
  pattern_entries(): OrgArchiveEntry[] {
    return [...this.#patterns.entries()].map(([key, stats]) => ({
      key,
      stats: { ...stats },
    }));
  }

  /** 链模式条目（insertion 序；统计为副本）。 */
  chain_entries(): OrgArchiveEntry[] {
    return [...this.#chains.entries()].map(([key, stats]) => ({ key, stats: { ...stats } }));
  }

  /** 作用域条目（insertion 序；统计为副本）。 */
  scope_entries(): OrgArchiveEntry[] {
    return [...this.#scopes.entries()].map(([key, stats]) => ({ key, stats: { ...stats } }));
  }

  /** 序列化档案快照（GuardedStorage/事件流后续接线的稳定存档形态）。 */
  to_dict(): Record<string, unknown> {
    return {
      schema_version: ORG_ARCHIVE_SCHEMA_VERSION,
      ingested: this.#ingested,
      patterns: Object.fromEntries(
        [...this.#patterns.entries()].map(([k, v]) => [k, org_stats_to_dict(v)]),
      ),
      chains: Object.fromEntries(
        [...this.#chains.entries()].map(([k, v]) => [k, org_stats_to_dict(v)]),
      ),
      scopes: Object.fromEntries(
        [...this.#scopes.entries()].map(([k, v]) => [k, org_stats_to_dict(v)]),
      ),
    };
  }

  /** 从档案快照恢复（未知键/更高版本键忽略；统计 dict 类型非法显式抛错）。 */
  static from_dict(data: unknown): OrgArchive {
    if (!isRecord(data)) {
      throw new GraphDefinitionError('组织档案须为 dict');
    }
    const archive = new OrgArchive();
    const ingested = data['ingested'];
    if (ingested !== undefined) {
      if (typeof ingested !== 'number' || !Number.isInteger(ingested) || ingested < 0) {
        throw new GraphDefinitionError('档案 ingested 须为非负整数');
      }
      archive.#ingested = ingested;
    }
    for (const bucket of ['patterns', 'chains', 'scopes'] as const) {
      const raw = data[bucket];
      if (raw === undefined) continue;
      if (!isRecord(raw)) {
        throw new GraphDefinitionError(`档案 ${bucket} 须为 dict`);
      }
      const target = bucket === 'patterns'
        ? archive.#patterns
        : bucket === 'chains'
          ? archive.#chains
          : archive.#scopes;
      for (const [key, stats] of Object.entries(raw)) {
        target.set(key, org_stats_from_dict(stats));
      }
    }
    return archive;
  }
}
