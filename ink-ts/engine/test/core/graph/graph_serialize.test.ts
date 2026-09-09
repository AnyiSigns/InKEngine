/**
 * Graph 序列化 / 反序列化（to_dict / from_dict）测试。
 * 覆盖：声明式节点/条件边序列化与重建、子图递归、契约随图数据落库、
 * 函数直挂节点不可序列化（防静默丢失）。
 */

import { describe, expect, it } from 'vitest';

import { NodeContract } from '../../../src/core/contracts/contracts.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';
import { Graph } from '../../../src/core/graph/graph.js';
import type {
  EdgeCondition,
  EdgeConditionRegistryLike,
  NodeFn,
  NodeTypeRegistryLike,
} from '../../../src/core/graph/graph_types.js';

// ── 最小注册表实现（测试用） ────────────────────────────────────────────

class MiniNodeRegistry implements NodeTypeRegistryLike {
  private readonly map = new Map<string, (config: Record<string, unknown>) => NodeFn>();
  register(name: string, fn: NodeFn): void {
    this.map.set(name, () => fn);
  }
  create(type_name: string, _config: Record<string, unknown>): NodeFn {
    const factory = this.map.get(type_name);
    if (factory === undefined) throw new GraphDefinitionError(`未知节点类型: ${type_name}`);
    return factory({});
  }
}

class MiniEdgeRegistry implements EdgeConditionRegistryLike {
  private readonly map = new Map<string, EdgeCondition>();
  register(name: string, cond: EdgeCondition): void {
    this.map.set(name, cond);
  }
  has(name: string): boolean {
    return this.map.has(name);
  }
  create(name: string): EdgeCondition {
    const c = this.map.get(name);
    if (c === undefined) throw new GraphDefinitionError(`未知条件: ${name}`);
    return c;
  }
}

describe('Graph.to_dict / from_dict', () => {
  it('声明式图完整序列化 + 重建一致', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node_type('a', 'intent_parse', { lang: 'zh' }, new NodeContract({ safety_tier: 1, version: 2 }));
    g.add_node_type('b', 'answer_direct', {}, new NodeContract());
    g.add_edge('a', 'b');
    g.add_exit('b');

    const data = g.to_dict();
    expect(data['name']).toBe('g');
    expect(Object.keys((data['nodes'] as Record<string, unknown>)).sort()).toEqual(['a', 'b']);
    expect(data['exits']).toEqual(['b']);

    // 重建
    const nodeReg = new MiniNodeRegistry();
    nodeReg.register('intent_parse', async () => ({ ok: true }));
    nodeReg.register('answer_direct', async () => ({ ok: true }));
    const rebuilt = Graph.from_dict(data, { registry: nodeReg });
    expect(rebuilt.nodes['a']).toBeDefined();
    expect(rebuilt.nodes['b']).toBeDefined();
    expect(rebuilt.exits.has('b')).toBe(true);
    // 契约随图数据落库（重建不丢失）
    expect(rebuilt.node_bindings['a']!.contract?.safety_tier).toBe(1);
    expect(rebuilt.node_bindings['a']!.contract?.version).toBe(2);
  });

  it('函数直挂节点 → to_dict 显式拒绝（防静默丢失）', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', async () => ({}));
    expect(() => g.to_dict()).toThrow(GraphDefinitionError);
  });

  it('子图递归 to_dict / from_dict', () => {
    const parent = new Graph({ name: 'parent', entry: 'sub' });
    const sub = new Graph({ name: 'sub', entry: 'a' });
    sub.add_node_type('a', 'parse', {}, new NodeContract());
    sub.add_exit('a');
    parent.add_subgraph('sub', sub);

    const data = parent.to_dict();
    expect((data['subgraphs'] as Record<string, unknown>)['sub']).toBeDefined();

    const nodeReg = new MiniNodeRegistry();
    nodeReg.register('parse', async () => ({}));
    const rebuilt = Graph.from_dict(data, { registry: nodeReg, validate: true });
    expect(rebuilt.subgraphs['sub']).toBeDefined();
    expect(rebuilt.subgraphs['sub']!.nodes['a']).toBeDefined();
  });

  it('按名条件边序列化 + 重建 + 解析', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node_type('a', 'kind_a', {}, new NodeContract());
    g.add_node_type('b', 'kind_b', {}, new NodeContract());
    g.add_conditional_edge_by_name('a', 'b', 'want_b');
    g.add_exit('b');
    const data = g.to_dict();
    const condData = (data['edges'] as Record<string, unknown>)['a'] as Array<Record<string, unknown>>;
    expect(condData[0]!['condition']).toBe('want_b');

    const edgeReg = new MiniEdgeRegistry();
    edgeReg.register('want_b', () => true);
    const nodeReg = new MiniNodeRegistry();
    nodeReg.register('kind_a', async () => ({}));
    nodeReg.register('kind_b', async () => ({}));
    const rebuilt = Graph.from_dict(data, { registry: nodeReg, edge_registry: edgeReg, validate: true });
    expect(rebuilt.edges['a']![0]!.condition_name).toBe('want_b');
    expect(rebuilt.edges['a']![0]!.condition).toBeDefined();
  });

  it('按名条件边无注册表 → from_dict 拒绝', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node_type('a', 'kind_a', {}, new NodeContract());
    g.add_node_type('b', 'kind_b', {}, new NodeContract());
    g.add_conditional_edge_by_name('a', 'b', 'missing');
    g.add_exit('b');
    const data = g.to_dict();
    expect(() => Graph.from_dict(data)).toThrow(GraphDefinitionError);
  });

  it('from_dict 缺 name/entry → GraphDefinitionError', () => {
    expect(() => Graph.from_dict({})).toThrow(GraphDefinitionError);
    expect(() => Graph.from_dict({ name: 'g' })).toThrow(GraphDefinitionError);
  });

  it('from_dict 数据非法（非 dict）→ GraphDefinitionError', () => {
    expect(() => Graph.from_dict('nope')).toThrow(GraphDefinitionError);
  });

  it('from_dict validate=true：非法图在建图期暴露', () => {
    // 入口不存在
    const data = {
      name: 'g',
      entry: 'ghost',
      nodes: {},
      edges: {},
      exits: [],
      subgraphs: {},
      schema: null,
    };
    expect(() => Graph.from_dict(data, { validate: true })).toThrow(GraphDefinitionError);
  });

  it('function 直挂条件边 → to_dict 拒绝（防静默丢失）', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', async () => ({}));
    g.add_node('b', async () => ({}));
    g.add_conditional_edge('a', 'b', () => true); // 函数直挂
    g.add_exit('b');
    expect(() => g.to_dict()).toThrow(GraphDefinitionError);
  });
});

