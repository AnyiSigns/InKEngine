/**
 * 运行时重规划（__plan__）Plan.parse 单测：工作流约束域、信封形态与策略、spawn 项校验。
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
import { WorkflowEdgeSpec, WorkflowNodeSpec, WorkflowSpec } from '../../../src/core/workflow/workflow_types.js';

import { Plan } from '../../../src/core/plan/plan.js';

// ── 工厂 ──────────────────────────────────────────────────────────────────────

function makeGraph(name = 'plan', entry = 'route'): Graph {
  return new Graph({ name, entry });
}

function addRoute(graph: Graph): void {
  graph.add_node('route', () => ({}));
}

function addNodes(graph: Graph, names: string[]): void {
  for (const name of names) {
    graph.add_node(name, () => ({}));
  }
}

function makeWorkflow(
  nodeIds: string[],
  edges: Array<[string, string]> = [],
): WorkflowSpec {
  return new WorkflowSpec({
    name: 'wf',
    nodes: nodeIds.map((id) => new WorkflowNodeSpec({ id, type: 't' })),
    edges: edges.map(([source, target]) => new WorkflowEdgeSpec({ source, target })),
  });
}

// ── Plan.parse 工作流约束域 ──────────────────────────────────────────────────

describe('Plan.parse 工作流约束域', () => {
  it('宽松域：计划节点落在工作流节点集内通过', () => {
    const graph = makeGraph('g', 'a');
    addNodes(graph, ['a', 'b', 'c']);
    graph.add_exit('c');
    const workflow = makeWorkflow(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    const plan = Plan.parse([{ nodes: ['c'] }, { nodes: ['a'] }], { graph, workflow });
    expect(plan.steps).toHaveLength(2);
  });

  it('宽松域拒绝域外节点', () => {
    const graph = makeGraph('g', 'a');
    addNodes(graph, ['a', 'ghost']);
    graph.add_exit('ghost');
    const workflow = makeWorkflow(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    expect(() =>
      Plan.parse([{ nodes: ['ghost'] }], { graph, workflow }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ nodes: ['ghost'] }], { graph, workflow }),
    ).toThrow(/工作流约束域外/);
  });

  it('严格序 + 工作流：按序工作流边关联通过', () => {
    const graph = makeGraph('g', 'a');
    addNodes(graph, ['a', 'b', 'c']);
    graph.add_exit('c');
    const workflow = makeWorkflow(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    const plan = Plan.parse(
      [{ nodes: ['a'] }, { nodes: ['b'] }, { nodes: ['c'] }],
      { graph, policy: 'strict', workflow },
    );
    expect(plan.steps).toHaveLength(3);
  });

  it('严格序 + 工作流拒绝无工作流边关联（图有边也不放行）', () => {
    const graph = makeGraph('g', 'a');
    addNodes(graph, ['a', 'b', 'c', 'x']);
    graph.add_edge('a', 'b');
    graph.add_edge('b', 'x');
    graph.add_exit('x');
    const workflow = makeWorkflow(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    expect(() =>
      Plan.parse([{ nodes: ['a'] }, { nodes: ['b'] }, { nodes: ['x'] }], { graph, policy: 'strict', workflow }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ nodes: ['a'] }, { nodes: ['b'] }, { nodes: ['x'] }], { graph, policy: 'strict', workflow }),
    ).toThrow(/工作流约束域/);
  });
});

// ── Plan.parse 信封形态与策略 ────────────────────────────────────────────────

describe('Plan.parse 信封形态与策略', () => {
  it('兼容 {steps: [...]} 信封形态', () => {
    const graph = makeGraph();
    addRoute(graph);
    graph.add_node('a', () => ({}));
    const plan = Plan.parse({ steps: [{ nodes: ['a'] }] }, { graph });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.nodes).toEqual(['a']);
  });

  it('未知策略拒绝', () => {
    const graph = makeGraph();
    addRoute(graph);
    expect(() =>
      Plan.parse([{ nodes: ['route'] }], { graph, policy: 'unknown' }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ nodes: ['route'] }], { graph, policy: 'unknown' }),
    ).toThrow(/未知计划策略/);
  });
});

// ── Plan.parse spawn 项校验 ──────────────────────────────────────────────────

describe('Plan.parse spawn 项校验', () => {
  it('缺 subgraph 拒绝', () => {
    const graph = makeGraph();
    addRoute(graph);
    expect(() =>
      Plan.parse([{ spawns: [{ state: {} }] }], { graph }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ spawns: [{ state: {} }] }], { graph }),
    ).toThrow(/缺 subgraph/);
  });

  it('序号非法拒绝', () => {
    const graph = makeGraph();
    addRoute(graph);
    expect(() =>
      Plan.parse([{ spawns: [{ subgraph: { name: 's' }, index: 'bad' }] }], { graph }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ spawns: [{ subgraph: { name: 's' }, index: 'bad' }] }], { graph }),
    ).toThrow(/序号非法/);
  });

  it('state 非 dict 拒绝', () => {
    const graph = makeGraph();
    addRoute(graph);
    expect(() =>
      Plan.parse([{ spawns: [{ subgraph: { name: 's' }, state: 'bad', index: 0 }] }], { graph }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ spawns: [{ subgraph: { name: 's' }, state: 'bad', index: 0 }] }], { graph }),
    ).toThrow(/状态须为 dict/);
  });
});
