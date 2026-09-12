/**
 * 组织档案聚合单测（org_archive.ts：轨迹 → 转场/链/作用域统计 + 存档形态）。
 *
 * 覆盖：
 * - ingest 单跳轨迹：模式/作用域统计（成败计数、成本聚合、收尾归属、并行档）；
 * - 多跳轨迹：链模式聚合、作用域去重保序、整条轨迹成本对各键各记一次；
 * - 失败/降级终态与成功/失败占比（success_rate/failure_rate）；
 * - ingest 校验 fail-closed（非法轨迹对象显式抛错）；
 * - ingest_record（dict → 解析 → ingest）与 ingest 等价；
 * - 查询返回副本（防别名改写漂移）；使用近度 first/last_seen；
 * - to_dict ↔ from_dict round-trip + 未知键/未知统计键容忍（版本前向兼容）；
 * - 空档案零漂移（固定存档形态）。
 */

import { describe, expect, it } from 'vitest';

import {
  CHANNEL_COMMIT_BEST,
  CHANNEL_COMMIT_FULL,
} from '../../../src/model/channels/channel_spec.js';
import {
  parse_execution_trail,
  type ExecutionTrail,
} from '../../../src/core/org_archive/execution_trail.js';
import {
  ORG_ARCHIVE_SCHEMA_VERSION,
  OrgArchive,
} from '../../../src/core/org_archive/org_archive.js';
import { failure_rate, success_rate } from '../../../src/core/org_archive/org_stats.js';

/** 构造合法轨迹（入口 main，parent null）。 */
function make(
  run_id: string,
  outcome: string,
  hops: unknown[],
  extra: Record<string, unknown> = {},
): ExecutionTrail {
  return parse_execution_trail({
    run_id,
    parent_run_id: null,
    entry_scope: 'main',
    hops,
    outcome,
    ...extra,
  });
}

const delegate = { from: 'main', to: 'planner', shape: 'delegate' };

describe('org_archive 单跳 ingest', () => {
  it('转场 + 作用域统计：成败/成本/收尾/并行档各就各位', () => {
    const archive = new OrgArchive();
    archive.ingest(
      make('r1', 'success', [delegate], {
        cost: { cost: 10, tokens: 100, ms: 50, steps: 2 },
        ended_at_ms: 1000,
      }),
    );
    expect(archive.ingested_count()).toBe(1);
    const pattern = archive.transition_stats('main', 'planner', 'delegate');
    expect(pattern).not.toBeNull();
    expect(pattern!).toMatchObject({
      count: 1,
      success: 1,
      failure: 0,
      degraded: 0,
      cost_total: 10,
      cost_n: 1,
      tokens_total: 100,
      tokens_n: 1,
      ms_total: 50,
      steps_total: 2,
    });
    expect(pattern!.fan_width_total).toBeUndefined();
    // 作用域只对收尾作用域归因：本轨迹收尾 = planner（main 只组织不吸收）
    expect(archive.scope_usage('main')).toBeNull();
    const planner = archive.scope_usage('planner')!;
    expect(planner.count).toBe(1);
    expect(planner.success).toBe(1);
    expect(planner.cost_total).toBe(10);
    expect(planner.tokens_total).toBe(100);
    expect(archive.chain_entries()).toEqual([]);
  });

  it('整条轨迹成本对涉及各键各记一次（转场/作用域口径一致）', () => {
    const archive = new OrgArchive();
    archive.ingest(
      make('r1', 'success', [
        { from: 'main', to: 'planner', shape: 'delegate' },
        { from: 'planner', to: 'coder', shape: 'fan_out', count: 3 },
        { from: 'coder', to: 'critic', shape: 'fan_in', commit: 'best' },
      ], { cost: { tokens: 1000, ms: 200, steps: 8 } }),
    );
    expect(archive.ingested_count()).toBe(1);
    // 三条转场各记一次成本
    for (const [from, to, shape, commit] of [
      ['main', 'planner', 'delegate', CHANNEL_COMMIT_FULL],
      ['planner', 'coder', 'fan_out', CHANNEL_COMMIT_FULL],
      ['coder', 'critic', 'fan_in', CHANNEL_COMMIT_BEST],
    ] as const) {
      const stats = archive.transition_stats(from, to, shape, commit)!;
      expect(stats.count).toBe(1);
      expect(stats.tokens_total).toBe(1000);
      expect(stats.ms_n).toBe(1);
    }
    // 并行档聚合（fan_out hop count=3）
    const fanOut = archive.transition_stats('planner', 'coder', 'fan_out')!;
    expect(fanOut.fan_width_total).toBe(3);
    expect(fanOut.fan_width_n).toBe(1);
    // 链模式聚合（两跳链各 1 次，成功 1）
    const chains = archive.chain_entries();
    expect(chains).toHaveLength(2);
    expect(chains[0]!.stats.success).toBe(1);
    const firstChain = archive.chain_stats(
      'main', 'planner', 'coder', 'delegate', CHANNEL_COMMIT_FULL, 'fan_out', CHANNEL_COMMIT_FULL,
    )!;
    expect(firstChain.count).toBe(1);
    expect(firstChain.tokens_total).toBe(1000);
    // 作用域只记收尾作用域（critic 完成本次执行），成本/成败随其归因
    expect(archive.scope_entries()).toHaveLength(1);
    const criticScope = archive.scope_usage('critic')!;
    expect(criticScope.count).toBe(1);
    expect(criticScope.success).toBe(1);
    expect(criticScope.tokens_total).toBe(1000);
    expect(archive.scope_usage('main')).toBeNull();
    expect(archive.scope_usage('planner')).toBeNull();
  });

  it('失败/降级终态计入失败侧，占比随 success_rate/failure_rate 反映', () => {
    const archive = new OrgArchive();
    archive.ingest(make('r1', 'success', [delegate]), 100);
    archive.ingest(make('r2', 'failure', [delegate]), 200);
    archive.ingest(make('r3', 'degraded', [delegate]), 300);
    const stats = archive.transition_stats('main', 'planner', 'delegate')!;
    expect(stats).toMatchObject({ count: 3, success: 1, failure: 1, degraded: 1 });
    expect(success_rate(stats)).toBeCloseTo(1 / 3);
    expect(failure_rate(stats)).toBeCloseTo(2 / 3);
    expect(stats.first_seen_ms).toBe(100);
    expect(stats.last_seen_ms).toBe(300);
  });

  it('ingest 对非法轨迹对象 fail-closed（自环显式抛错）', () => {
    const archive = new OrgArchive();
    const bad: ExecutionTrail = {
      run_id: 'r',
      parent_run_id: null,
      entry_scope: 'main',
      hops: [{ from: 'main', to: 'main', shape: 'delegate' }],
      outcome: 'success',
    };
    expect(() => archive.ingest(bad)).toThrow(/自环/);
    expect(archive.ingested_count()).toBe(0);
  });
});