// ── 边 kind 序列化（P1：standard/conditional 不回填，仅 loop 显式输出） ──────

describe('Graph 边 kind 序列化', () => {
  it('standard/conditional 边不回填 kind（既有序列化输出形状不变）', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node_type('a', 'kind_a', {}, new NodeContract());
    g.add_node_type('b', 'kind_b', {}, new NodeContract());
    g.add_node_type('c', 'kind_c', {}, new NodeContract());
    g.add_edge('a', 'b');
    g.add_conditional_edge_by_name('a', 'c', 'want_c');
    g.add_exit('b');
    const data = g.to_dict();
    const edges = (data['edges'] as Record<string, unknown>)['a'] as Array<Record<string, unknown>>;
    expect(edges[0]).toEqual({ target: 'b' });
    expect(edges[1]).toEqual({ target: 'c', condition: 'want_c' });
  });

  it('loop 回边序列化输出 kind:loop 且 from_dict 往返保留（含条件回边）', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node_type('a', 'kind_a', {}, new NodeContract());
    g.add_node_type('b', 'kind_b', {}, new NodeContract());
    g.add_loop_edge('a', 'a');
    g.add_loop_edge('a', 'b', { condition_name: 'again' });
    g.add_exit('b');
    const data = g.to_dict();
    const edges = (data['edges'] as Record<string, unknown>)['a'] as Array<Record<string, unknown>>;
    expect(edges[0]).toEqual({ target: 'a', kind: 'loop' });
    expect(edges[1]).toEqual({ target: 'b', condition: 'again', kind: 'loop' });

    const edgeReg = new MiniEdgeRegistry();
    edgeReg.register('again', () => true);
    const nodeReg = new MiniNodeRegistry();
    nodeReg.register('kind_a', async () => ({}));
    nodeReg.register('kind_b', async () => ({}));
    const rebuilt = Graph.from_dict(data, { registry: nodeReg, edge_registry: edgeReg });
    expect(rebuilt.edges['a']!.map((e) => e.kind)).toEqual(['loop', 'loop']);
    expect(rebuilt.edges['a']![1]!.condition_name).toBe('again');
    // 往返后序列化仍含 kind:loop（digest/存储形状稳定）
    const reSerialized = rebuilt.to_dict();
    const reEdges = (reSerialized['edges'] as Record<string, unknown>)['a'] as Array<Record<string, unknown>>;
    expect(reEdges[1]).toEqual({ target: 'b', condition: 'again', kind: 'loop' });
    expect(rebuilt.digest()).toBe(Graph.from_dict(reSerialized, { registry: nodeReg, edge_registry: edgeReg }).digest());
  });

  it('边声明 kind 非法（非 standard/conditional/loop）→ from_dict 拒绝', () => {
    const data = {
      name: 'g',
      entry: 'a',
      nodes: { a: { type: 'kind_a' }, b: { type: 'kind_b' } },
      edges: { a: [{ target: 'b', kind: 'sideways' }] },
      exits: ['b'],
      subgraphs: {},
      schema: null,
    };
    expect(() => Graph.from_dict(data)).toThrow(/kind 非法/);
  });
});