/**
 * 结点池治理对标测试（容量/淘汰/合并/预算四条规则；只判定登记不执行）。
 *
 * 对标 pytest test_pool_governance.py：
 * - 容量上限：每域 N_max=500；满则新提案须携带淘汰候选；
 * - 死结点淘汰：usage_count=0 且未转正且 age>90 天 → 标记失效登记
 *   （不物理删）；
 * - 近重复合并：字段 Jaccard>0.8 或目的嵌入余弦>0.9 → 转合并提案；
 * - 提案预算：3/周/域，耗尽拒绝；
 * - 登记器：判定结果 append-only 登记；失效登记由判定记录派生；
 * - 接线辅助：提案归一 / 周预算窗口 / 注册表快照。
 *
 * 时间戳语义确定性：登记器时钟与周预算 now 均取固定值注入，不依赖真实
 * 时间——测试可复现，等价 Python 侧 time.time() 但在同一窗口内取值。
 */

import { describe, expect, it } from 'vitest';

import { NodeContract } from '../../../src/core/contracts/contracts.js';
import { NodeTypeRegistry } from '../../../src/core/registry/registry.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import {
  DEAD_NODE_MIN_AGE_DAYS,
  GOV_INVALIDATE,
  GOV_VERDICT_ALLOW,
  GOV_VERDICT_MERGE,
  GOV_VERDICT_REJECT,
  MERGE_COSINE_THRESHOLD,
  MERGE_JACCARD_THRESHOLD,
  POOL_CAPACITY_MAX,
  PROPOSAL_WEEKLY_BUDGET,
  PoolGovernance,
  PoolNodeSnapshot,
  at_capacity,
  dead_node_eligible,
  evaluate_proposal,
  fields_jaccard,
  invalidation_record,
  near_duplicate_by_embedding,
  near_duplicate_by_fields,
  pool_nodes_from_registry,
  proposal_budget_remaining,
  proposal_from_node_draft,
  weekly_proposal_usage,
} from '../../../src/core/pool_governance/pool_governance.js';

function _factory() {
  return () => async () => null;
}

function _spec(name: string, ...fields: SchemaField[]): SchemaSpec {
  return new SchemaSpec({ name, fields });
}

function _field(name: string, required = false): SchemaField {
  return new SchemaField({ name, required, kind: FIELD_STRING });
}

describe('容量上限', () => {
  it('test_capacity_threshold：容量上限边界（达上限即满）', () => {
    expect(POOL_CAPACITY_MAX).toBe(500);
    expect(at_capacity(499)).toBe(false);
    expect(at_capacity(500)).toBe(true);
    expect(at_capacity(501)).toBe(true);
  });

  it('test_eviction_required_when_full：满则须携带淘汰候选', () => {
    const verdict = evaluate_proposal('new_node', ['a', 'b'], {
      pool_count: 500,
      used_this_week: 0,
    });
    expect(verdict.verdict).toBe(GOV_VERDICT_ALLOW);
    expect(verdict.eviction_required).toBe(true);
    const notFull = evaluate_proposal('new_node', ['a', 'b'], {
      pool_count: 499,
      used_this_week: 0,
    });
    expect(notFull.eviction_required).toBe(false);
  });
});

describe('死结点淘汰', () => {
  it('test_dead_node_eligibility：零调用且未转正且超龄才淘汰', () => {
    expect(DEAD_NODE_MIN_AGE_DAYS).toBe(90);
    expect(dead_node_eligible(0, 91.0)).toBe(true);
    expect(dead_node_eligible(0, 90.0)).toBe(false);
    expect(dead_node_eligible(1, 200.0)).toBe(false);
    expect(dead_node_eligible(0, 200.0, { promoted: true })).toBe(false);
  });

  it('test_invalidation_record_is_mark_not_delete：标记失效不物理删', () => {
    const record = invalidation_record('old_node', '零调用且超龄');
    expect(record['action']).toBe(GOV_INVALIDATE);
    expect(record['node_id']).toBe('old_node');
    expect('reason' in record && 'ts' in record).toBe(true);
  });

  it('test_dead_candidates_listed_in_verdict：判定附带淘汰候选清单', () => {
    const nodes = [
      new PoolNodeSnapshot({ node_id: 'dead1', usage_count: 0, age_days: 200.0 }),
      new PoolNodeSnapshot({ node_id: 'alive', usage_count: 5, age_days: 200.0 }),
      new PoolNodeSnapshot({ node_id: 'dead2', usage_count: 0, age_days: 95.0 }),
    ];
    const verdict = evaluate_proposal('new_node', ['a'], {
      pool_count: 500,
      used_this_week: 0,
      pool_nodes: nodes,
    });
    expect(verdict.eviction_required).toBe(true);
    expect(verdict.eviction_candidates).toEqual(['dead1', 'dead2']);
  });
});

