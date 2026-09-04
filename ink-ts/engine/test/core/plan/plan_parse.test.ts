/**
 * 运行时重规划（__plan__）Plan.parse 单测：基础校验、顺序组展开、严格序。
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
import type { EdgeConditionRegistryLike } from '../../../src/core/graph/graph_types.js';

import { Plan } from '../../../src/core/plan/plan.js';
import { KIND_NODES, KIND_PARALLEL } from '../../../src/core/plan/plan.js';

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

function makeEdgeRegistry(conditions: Record<string, boolean> = {}): EdgeConditionRegistryLike {
  return {
    has: (name: string) => name in conditions,
    create: (_name: string) => () => true,
  };
}

// ── Plan.parse 基础校验 ──────────────────────────────────────────────────────

describe('Plan.parse 基础校验', () => {
  it('拒绝未知节点引用', () => {
    const graph = makeGraph();
    addRoute(graph);
    expect(() =>
      Plan.parse([{ nodes: ['ghost'] }], { graph }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ nodes: ['ghost'] }], { graph }),
    ).toThrow(/未知节点/);
  });

  it('多节点步中未知节点在建期拒绝', () => {
    const graph = makeGraph();
    addRoute(graph);
    graph.add_node('a', () => ({}));
    expect(() =>
      Plan.parse([{ nodes: ['a', 'ghost'] }], { graph }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ nodes: ['a', 'ghost'] }], { graph }),
    ).toThrow(/未知节点/);
  });

  it('条件未注册拒绝', () => {
    const graph = makeGraph();
    addRoute(graph);
    graph.add_node('a', () => ({}));
    graph.add_node('b', () => ({}));
    expect(() =>
      Plan.parse(
        [{ nodes: ['a', 'b'], condition: 'missing' }],
        { graph, edge_registry: makeEdgeRegistry() },
      ),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse(
        [{ nodes: ['a', 'b'], condition: 'missing' }],
        { graph, edge_registry: makeEdgeRegistry() },
      ),
    ).toThrow(/条件未注册/);
  });

  it('空计划/步数超限拒绝', () => {
    const graph = makeGraph();
    addRoute(graph);
    expect(() => Plan.parse([], { graph })).toThrow(GraphDefinitionError);
    expect(() => Plan.parse([], { graph })).toThrow(/为空/);
    expect(() =>
      Plan.parse([{ nodes: ['route'] }, { nodes: ['route'] }], { graph, max_steps: 1 }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ nodes: ['route'] }, { nodes: ['route'] }], { graph, max_steps: 1 }),
    ).toThrow(/超限/);
  });

  it('声明歧义：一步同时声明 nodes 与 parallel 拒绝', () => {
    const graph = makeGraph();
    addRoute(graph);
    expect(() =>
      Plan.parse([{ nodes: ['route'], parallel: ['route'] }], { graph }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ nodes: ['route'], parallel: ['route'] }], { graph }),
    ).toThrow(/恰好声明/);
  });
});

// ── Plan.parse 顺序组展开 ────────────────────────────────────────────────────

describe('Plan.parse 顺序组展开', () => {
  it('多节点顺序组展开为单节点步（每节点 checkpoint 粒度）', () => {
    const graph = makeGraph();
    addRoute(graph);
    graph.add_node('a', () => ({}));
    graph.add_node('b', () => ({}));
    const plan = Plan.parse([{ nodes: ['a', 'b'] }], { graph });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]!.kind).toBe(KIND_NODES);
    expect(plan.steps[0]!.nodes).toEqual(['a']);
    expect(plan.steps[1]!.nodes).toEqual(['b']);
  });

  it('并行组保持为单步（不展开）', () => {
    const graph = makeGraph();
    addRoute(graph);
    graph.add_node('a', () => ({}));
    graph.add_node('b', () => ({}));
    const plan = Plan.parse([{ parallel: ['a', 'b'] }], { graph });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.kind).toBe(KIND_PARALLEL);
    expect(plan.steps[0]!.nodes).toEqual(['a', 'b']);
  });
});

// ── Plan.parse 严格序 ────────────────────────────────────────────────────────

describe('Plan.parse 严格序', () => {
  it('相邻计划步无图边关联 → 拒绝', () => {
    const graph = makeGraph('g', 'route');
    graph.add_node('route', () => ({}));
    graph.add_node('a', () => ({}));
    graph.add_node('b', () => ({}));
    graph.add_edge('route', 'a');
    graph.add_exit('b');
    expect(() =>
      Plan.parse([{ nodes: ['a'] }, { nodes: ['b'] }], { graph, policy: 'strict' }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ nodes: ['a'] }, { nodes: ['b'] }], { graph, policy: 'strict' }),
    ).toThrow(/无边关联/);
  });

  it('有边关联的严格序计划通过', () => {
    const graph = makeGraph('g2', 'route');
    graph.add_node('route', () => ({}));
    graph.add_node('a', () => ({}));
    graph.add_node('b', () => ({}));
    graph.add_edge('route', 'a');
    graph.add_edge('a', 'b');
    graph.add_exit('b');
    const plan = Plan.parse([{ nodes: ['a'] }, { nodes: ['b'] }], { graph, policy: 'strict' });
    expect(plan.steps).toHaveLength(2);
  });

  it('并行组严格序：成员全部须与上一步关联', () => {
    const graph = makeGraph('g', 'route');
    graph.add_node('route', () => ({}));
    graph.add_node('a', () => ({}));
    graph.add_node('b', () => ({}));
    graph.add_edge('route', 'a');
    graph.add_exit('b');
    expect(() =>
      Plan.parse([{ nodes: ['a'] }, { parallel: ['b'] }], { graph, policy: 'strict' }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Plan.parse([{ nodes: ['a'] }, { parallel: ['b'] }], { graph, policy: 'strict' }),
    ).toThrow(/无边关联/);
  });

  it('并行组严格序通过：前一步所有成员与上一步有边', () => {
    const graph = makeGraph('g', 'route');
    graph.add_node('route', () => ({}));
    graph.add_node('a', () => ({}));
    graph.add_node('b', () => ({}));
    graph.add_edge('route', 'a');
    graph.add_edge('a', 'b');
    graph.add_exit('b');
    const plan = Plan.parse([{ nodes: ['a'] }, { parallel: ['b'] }], { graph, policy: 'strict' });
    expect(plan.steps).toHaveLength(2);
  });
});
