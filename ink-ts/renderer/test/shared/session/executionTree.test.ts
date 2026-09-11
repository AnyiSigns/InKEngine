/**
 * 执行树归组与形态判定测试（纯函数数据面 + 回执解析契约）。
 *
 * 测什么：
 * - parseExecutionReceipt：合法回执全字段归位 / 非法形态拒绝（fail-closed）/
 *   未知键与缺失可省字段容忍（前向兼容）；
 * - buildExecutionTree：run_id/parent_run_id 归组、父失联挂根、自环断开、
 *   事件按 run_id 归位、runs 缺失合成根；
 * - detectGroupForm：委托单路 = single；fan_out 并行 = 协作者组卡（席位/路数/
 *   归并契约采纳数）；意见块跨席位互读 = 圆桌审议卡；
 * - collectIssues/collectSubtreeIds/findPath/sumSubtreeCost：复盘展开与成本聚合。
 */

import type { ExecutionReceipt } from '@/shared/session/executionTypes';
import { parseExecutionReceipt, finalProductText } from '@/shared/session/executionTypes';
import {
  buildExecutionTree,
  collectIssues,
  collectSubtreeIds,
  detectGroupForm,
  findPath,
  sumSubtreeCost,
} from '@/shared/session/executionTree';

function fanOutReceipt(withCrossRead: boolean): ExecutionReceipt {
  return {
    run_id: 'r-main',
    blocked: false,
    block_reason: null,
    outcome: 'degraded',
    final_product: { conclusion: '综合结论' },
    degraded_summaries: ['worker_b 降级交付'],
    runs: [
      {
        run_id: 'r-main', parent_run_id: null, entry_scope: 'main', outcome: 'degraded',
        hops: [{ from: 'main', to: 'worker_a', shape: 'fan_out', commit: 'full', count: 2 }],
        cost: { steps: 3, tokens: 300 }, error: null,
      },
      {
        run_id: 'r-a', parent_run_id: 'r-main', entry_scope: 'worker_a', outcome: 'success',
        hops: [], cost: { steps: 1, tokens: 100 }, error: null,
      },
      {
        run_id: 'r-b', parent_run_id: 'r-main', entry_scope: 'worker_b', outcome: 'degraded',
        hops: [], cost: { steps: 1, tokens: 80 }, error: '超时降级',
      },
    ],
    events: [
      { run_id: 'r-main', parent_run_id: null, scope: 'main', action: 'route:fan_out', detail: null },
      { run_id: 'r-main', parent_run_id: null, scope: 'main', action: 'merge', detail: { contract: 'full', adopted: 2 } },
      { run_id: 'r-a', parent_run_id: 'r-main', scope: 'worker_a', action: 'whiteboard_audit', detail: { scope: 'worker_a', block_id: 'wb-2', kind: 'opinion', action: 'write' } },
      { run_id: 'r-b', parent_run_id: 'r-main', scope: 'worker_b', action: 'whiteboard_audit', detail: { scope: 'worker_b', block_id: 'wb-3', kind: 'opinion', action: 'write' } },
      ...(withCrossRead
        ? [{ run_id: 'r-b', parent_run_id: 'r-main', scope: 'worker_b', action: 'whiteboard_audit', detail: { scope: 'worker_b', block_id: 'wb-2', kind: 'opinion', action: 'read' } }]
        : []),
    ],
    trails: [],
  };
}

describe('parseExecutionReceipt（宿主 bridge 回执 → 镜像契约）', () => {
  it('合法回执归位全部消费字段', () => {
    const receipt = parseExecutionReceipt({
      run_id: 'r1',
      blocked: false,
      block_reason: null,
      outcome: 'success',
      final_product: { text: 'ok' },
      degraded_summaries: [],
      runs: [{ run_id: 'r1', parent_run_id: null, entry_scope: 'main', outcome: 'success', hops: [{ from: 'a', to: 'b', shape: 'delegate' }], cost: { ms: 5 }, error: null }],
      events: [{ run_id: 'r1', parent_run_id: null, scope: 'main', action: 'scope_turn', detail: { step: 1 } }],
      trails: [{ run_id: 'r1', entry_scope: 'main', outcome: 'success', hops: 1 }],
    });
    expect(receipt).not.toBeNull();
    expect(receipt!.runs[0].hops[0]).toEqual({ from: 'a', to: 'b', shape: 'delegate' });
    expect(receipt!.events[0].action).toBe('scope_turn');
    expect(receipt!.trails[0].hops).toBe(1);
  });

  it('fail-closed：缺 run_id / runs 非数组 / runs 条目缺 run_id → null', () => {
    expect(parseExecutionReceipt(null)).toBeNull();
    expect(parseExecutionReceipt({ runs: [] })).toBeNull();
    expect(parseExecutionReceipt({ run_id: 'r1', runs: 'oops' })).toBeNull();
    expect(parseExecutionReceipt({ run_id: 'r1', runs: [{ outcome: 'success' }] })).toBeNull();
  });

  it('前向兼容：未知键忽略、可省字段缺省、非法 outcome 落 failure', () => {
    const receipt = parseExecutionReceipt({
      run_id: 'r1',
      future_field: 42,
      runs: [{ run_id: 'r1', outcome: 'weird' }],
    });
    expect(receipt!.degraded_summaries).toEqual([]);
    expect(receipt!.runs[0].outcome).toBe('failure');
    expect(receipt!.runs[0].parent_run_id).toBeNull();
  });

  it('汇聚点产物文本投影优先键（无非空文本 = null）', () => {
    expect(finalProductText({ answer: ' 正文 ' })).toBe('正文');
    expect(finalProductText({ answer: '', text: '备选' })).toBe('备选');
    expect(finalProductText({ other: 1 })).toBeNull();
  });
});

