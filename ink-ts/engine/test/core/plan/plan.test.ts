/**
 * 运行时重规划（__plan__）单测：Plan/PlanStep 构造与校验、往返序列化。
 *
 * 以下引擎执行联跑测试已推迟（依赖 conftest.make_engine 与 Engine 执行路径，当前 TS
 * 执行器尚未就绪；共 28 项）：
 *   - test_plan_nodes_run_in_order
 *   - test_plan_then_edge_walk_continues
 *   - test_plan_key_not_leaked_into_state
 *   - test_parallel_group_merges_in_order
 *   - test_parallel_group_same_key_last_wins
 *   - test_parallel_member_terminate_keeps_overlay
 *   - test_parallel_member_plan_key_popped
 *   - test_condition_gate_skips_step
 *   - test_plan_spawn_step_expands_instances
 *   - test_plan_spawn_with_data_subgraph
 *   - test_plan_checkpoint_carries_snapshot
 *   - test_plan_resume_from_completed_checkpoint
 *   - test_plan_parallel_interrupt_resume_reenters_work_step
 *   - test_plan_work_step_marker_in_checkpoint
 *   - test_plan_disabled_on_resume_ignores_stored_plan
 *   - test_continue_chain_and_resume_mutually_exclusive
 *   - test_plan_spawn_step_max_spawns_guard
 *   - test_plan_spawn_step_error_terminates_by_default
 *   - test_plan_interrupt_resume_reenters_plan
 *   - test_plan_resume_mid_plan_skips_completed
 *   - test_plan_parallel_interrupt_propagates
 *   - test_plan_parallel_error_terminates_by_default
 *   - test_plan_parallel_error_skips_failed
 *   - test_plan_workflow_domain_via_run_options
 *   - test_plan_disabled_rejects_plan
 *   - test_invalid_plan_fails_node
 *   - test_plan_in_subgraph_and_instance
 *   - test_plan_update_state_keeps_plan_snapshot
 * 推迟原因：依赖 make_engine 构造 Engine 实例并调用 _execute 跑完整回合，
 * 涉及 memory_storage / interrupt / checkpoint / spawn 展开等执行语义，当前
 * TS 执行器尚未移植；待 executor 模块就绪后补跑。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { Graph } from '../../../src/core/graph/graph.js';

import {
  DEFAULT_MAX_PLAN_STEPS,
  KIND_NODES,
  KIND_PARALLEL,
  KIND_SPAWNS,
  PLAN_KEY,
  Plan,
  PlanStep,
} from '../../../src/core/plan/plan.js';

// ── 工厂 ──────────────────────────────────────────────────────────────────────

function makeGraph(name = 'plan', entry = 'route'): Graph {
  return new Graph({ name, entry });
}

function addRoute(graph: Graph): void {
  graph.add_node('route', () => ({}));
}

// ── PlanStep 构造与类型 ───────────────────────────────────────────────────────

describe('PlanStep 构造与类型', () => {
  it('默认构造：kind 必填，nodes/spawns/condition 缺省为空/None', () => {
    const step = new PlanStep({ kind: KIND_NODES });
    expect(step.kind).toBe(KIND_NODES);
    expect(step.nodes).toEqual([]);
    expect(step.spawns).toEqual([]);
    expect(step.condition).toBeNull();
  });

  it('顺序节点组：携带节点名列表', () => {
    const step = new PlanStep({ kind: KIND_NODES, nodes: ['a', 'b'] });
    expect(step.nodes).toEqual(['a', 'b']);
  });

  it('并行组：携带节点名列表', () => {
    const step = new PlanStep({ kind: KIND_PARALLEL, nodes: ['x', 'y'] });
    expect(step.nodes).toEqual(['x', 'y']);
  });

  it('spawn 步：携带子图实例清单', () => {
    const spawns = [{ subgraph: { name: 'sub' }, state: {}, index: 0 }];
    const step = new PlanStep({ kind: KIND_SPAWNS, spawns });
    expect(step.spawns).toEqual(spawns);
  });

  it('条件门：携带条件名', () => {
    const step = new PlanStep({ kind: KIND_NODES, nodes: ['a'], condition: 'cond' });
    expect(step.condition).toBe('cond');
  });

  it('实例不可变：构造后字段不可写', () => {
    const step = new PlanStep({ kind: KIND_NODES, nodes: ['a'] });
    expect(() => { (step.nodes as string[]).push('b'); }).toThrow();
  });
});

// ── PlanStep 序列化往返 ──────────────────────────────────────────────────────

describe('PlanStep 序列化往返', () => {
  it('nodes 步往返：节点列表保持不变', () => {
    const step = new PlanStep({ kind: KIND_NODES, nodes: ['a', 'b'] });
    const rebuilt = PlanStep.fromDict(step.toDict());
    expect(rebuilt.kind).toBe(KIND_NODES);
    expect(rebuilt.nodes).toEqual(['a', 'b']);
    expect(rebuilt.condition).toBeNull();
  });

  it('parallel 步往返：节点列表保持不变', () => {
    const step = new PlanStep({ kind: KIND_PARALLEL, nodes: ['x', 'y'] });
    const rebuilt = PlanStep.fromDict(step.toDict());
    expect(rebuilt.kind).toBe(KIND_PARALLEL);
    expect(rebuilt.nodes).toEqual(['x', 'y']);
  });

  it('spawn 步往返：子图数据保持', () => {
    const subgraph = { name: 'sub', entry: 's1' };
    const step = new PlanStep({ kind: KIND_SPAWNS, spawns: [{ subgraph, state: {}, index: 0 }] });
    const rebuilt = PlanStep.fromDict(step.toDict());
    expect(rebuilt.kind).toBe(KIND_SPAWNS);
    expect(rebuilt.spawns).toEqual([{ subgraph: { name: 'sub', entry: 's1' }, state: {}, index: 0 }]);
  });

  it('条件门往返：条件名保持不变', () => {
    const step = new PlanStep({ kind: KIND_NODES, nodes: ['a'], condition: 'cond' });
    const rebuilt = PlanStep.fromDict(step.toDict());
    expect(rebuilt.condition).toBe('cond');
  });

  it('Graph 实例兜底序列化：spawn 项中的 Graph 自动转为 dict', () => {
    const graph = makeGraph('sub', 's1');
    graph.add_node_type('s1', 'fn', {});
    graph.add_exit('s1');
    const step = new PlanStep({
      kind: KIND_SPAWNS,
      spawns: [{ subgraph: graph, state: {}, index: 0 }],
    });
    const dict = step.toDict();
    const spawns = dict[KIND_SPAWNS] as Record<string, unknown>[];
    expect(spawns[0]!.subgraph).toEqual(graph.to_dict());
  });
});

// ── PlanStep.fromDict 校验 ────────────────────────────────────────────────────

describe('PlanStep.fromDict 校验', () => {
  it('缺省：恰好一个 kind 键才合法', () => {
    expect(() => PlanStep.fromDict({})).toThrow(GraphDefinitionError);
    expect(() => PlanStep.fromDict({ nodes: ['a'], parallel: ['b'] })).toThrow(GraphDefinitionError);
  });

  it('nodes/spawns 值须为字符串列表', () => {
    expect(() => PlanStep.fromDict({ nodes: 'a' })).toThrow(GraphDefinitionError);
    expect(() => PlanStep.fromDict({ nodes: [1] })).toThrow(GraphDefinitionError);
    expect(() => PlanStep.fromDict({ spawns: 'bad' })).toThrow(GraphDefinitionError);
  });

  it('nodes 列表非空', () => {
    expect(() => PlanStep.fromDict({ nodes: [] })).toThrow(GraphDefinitionError);
  });

  it('spawn 项须为 dict 列表', () => {
    expect(() => PlanStep.fromDict({ spawns: ['bad'] })).toThrow(GraphDefinitionError);
  });

  it('条件名须为字符串', () => {
    expect(() => PlanStep.fromDict({ nodes: ['a'], condition: 123 })).toThrow(GraphDefinitionError);
  });
});

// ── Plan 构造与属性 ──────────────────────────────────────────────────────────

describe('Plan 构造与属性', () => {
  it('默认构造：steps 为空，index 为 0', () => {
    const plan = new Plan({});
    expect(plan.steps).toEqual([]);
    expect(plan.index).toBe(0);
  });

  it('remaining：当前游标之后的切片', () => {
    const steps = [
      new PlanStep({ kind: KIND_NODES, nodes: ['a'] }),
      new PlanStep({ kind: KIND_NODES, nodes: ['b'] }),
      new PlanStep({ kind: KIND_NODES, nodes: ['c'] }),
    ];
    const plan = new Plan({ steps, index: 1 });
    expect(plan.remaining).toHaveLength(2);
    expect(plan.remaining[0]!.nodes).toEqual(['b']);
    expect(plan.remaining[1]!.nodes).toEqual(['c']);
  });

  it('remaining 在末尾为空', () => {
    const steps = [new PlanStep({ kind: KIND_NODES, nodes: ['a'] })];
    const plan = new Plan({ steps, index: 1 });
    expect(plan.remaining).toEqual([]);
  });
});

// ── Plan 序列化往返 ──────────────────────────────────────────────────────────

describe('Plan 序列化往返', () => {
  it('往返后 steps 与 index 保持不变', () => {
    const steps = [
      new PlanStep({ kind: KIND_NODES, nodes: ['a'] }),
      new PlanStep({ kind: KIND_NODES, nodes: ['b'], condition: 'cond' }),
      new PlanStep({ kind: KIND_SPAWNS, spawns: [{ subgraph: { name: 's' }, index: 0 }] }),
    ];
    const plan = new Plan({ steps, index: 1 });
    const rebuilt = Plan.fromDict(plan.toDict());
    expect(rebuilt.steps).toHaveLength(3);
    expect(rebuilt.steps[0]!.nodes).toEqual(['a']);
    expect(rebuilt.steps[1]!.condition).toBe('cond');
    expect(rebuilt.steps[2]!.kind).toBe(KIND_SPAWNS);
    expect(rebuilt.index).toBe(1);
  });

  it('fromDict 拒绝缺 steps', () => {
    expect(() => Plan.fromDict({})).toThrow(GraphDefinitionError);
    expect(() => Plan.fromDict({ steps: 'bad' })).toThrow(GraphDefinitionError);
  });

  it('fromDict 拒绝游标越界', () => {
    const steps = [new PlanStep({ kind: KIND_NODES, nodes: ['a'] })];
    const plan = new Plan({ steps, index: 0 });
    const dict = plan.toDict();
    expect(() => Plan.fromDict({ ...dict, index: -1 })).toThrow(GraphDefinitionError);
    expect(() => Plan.fromDict({ ...dict, index: 2 })).toThrow(GraphDefinitionError);
  });
});

// ── 常量与保留键 ─────────────────────────────────────────────────────────────

describe('常量与保留键', () => {
  it('DEFAULT_MAX_PLAN_STEPS = 32', () => {
    expect(DEFAULT_MAX_PLAN_STEPS).toBe(32);
  });

  it('PLAN_KEY 保留键', () => {
    expect(PLAN_KEY).toBe('__plan__');
  });

  it('步骤类型常量', () => {
    expect(KIND_NODES).toBe('nodes');
    expect(KIND_PARALLEL).toBe('parallel');
    expect(KIND_SPAWNS).toBe('spawns');
  });
});