describe('org_archive 查询与 ingest_record', () => {
  it('查询返回副本：就地改写查询结果不影响档案', () => {
    const archive = new OrgArchive();
    archive.ingest(make('r1', 'success', [delegate]), 100);
    const plannerCopy = archive.scope_usage('planner')!;
    plannerCopy.count = 999;
    plannerCopy.cost_total = 999;
    expect(archive.scope_usage('planner')!.count).toBe(1);
    expect(archive.scope_usage('planner')!.cost_total).toBe(0);
  });

  it('ingest_record（dict → 解析 → ingest）与 ingest 等价', () => {
    const archive = new OrgArchive();
    const dict = {
      run_id: 'r1',
      parent_run_id: 'p',
      entry_scope: 'main',
      hops: [{ from: 'main', to: 'planner', shape: 'delegate', commit: 'best' }],
      outcome: 'failure',
      cost: { cost: 3 },
      ended_at_ms: 500,
    };
    archive.ingest_record(dict, 400);
    const viaDict = archive.transition_stats('main', 'planner', 'delegate', CHANNEL_COMMIT_BEST)!;
    expect(viaDict.count).toBe(1);
    expect(viaDict.failure).toBe(1);
    expect(archive.scope_usage('planner')!.last_seen_ms).toBe(400);
  });

  it('无观测的查询 = null', () => {
    const archive = new OrgArchive();
    archive.ingest(make('r1', 'success', [delegate]), 100);
    expect(archive.transition_stats('main', 'critic', 'delegate')).toBeNull();
    expect(archive.chain_stats_by_key('["chain","a","b","c","delegate","full","fan_out","full"]')).toBeNull();
    expect(archive.scope_usage('ghost')).toBeNull();
  });
});

describe('org_archive 存档形态', () => {
  it('空档案零漂移：固定键形态', () => {
    expect(new OrgArchive().to_dict()).toEqual({
      schema_version: ORG_ARCHIVE_SCHEMA_VERSION,
      ingested: 0,
      patterns: {},
      chains: {},
      scopes: {},
    });
  });

  it('to_dict ↔ from_dict round-trip 全量保持', () => {
    const archive = new OrgArchive();
    archive.ingest(
      make('r1', 'success', [
        { from: 'main', to: 'planner', shape: 'delegate' },
        { from: 'planner', to: 'main', shape: 'return' },
      ], { cost: { cost: 7, tokens: 50, ms: 90, steps: 3 }, ended_at_ms: 100 }),
      100,
    );
    archive.ingest(make('r2', 'failure', [delegate], { ended_at_ms: 300 }), 300);
    const restored = OrgArchive.from_dict(archive.to_dict());
    expect(restored.to_dict()).toEqual(archive.to_dict());
    expect(restored.ingested_count()).toBe(2);
    // r1 收尾 main（回传），r2 收尾 planner（委托直达）→ 各自记 1 次
    expect(restored.scope_usage('planner')!.count).toBe(1);
    expect(restored.scope_usage('main')!.count).toBe(1);
  });

  it('未知顶层键 / 未知统计键忽略（版本容忍）；count 以成败重算', () => {
    const dict = new OrgArchive().to_dict();
    dict['future_flag'] = true;
    dict['patterns'] = {
      '["transition","main","planner","delegate","full"]': {
        success: 2,
        failure: 1,
        degraded: 0,
        count: 99,
        cost_total: 5,
        unknown_stat: 'x',
      },
    };
    const restored = OrgArchive.from_dict(dict);
    const stats = restored.transition_stats('main', 'planner', 'delegate')!;
    expect(stats.count).toBe(3);
    expect(stats.failure).toBe(1);
    expect(stats.cost_total).toBe(5);
    expect(restored.to_dict()['future_flag']).toBeUndefined();
  });

  it('统计 dict 类型非法显式抛错（fail-closed）', () => {
    expect(() => OrgArchive.from_dict({ patterns: 'x' })).toThrow(/patterns/);
    expect(() =>
      OrgArchive.from_dict({ patterns: { k: { success: -1 } } }),
    ).toThrow(/success/);
    expect(() => OrgArchive.from_dict('x')).toThrow(/档案须为 dict/);
  });
});
