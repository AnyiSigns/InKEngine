/**
 * 池治理 settle 钩子真实现单测（引擎每回合自动跑语义）。
 *
 * 覆盖：单回合判定（失败边 dst → 候选 → 治理判定 + 审计留痕）、多回合
 * 稳定性（预算耗尽后稳定 reject 不震荡）、近重复合并收敛（合并去重 +
 * 单回合合并上限护栏）、store 缺失/空池 skip（fail-closed 不做空数据放行
 * 判定）。全部断言确定性（固定时钟/固定证据行）。
 */

import { describe, expect, it } from 'vitest';

import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/store.js';
import {
  GOV_VERDICT_ALLOW,
  GOV_VERDICT_MERGE,
  GOV_VERDICT_REJECT,
  PoolGovernance,
} from '../../../src/core/pool_governance/pool_governance.js';
import { PoolGovernanceSettleHook, POOL_GOVERNANCE_AUDIT_TYPE, POOL_GOVERNANCE_MERGE_CAP_PER_ROUND } from '../../../src/core/settle/review.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { TRACE_FAILED, TRACE_SUCCESS } from '../../../src/core/settle/_constants.js';
import { edgeKey, linearGraph, makeCtx, stepsOf } from '../settle/helpers.js';

const NOW = 1_800_000_000;

/** 往证据存储放一行边证据（dst 类型 = 池成员）。 */
async function putEdge(
  store: EdgeEvidenceStore,
  src: string,
  dst: string,
  success: number,
  fail: number,
  opts: { domain?: string; last_used_at?: number | null } = {},
): Promise<void> {
  await store.put({
    key: edgeKey(src, dst, { domain: opts.domain ?? 'code' }),
    success_count: success,
    fail_count: fail,
    avg_cost: 0.0,
    policy: false,
    origin: 'runtime',
    last_used_at: opts.last_used_at ?? NOW,
    created_at: NOW,
  });
}

/** 审计收集 sink。 */
function makeSink(): { records: Array<Record<string, unknown>>; sink: (r: Record<string, unknown>) => void } {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
    },
  };
}

describe('PoolGovernanceSettleHook 单回合判定', () => {
  it('失败边 dst 提炼候选 → evaluate → 审计留痕（预算内 allow）', async () => {
    const store = new EdgeEvidenceStore();
    const gov = new PoolGovernance({ now: () => NOW });
    const sink = makeSink();
    const hook = new PoolGovernanceSettleHook(gov, {
      store,
      now: () => NOW,
      audit_sink: sink.sink,
    });
    // start 成功 → mid 失败（start→mid 在图内，归因回放产出遍历）
    const ctx = makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_FAILED]));
    await hook.settle(ctx);
    expect(gov.log.length).toBe(1);
    expect(gov.log[0]!['node_id']).toBe('mid');
    expect(gov.log[0]!['verdict']).toBe(GOV_VERDICT_ALLOW);
    expect(hook.audits.length).toBe(1);
    const audit = hook.audits[0]!;
    expect(audit['type']).toBe(POOL_GOVERNANCE_AUDIT_TYPE);
    expect(audit['candidate']).toBe('mid');
    expect(sink.records).toEqual(hook.audits);
    await store.close();
  });

  it('成功轮/无候选 = no-op（gov.log 与审计均空）', async () => {
    const store = new EdgeEvidenceStore();
    const gov = new PoolGovernance({ now: () => NOW });
    const hook = new PoolGovernanceSettleHook(gov, { store, now: () => NOW });
    const ctx = makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_SUCCESS]));
    await hook.settle(ctx);
    expect(gov.log.length).toBe(0);
    expect(hook.audits.length).toBe(0);
    await store.close();
  });

  it('store 缺失：fail-closed skip 并记原因（不做空数据放行判定）', async () => {
    const gov = new PoolGovernance({ now: () => NOW });
    const hook = new PoolGovernanceSettleHook(gov, { now: () => NOW });
    const ctx = makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_FAILED]));
    await hook.settle(ctx);
    expect(gov.log.length).toBe(0);
    expect(hook.audits.length).toBe(0);
    expect(hook.skips.length).toBe(1);
    expect(hook.skips[0]).toContain('边证据存储缺失');
  });
});

