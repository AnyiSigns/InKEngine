/**
 * 汇流裁决 + 归因 + Junction 节点测（test_multipath.py 汇流/归因/Junction
 * 节点段 1:1 移植）：
 * 同构判定 / 质量闸门过者胜 / 无闸门降级链（信任档 → 成本）/ 异构合成与
 * 无源降级 / 归因规则（胜者全边成功、败者只记收尾入边失败）/ 证据更新
 * 落库往返 / Junction 节点类型注册 + 重复拒绝 + 节点直接执行（数据形态
 * 支流清单经状态通道）。
 *
 * 引擎执行器接线类用例（executor 未迁移）已 defer（见本文尾注）。Junction
 * 节点执行以「节点函数直接调用」覆盖（数据形态语义与 engine._execute 同
 * 构）；engine 驱动整图执行的收口断言 defer。
 */

import { describe, expect, it } from 'vitest';

import { EdgeEvidenceStore } from '../../../src/core/edge_evidence/index.js';
import { EVENT_AUDIT_JUNCTION } from '../../../src/core/event_types/eventTypeSpecs.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';
import { NodeTypeRegistry } from '../../../src/core/registry/registry.js';
import {
  ChainEvidence,
  EdgeRef,
  JUNCTION_BRANCHES_STATE_KEY,
  JUNCTION_TYPE,
  JunctionBranch,
  MODE_QUALITY_GATE,
  MODE_SYNTHETIC,
  MODE_TIER,
  UPDATE_FAIL,
  UPDATE_SUCCESS,
  JunctionEvidenceUpdate,
  JunctionExecutor,
  apply_junction_updates,
  branches_are_homogeneous,
  junction_verdict,
  plan_junction_updates,
  register_junction_node,
} from '../../../src/core/multipath/index.js';
import {
  DOMAIN,
  DUMMY_NOW,
  StubGate,
  StubSynth,
  branch,
  edge_key,
} from './helpers.js';

describe('同构判定', () => {
  it('test_junction_homogeneous_and_heterogeneous_detection：收尾字段集一致 = 同构', () => {
    const same = [0, 1].map((i) =>
      branch(i, { overlay: { answer: 'x' }, terminal_fields: ['answer'] }),
    );
    expect(branches_are_homogeneous(same)).toBe(true);
    const diff = [
      branch(0, { overlay: { answer: 'x' }, terminal_fields: ['answer'] }),
      branch(1, { overlay: { doc: 'y' }, terminal_fields: ['doc'] }),
    ];
    expect(branches_are_homogeneous(diff)).toBe(false);
  });
});

describe('汇流裁决三断言', () => {
  it('test_junction_quality_gate_decides_winner：过关支流胜出，理由/败者留痕', async () => {
    const branches = ['A', 'B'].map((value, i) =>
      branch(i, { overlay: { answer: value } }),
    );
    const gate = new StubGate((artifact) => artifact['answer'] === 'B');
    const verdict = await junction_verdict(branches, { domain: DOMAIN, quality_gate: gate });
    expect(verdict.mode).toBe(MODE_QUALITY_GATE);
    expect(verdict.winner).toBe(1);
    expect(verdict.selection).toEqual({ answer: 'B' });
    expect(verdict.losers).toEqual([0]);
    expect(gate.calls.length).toBe(2);
    expect(verdict.reasons.some((r) => r.includes('质量闸门过者胜'))).toBe(true);
  });

  it('test_junction_no_gate_degrades_tier_then_cost：信任档优先，再比成本', async () => {
    const regular_expensive = new ChainEvidence({
      edges: 1,
      evidenced: 1,
      success_total: 8,
      fail_total: 0,
      cost_total: 100.0,
    });
    const observing_cheap = new ChainEvidence({
      edges: 1,
      evidenced: 1,
      success_total: 3,
      fail_total: 2,
      cost_total: 1.0,
    });
    const branches = [
      branch(0, { overlay: { answer: 'A' }, evidence: regular_expensive }),
      branch(1, { overlay: { answer: 'B' }, evidence: observing_cheap }),
    ];
    const verdict = await junction_verdict(branches, { domain: DOMAIN });
    expect(verdict.mode).toBe(MODE_TIER);
    expect(verdict.winner).toBe(0); // 信任档优先（常规 > 观察），成本不顶档
    // 同档比成本：常规档内部成本低者胜（确定性）
    const tie = [
      branch(0, {
        overlay: { answer: 'A' },
        evidence: new ChainEvidence({
          edges: 1,
          evidenced: 1,
          success_total: 9,
          fail_total: 1,
          cost_total: 900.0,
        }),
      }),
      branch(1, {
        overlay: { answer: 'B' },
        evidence: new ChainEvidence({
          edges: 1,
          evidenced: 1,
          success_total: 9,
          fail_total: 1,
          cost_total: 1.0,
        }),
      }),
    ];
    const tied_verdict = await junction_verdict(tie, { domain: DOMAIN });
    expect(tied_verdict.winner).toBe(1);
    expect(tied_verdict.reasons.some((r) => r.includes('比成本'))).toBe(true);
  });

  it('test_junction_heterogeneous_synthesizes：异构合成；无源降级信任档', async () => {
    const branches = [
      branch(0, { overlay: { answer: 'A' }, terminal_fields: ['answer'] }),
      branch(1, { overlay: { doc: 'D' }, terminal_fields: ['doc'] }),
    ];
    const synth = new StubSynth({ answer: 'merged', doc: 'merged' });
    const verdict = await junction_verdict(branches, { domain: DOMAIN, synth_provider: synth });
    expect(verdict.mode).toBe(MODE_SYNTHETIC);
    expect(verdict.winner).toBeNull();
    expect(verdict.selection).toEqual({ answer: 'merged', doc: 'merged' });
    expect(synth.calls.length).toBe(1);
    expect(synth.calls[0]!.domain).toBe(DOMAIN);
    // 无合成源 → 降级信任档（同信任档比成本 → 序号）
    const degraded = await junction_verdict(branches, { domain: DOMAIN });
    expect(degraded.mode).toBe(MODE_TIER);
    expect(degraded.winner).not.toBeNull();
    expect(degraded.reasons.some((r) => r.includes('未注入合成源'))).toBe(true);
  });
});