describe('近重复合并', () => {
  it('test_jaccard：字段 Jaccard 计算（空集 = 0 防除零）', () => {
    expect(fields_jaccard(['a', 'b'], ['a', 'b'])).toBe(1.0);
    expect(fields_jaccard(['a', 'b'], ['a'])).toBeCloseTo(0.5, 12);
    expect(fields_jaccard([], [])).toBe(0.0);
    expect(fields_jaccard(['a'], [])).toBe(0.0);
  });

  it('test_near_duplicate_thresholds：Jaccard>0.8 或余弦>0.9', () => {
    expect(MERGE_JACCARD_THRESHOLD).toBe(0.8);
    expect(MERGE_COSINE_THRESHOLD).toBe(0.9);
    expect(near_duplicate_by_fields(['a', 'b', 'c'], ['a', 'b', 'd'])).toBe(false);
    expect(near_duplicate_by_fields(['a', 'b', 'c'], ['a', 'b', 'c', 'd'])).toBe(false);
    expect(near_duplicate_by_fields(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e'])).toBe(false);
    expect(
      near_duplicate_by_fields(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e']),
    ).toBe(false);
    expect(
      near_duplicate_by_fields(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e', 'f']),
    ).toBe(true);
    expect(near_duplicate_by_embedding(0.9)).toBe(false);
    expect(near_duplicate_by_embedding(0.91)).toBe(true);
  });

  it('test_merge_verdict_by_fields_and_cosine：近重复转合并提案', () => {
    const nodes = [new PoolNodeSnapshot({ node_id: 'existing', fields: ['a', 'b', 'c', 'd', 'e'] })];
    const verdict = evaluate_proposal('new_node', ['a', 'b', 'c', 'd', 'e', 'f'], {
      pool_count: 10,
      used_this_week: 0,
      pool_nodes: nodes,
    });
    expect(verdict.verdict).toBe(GOV_VERDICT_MERGE);
    expect(verdict.merge_target).toBe('existing');
    const verdict2 = evaluate_proposal('new_node', ['x', 'y'], {
      pool_count: 10,
      used_this_week: 0,
      pool_nodes: nodes,
      duplicate_cosine: 0.95,
    });
    expect(verdict2.verdict).toBe(GOV_VERDICT_MERGE);
    expect(verdict2.merge_target).toBe('existing');
  });
});

describe('提案预算', () => {
  it('test_proposal_budget：3/周/域，负数按 0 计', () => {
    expect(PROPOSAL_WEEKLY_BUDGET).toBe(3);
    expect(proposal_budget_remaining(0)).toBe(3);
    expect(proposal_budget_remaining(2)).toBe(1);
    expect(proposal_budget_remaining(3)).toBe(0);
    expect(proposal_budget_remaining(5)).toBe(0);
  });

  it('test_budget_exhausted_reject：预算耗尽 = 拒绝', () => {
    const verdict = evaluate_proposal('new_node', ['a'], {
      pool_count: 10,
      used_this_week: 3,
    });
    expect(verdict.verdict).toBe(GOV_VERDICT_REJECT);
    expect(verdict.budget_remaining).toBe(0);
    expect(verdict.reasons.some((r) => r.includes('预算'))).toBe(true);
  });
});

describe('登记器', () => {
  it('test_pool_governance_records_verdicts：判定结果 append-only 登记', () => {
    const gov = new PoolGovernance();
    const verdict = gov.evaluate(
      { node_id: 'candidate', fields: ['a', 'b'] },
      { pool_count: 500, used_this_week: 1, pool_nodes: [] },
    );
    expect(verdict.verdict).toBe(GOV_VERDICT_ALLOW);
    expect(gov.log.length).toBe(1);
    expect(gov.log[0]!['node_id']).toBe('candidate');
    expect(gov.log[0]!['verdict']).toBe(GOV_VERDICT_ALLOW);
    gov.evaluate(
      { node_id: 'candidate2', fields: ['a', 'b'] },
      { pool_count: 10, used_this_week: 4, pool_nodes: [] },
    );
    expect(gov.log.length).toBe(2);
    expect(gov.log[1]!['verdict']).toBe(GOV_VERDICT_REJECT);
  });

  it('test_pool_governance_snapshot_objects：池快照可传对象或 dict', () => {
    const gov = new PoolGovernance();
    const nodes = [
      new PoolNodeSnapshot({ node_id: 'dup', fields: ['a', 'b', 'c', 'd', 'e'] }),
      { node_id: 'dict_node', usage_count: 0, age_days: 100.0 },
    ];
    const verdict = gov.evaluate(
      { node_id: 'candidate', fields: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { pool_count: 10, used_this_week: 0, pool_nodes: nodes },
    );
    expect(verdict.verdict).toBe(GOV_VERDICT_MERGE);
    expect(verdict.merge_target).toBe('dup');
    const verdict2 = gov.evaluate(
      { node_id: 'candidate2', fields: ['x'] },
      { pool_count: 500, used_this_week: 0, pool_nodes: nodes },
    );
    expect(verdict2.eviction_candidates).toContain('dict_node');
  });

  it('test_dead_node_records_derived_from_evictions：失效登记由判定派生', () => {
    const gov = new PoolGovernance();
    const nodes = [
      new PoolNodeSnapshot({ node_id: 'dead1', usage_count: 0, age_days: 200.0 }),
      new PoolNodeSnapshot({ node_id: 'alive', usage_count: 5, age_days: 200.0 }),
    ];
    gov.evaluate(
      { node_id: 'new_node', fields: ['a'] },
      { pool_count: 500, used_this_week: 0, pool_nodes: nodes },
    );
    const records = gov.dead_node_records();
    expect(records.map((r) => r['node_id'])).toEqual(['dead1']);
    expect(records.every((r) => r['action'] === GOV_INVALIDATE)).toBe(true);
    expect(records.every((r) => 'reason' in r && 'ts' in r)).toBe(true);
    gov.evaluate(
      { node_id: 'plain', fields: ['a'] },
      { pool_count: 10, used_this_week: 0, pool_nodes: [] },
    );
    expect(gov.dead_node_records()).toEqual(records);
    expect(gov.log.length).toBe(2);
  });
});

describe('接线辅助（提案归一 / 周预算 / 注册表快照）', () => {
  it('test_proposal_from_node_draft_normalizes：node_id=node_type，fields=产出字段', () => {
    const proposal = proposal_from_node_draft({
      node_type: 'web_search',
      output_schema: {
        name: 'web_search.output',
        fields: [
          { name: 'result', required: true },
          { name: 'sources', required: false },
        ],
      },
    });
    expect(proposal['node_id']).toBe('web_search');
    expect(new Set(proposal['fields'])).toEqual(new Set(['result', 'sources']));
  });

  it('test_proposal_from_node_draft_missing_schema_defaults_empty：缺省键空形态', () => {
    expect(proposal_from_node_draft({ node_type: 'x' })['node_id']).toBe('x');
    expect(proposal_from_node_draft({})['node_id']).toBe('');
    expect(proposal_from_node_draft({})['fields']).toEqual([]);
  });

  it('test_weekly_proposal_usage_window：时间窗口内条数（越窗不重复扣）', () => {
    const now = 1_750_000_000;
    const records = [
      { node_id: 'a', ts: now - 3600 },
      { node_id: 'b', ts: now - 6 * 86400 },
      { node_id: 'c', ts: now - 8 * 86400 },
      { node_id: 'd' },
    ];
    expect(weekly_proposal_usage(records, { now })).toBe(3);
    expect(weekly_proposal_usage(records, { now: now + 86400 })).toBe(3);
  });

  it('test_pool_nodes_from_registry_contracts_only：只取带契约类型', () => {
    const registry = new NodeTypeRegistry();
    registry.register('plain', _factory());
    registry.register(
      'with_contract',
      _factory(),
      new NodeContract({
        input_schema: _spec('in', _field('q', true)),
        output_schema: _spec('out', _field('result'), _field('extra')),
      }),
    );
    const nodes = pool_nodes_from_registry(registry);
    expect(nodes.map((n) => n.node_id)).toEqual(['with_contract']);
    expect(new Set(nodes[0]!.fields)).toEqual(new Set(['result', 'extra']));
  });

  it('test_governed_evaluate_rejects_when_budget_exhausted：四规则判定面闭环', () => {
    const now = 1_750_000_000;
    const gov = new PoolGovernance({ now: () => now });
    const record = {
      node_type: 'new_node',
      output_schema: {
        name: 'new_node.output',
        fields: [{ name: 'result', required: true }],
      },
    };
    for (let i = 0; i < 3; i += 1) {
      gov.evaluate(
        { node_id: 'old', fields: ['a'] },
        { pool_count: 1, used_this_week: 0, pool_nodes: [] },
      );
    }
    const snapshot = {
      pool_count: 2,
      used_this_week: weekly_proposal_usage(gov.log, { now }),
      pool_nodes: [],
    };
    const verdict = gov.evaluate(proposal_from_node_draft(record), snapshot);
    expect(verdict.verdict).toBe(GOV_VERDICT_REJECT);
    expect(verdict.reasons.some((r) => r.includes('预算'))).toBe(true);
  });
});
