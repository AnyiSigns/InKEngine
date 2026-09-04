/**
 * 声明式工作流编译单测：入口推导/出口标记/建图期校验/类型解析/图编译通过。
 *
 * 以下两项需引擎执行体联跑的测试已推迟（依赖 conftest.make_engine 与 Engine 执行路径）：
 *   - test_linear_spec_compiles_and_runs
 *   - test_fanout_spec_runs_parallel_branch
 * 推迟原因：make_engine 构造 Engine 实例并调用 _execute 跑完整回合，当前 TS
 * 执行器尚未就绪；待 cli/engine 执行层移植后补跑。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { NodeTypeRegistry } from '../../../src/core/registry/registry.js';
import { build_workflow_graph } from '../../../src/core/workflow/workflow.js';
import { WorkflowEdgeSpec, WorkflowNodeSpec, WorkflowSpec } from '../../../src/core/workflow/workflow_types.js';

// ── demo 工厂 ────────────────────────────────────────────────────────────────

function countingFactory(tag: string) {
  return (config: Record<string, unknown>) => {
    const raw = config['value'];
    const value = typeof raw === 'number' ? raw : 0;
    return async () => ({ value, tag });
  };
}

function makeRegistry(): NodeTypeRegistry {
  const registry = new NodeTypeRegistry();
  registry.register('write', countingFactory('write'));
  registry.register('audit', countingFactory('audit'));
  return registry;
}

function spec(
  name: string,
  nodes: Array<[string, string, Record<string, unknown>]>,
  edges: Array<[string, string]>,
  entry: string | null = null,
): WorkflowSpec {
  return new WorkflowSpec({
    name,
    nodes: nodes.map(([id, type, config]) => new WorkflowNodeSpec({ id, type, config })),
    edges: edges.map(([source, target]) => new WorkflowEdgeSpec({ source, target })),
    entry,
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('工作流编译：纯结构/建图期校验', () => {
  it('线性规格：入口推断 + 出口标记', () => {
    const s = spec('linear', [['writer', 'write', { value: 1 }], ['auditor', 'audit', { value: 2 }]], [
      ['writer', 'auditor'],
    ]);
    const graph = build_workflow_graph(s, makeRegistry());
    expect(graph.entry).toBe('writer');
    expect(graph.exits.has('auditor')).toBe(true);
  });

  it('显式入口被使用', () => {
    const s = spec('explicit', [['b', 'write', {}], ['a', 'write', {}]], [['a', 'b']], 'a');
    const graph = build_workflow_graph(s, makeRegistry());
    expect(graph.entry).toBe('a');
  });

  it('入口节点不在节点列表 → GraphDefinitionError', () => {
    const s = spec('bad-entry', [['a', 'write', {}]], [], 'missing');
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow(GraphDefinitionError);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow('入口节点不存在: missing');
  });

  it('多无入边节点且未声明入口 → 入口歧义拒绝', () => {
    const s = spec('ambiguous', [['a', 'write', {}], ['b', 'write', {}]], []);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow(GraphDefinitionError);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow('入口歧义');
  });

  it('循环依赖 → 建图期拒绝', () => {
    const s = spec('cycle', [['a', 'write', {}], ['b', 'write', {}]], [
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow(GraphDefinitionError);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow('循环依赖');
  });

  it('自环 → 建图期拒绝', () => {
    const s = spec('self-loop', [['a', 'write', {}]], [['a', 'a']]);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow(GraphDefinitionError);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow('循环依赖');
  });

  it('重复节点 id → 建图期拒绝', () => {
    const s = spec('dup', [['a', 'write', {}], ['a', 'audit', {}]], []);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow(GraphDefinitionError);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow('id 重复');
  });

  it('未知节点类型 → 建图期拒绝', () => {
    const s = spec('unknown-type', [['a', 'not_registered', {}]], []);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow(GraphDefinitionError);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow('未知节点类型');
  });

  it('悬空边（目标节点不存在）→ 建图期拒绝', () => {
    const s = spec('dangling', [['a', 'write', {}]], [['a', 'ghost']]);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow(GraphDefinitionError);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow('未知节点');
  });

  it('空规格 → 建图期拒绝', () => {
    const s = spec('empty', [], []);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow(GraphDefinitionError);
    expect(() => build_workflow_graph(s, makeRegistry())).toThrow('为空');
  });

  it('编译产物通过 Graph.compile 校验', () => {
    const s = spec('valid', [['a', 'write', {}], ['b', 'audit', {}]], [['a', 'b']]);
    const graph = build_workflow_graph(s, makeRegistry());
    expect(() => graph.compile()).not.toThrow();
  });

  it('同类型不同节点配置隔离：节点函数互不串扰', () => {
    const s = spec('isolation', [['a', 'write', { value: 1 }], ['b', 'write', { value: 2 }]], [
      ['a', 'b'],
    ]);
    const graph = build_workflow_graph(s, makeRegistry());
    expect(graph.nodes['a']).not.toBe(graph.nodes['b']);
  });

  it('扇出规格：入口推断 + 出口标记', () => {
    const s = spec(
      'fanout',
      [
        ['writer', 'write', { value: 1 }],
        ['compliance', 'audit', { value: 2 }],
        ['plot', 'audit', { value: 3 }],
        ['chief', 'write', { value: 4 }],
      ],
      [
        ['writer', 'compliance'],
        ['writer', 'plot'],
        ['compliance', 'chief'],
        ['plot', 'chief'],
      ],
    );
    const graph = build_workflow_graph(s, makeRegistry());
    expect(graph.entry).toBe('writer');
    expect(graph.exits.has('chief')).toBe(true);
    expect(() => graph.compile()).not.toThrow();
  });

  it('拓扑序稳定：同输入恒同序（节点清单序 + 边插入序）', () => {
    const s = spec(
      'stable',
      [['a', 'write', {}], ['b', 'write', {}], ['c', 'write', {}]],
      [['a', 'b'], ['b', 'c']],
      'a',
    );
    const first = build_workflow_graph(s, makeRegistry());
    const second = build_workflow_graph(s, makeRegistry());
    const firstEdges = Object.entries(first.edges).flatMap(([src, edges]) =>
      edges.map((e) => `${src}->${e.target}`),
    );
    const secondEdges = Object.entries(second.edges).flatMap(([src, edges]) =>
      edges.map((e) => `${src}->${e.target}`),
    );
    expect(firstEdges).toEqual(secondEdges);
  });
});