describe('buildExecutionTree（run_id/parent_run_id 归组）', () => {
  it('父子成树 + 事件按 run_id 归位', () => {
    const [root] = buildExecutionTree(fanOutReceipt(false));
    expect(root.run.run_id).toBe('r-main');
    expect(root.children.map((c) => c.run.run_id)).toEqual(['r-a', 'r-b']);
    expect(root.events.map((e) => e.action)).toEqual(['route:fan_out', 'merge']);
    expect(root.children[1].events.some((e) => e.action === 'whiteboard_audit')).toBe(true);
    expect(collectSubtreeIds(root)).toEqual(['r-main', 'r-a', 'r-b']);
  });

  it('脏数据兜底：父失联挂根、自环断开、runs 缺失合成根', () => {
    const receipt = fanOutReceipt(false);
    receipt.runs.push({ run_id: 'r-orphan', parent_run_id: 'r-missing', entry_scope: 'lost', outcome: 'success', hops: [], cost: {}, error: null });
    receipt.runs.push({ run_id: 'r-loop', parent_run_id: 'r-loop', entry_scope: 'loop', outcome: 'success', hops: [], cost: {}, error: null });
    const [root] = buildExecutionTree(receipt);
    expect(root.children.map((c) => c.run.run_id)).toEqual(['r-a', 'r-b', 'r-orphan', 'r-loop']);
    const minimal = parseExecutionReceipt({ run_id: 'r9', runs: [] })!;
    const [synth] = buildExecutionTree(minimal);
    expect(synth.run.run_id).toBe('r9');
    expect(synth.run.outcome).toBe('success');
  });

  it('findPath 祖先链 / 未知 id = null', () => {
    const [root] = buildExecutionTree(fanOutReceipt(false));
    expect(findPath(root, 'r-b')!.map((n) => n.run.run_id)).toEqual(['r-main', 'r-b']);
    expect(findPath(root, 'nope')).toBeNull();
  });

  it('sumSubtreeCost 聚合自身与后代成本', () => {
    const [root] = buildExecutionTree(fanOutReceipt(false));
    expect(sumSubtreeCost(root)).toMatchObject({ steps: 5, tokens: 480 });
  });
});

describe('detectGroupForm（组卡形态判定 §7.4.6）', () => {
  it('委托单路 = 普通 run 卡', () => {
    const receipt = parseExecutionReceipt({
      run_id: 'r1',
      runs: [
        { run_id: 'r1', parent_run_id: null, entry_scope: 'main', outcome: 'success', hops: [{ from: 'main', to: 'helper', shape: 'delegate' }], cost: {} },
        { run_id: 'r2', parent_run_id: 'r1', entry_scope: 'helper', outcome: 'success', hops: [], cost: {} },
      ],
      events: [],
    })!;
    const [root] = buildExecutionTree(receipt);
    expect(detectGroupForm(root).form).toBe('single');
  });

  it('fan_out 并行互不可见 = 协作者组卡（席位/路数/归并契约）', () => {
    const [root] = buildExecutionTree(fanOutReceipt(false));
    const group = detectGroupForm(root);
    expect(group.form).toBe('collab_group');
    expect(group.lanes).toBe(2);
    expect(group.seats.map((s) => s.scope)).toEqual(['worker_a', 'worker_b']);
    expect(group.mergeContract).toBe('full');
    expect(group.adopted).toBe(2);
  });

  it('意见块跨席位互读 = 圆桌审议卡', () => {
    const [root] = buildExecutionTree(fanOutReceipt(true));
    const group = detectGroupForm(root);
    expect(group.form).toBe('roundtable');
    expect(group.opinions.some((o) => o.action === 'read')).toBe(true);
  });
});

describe('collectIssues（前台摘要数据源）', () => {
  it('失败/降级子执行收集（根不入列）', () => {
    const [root] = buildExecutionTree(fanOutReceipt(false));
    const issues = collectIssues(root);
    expect(issues).toHaveLength(1);
    expect(issues[0].run.run_id).toBe('r-b');
    expect(issues[0].reason).toBe('超时降级');
  });

  it('全绿树 = 空清单', () => {
    const receipt = fanOutReceipt(false);
    receipt.runs.forEach((run) => { run.outcome = 'success'; run.error = null; });
    const [root] = buildExecutionTree(receipt);
    expect(collectIssues(root)).toEqual([]);
  });
});