describe('归因规则（失败只记失败结点入边）', () => {
  it('test_attribution_failure_only_tail_failed_node_incoming_edge：败者只记收尾入边', async () => {
    const winner_branch = new JunctionBranch({
      index: 0,
      chain: ['a', 'b', 'c'],
      overlay: { answer: 'A' },
      terminal_fields: ['answer'],
      edge_refs: [new EdgeRef('a', 'b', '1', '1'), new EdgeRef('b', 'c', '1', '1')],
    });
    const loser_branch = new JunctionBranch({
      index: 1,
      chain: ['a', 'b', 'd'],
      overlay: { answer: 'B' },
      terminal_fields: ['answer'],
      edge_refs: [new EdgeRef('a', 'b', '1', '1'), new EdgeRef('b', 'd', '1', '1')],
    });
    const verdict = await junction_verdict([winner_branch, loser_branch], { domain: DOMAIN });
    expect(verdict.winner).toBe(0);
    const updates = plan_junction_updates(verdict, [winner_branch, loser_branch], {
      domain: DOMAIN,
    });
    const kinds = updates.map((u) => `${u.key.src_type}|${u.key.dst_type}|${u.kind}`);
    // 胜者：全边成功（a→b 与 b→c 各 +1）
    expect(kinds).toContain(`a|b|${UPDATE_SUCCESS}`);
    expect(kinds).toContain(`b|c|${UPDATE_SUCCESS}`);
    // 败者：只记失败结点入边（b→d 失败 +1），上游边 a→b 无失败记录
    expect(kinds).toContain(`b|d|${UPDATE_FAIL}`);
    expect(updates.filter((u) => u.kind === UPDATE_FAIL && u.key.src_type === 'a')).toEqual([]);
    expect(updates.filter((u) => u.kind === UPDATE_FAIL).length).toBe(1);
  });

  it('test_apply_junction_updates_roundtrip：success/fail 各自归集（可断言计数）', async () => {
    const store = new EdgeEvidenceStore();
    const updates = [
      new JunctionEvidenceUpdate(edge_key('a', 'b'), UPDATE_SUCCESS),
      new JunctionEvidenceUpdate(edge_key('b', 'c'), UPDATE_FAIL),
    ];
    const applied = await apply_junction_updates(store, updates, { now: DUMMY_NOW });
    expect(applied).toBe(2);
    const row_ab = await store.get(edge_key('a', 'b'));
    expect(row_ab).not.toBeNull();
    expect(row_ab!.success_count).toBe(1);
    expect(row_ab!.fail_count).toBe(0);
    const row_bc = await store.get(edge_key('b', 'c'));
    expect(row_bc).not.toBeNull();
    expect(row_bc!.fail_count).toBe(1);
    await store.close();
  });
});

describe('Junction 节点类型', () => {
  it('test_junction_node_type_registered_and_executes：注册/重复拒绝 + 数据形态可执行裁决', async () => {
    const registry = new NodeTypeRegistry();
    const records: Record<string, unknown>[] = [];
    const executor = new JunctionExecutor({
      now: DUMMY_NOW,
      sink: (record) => records.push(record),
    });
    register_junction_node(registry, { executor });
    expect(registry.has(JUNCTION_TYPE)).toBe(true);
    expect(() => register_junction_node(registry)).toThrow(GraphDefinitionError);
    const node = registry.create(JUNCTION_TYPE, {});
    const entry_state = {
      [JUNCTION_BRANCHES_STATE_KEY]: [
        branch(0, { overlay: { answer: 'A' } }).to_dict(),
        branch(1, { overlay: { answer: 'B' } }).to_dict(),
      ],
      domain: DOMAIN,
      goal: ['answer'],
    };
    const overlay = await node({ state: entry_state });
    const verdict_state = overlay!['multipath.verdict'] as Record<string, unknown>;
    expect(verdict_state['winner']).toBe(0); // 同档缺成本 → 序号最小者
    expect(verdict_state['mode']).toBe(MODE_TIER);
    // 胜者产物回流（selection = 胜者整体提交）
    expect(overlay!['answer']).toBe('A');
    // 审计留痕（junction 事件类型）
    expect(records.length).toBe(1);
    expect(records[0]!['type']).toBe(EVENT_AUDIT_JUNCTION);
    expect(records[0]!['winner']).toBe(0);
  });
});