describe('PoolGovernanceSettleHook 多回合稳定性', () => {
  it('预算 3/周/域：连续 4 回合 verdict 序列 allow×3 → reject（稳定不震荡）', async () => {
    const store = new EdgeEvidenceStore();
    const gov = new PoolGovernance({ now: () => NOW });
    const hook = new PoolGovernanceSettleHook(gov, { store, now: () => NOW });
    const ctx = makeCtx(stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_FAILED]));
    for (let i = 0; i < 4; i += 1) {
      await hook.settle(ctx);
    }
    const verdicts = gov.log.map((r) => r['verdict']);
    expect(verdicts).toEqual([
      GOV_VERDICT_ALLOW,
      GOV_VERDICT_ALLOW,
      GOV_VERDICT_ALLOW,
      GOV_VERDICT_REJECT,
    ]);
    await store.close();
  });
});

describe('PoolGovernanceSettleHook 近重复合并收敛', () => {
  /** 图：entry → dup_candidate（合成失败目标类型，图内边存在）。 */
  function dupGraph(dst: string): Graph {
    const g = new Graph({ name: `dup-${dst}`, entry: 'entry' });
    g.add_node('entry', async () => ({}));
    g.add_node(dst, async () => ({}));
    g.add_edge('entry', dst);
    g.add_exit(dst);
    return g;
  }

  it('字段近重复 → merge 裁决 + 落 resolved（后续回合同候选不再重复提请）', async () => {
    const store = new EdgeEvidenceStore();
    // 池内既有成员 existing（五字段）；store 有该成员的行
    await putEdge(store, 's', 'existing', 10, 0);
    const gov = new PoolGovernance({ now: () => NOW });
    const hook = new PoolGovernanceSettleHook(gov, {
      store,
      now: () => NOW,
      node_fields: (node) => {
        if (node === 'existing' || node === 'dup_candidate') {
          return ['a', 'b', 'c', 'd', 'e', 'f'];
        }
        return [];
      },
    });
    const ctx = makeCtx(stepsOf(['entry', TRACE_SUCCESS], ['dup_candidate', TRACE_FAILED]), {
      graph: dupGraph('dup_candidate'),
    });
    await hook.settle(ctx);
    expect(gov.log.length).toBe(1);
    expect(gov.log[0]!['verdict']).toBe(GOV_VERDICT_MERGE);
    expect(gov.log[0]!['merge_target']).toBe('existing');
    expect(hook.audits.length).toBe(1);
    // 已合并去重：回合同一失败 dst 不再重复提请（稳定性）
    await hook.settle(ctx);
    expect(gov.log.length).toBe(1);
    expect(hook.audits.length).toBe(1);
    await store.close();
  });

  it('单回合合并应用次数上限护栏（超限候选跳过并留痕）', async () => {
    expect(POOL_GOVERNANCE_MERGE_CAP_PER_ROUND).toBe(1);
    const store = new EdgeEvidenceStore();
    await putEdge(store, 's', 'pool_a', 10, 0);
    await putEdge(store, 's', 'pool_b', 10, 0);
    const gov = new PoolGovernance({ now: () => NOW });
    const hook = new PoolGovernanceSettleHook(gov, {
      store,
      now: () => NOW,
      node_fields: (node) =>
        ['pool_a', 'pool_b', 'cand_a', 'cand_b'].includes(node)
          ? ['a', 'b', 'c', 'd', 'e', 'f']
          : [],
    });
    // 单路径 a → cand_a → cand_b（同轮两个近重复候选）
    const g = new Graph({ name: 'chain', entry: 'a' });
    g.add_node('a', async () => ({}));
    g.add_node('cand_a', async () => ({}));
    g.add_node('cand_b', async () => ({}));
    g.add_edge('a', 'cand_a');
    g.add_edge('cand_a', 'cand_b');
    g.add_exit('cand_b');
    const ctx = makeCtx(
      stepsOf(['a', TRACE_SUCCESS], ['cand_a', TRACE_FAILED], ['cand_b', TRACE_FAILED]),
      { graph: g },
    );
    await hook.settle(ctx);
    // 两个候选都被 evaluate 并留痕（治理日志/审计），但只有一次 merge 被
    // 应用（resolved 去重登记）——单回合合并应用次数受上限护栏
    const merges = gov.log.filter((r) => r['verdict'] === GOV_VERDICT_MERGE);
    expect(merges.length).toBe(2);
    expect(hook._merge_resolved.size).toBe(1); // 只应用一次合并收敛
    const skipped = hook.audits.find((r) => r['skipped_reason'] !== undefined);
    expect(skipped).toBeTruthy();
    expect(String(skipped!['skipped_reason'])).toContain('单回合合并应用超上限');
    await store.close();
  });
});
