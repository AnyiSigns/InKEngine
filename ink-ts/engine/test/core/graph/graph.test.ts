/**
 * Graph DSL 编译校验 + 结构测试（镜像 ink_engine/tests/test_graph.py）。
 * 不引入执行器——只测纯结构（节点/边/条件边/嵌套子图/digest/resolve_conditions）。
 */

import { describe, expect, it } from 'vitest';

import { NodeContract } from '../../../src/core/contracts/contracts.js';
import { GraphDefinitionError, NodeNotFoundError } from '../../../src/core/errors.js';
import { Graph } from '../../../src/core/graph/graph.js';
import type { EdgeCondition, NodeFn } from '../../../src/core/graph/graph_types.js';

// ── demo 图工厂（与 conftest.demo_* 1:1 对齐；纯 Graph 构建） ──────────────

const noop = async () => ({});

function demo_linear_graph(): Graph {
  const start: NodeFn = async () => ({ count: 1 });
  const mid: NodeFn = async (ctx) => ({ count: ((ctx as { state: { count?: number } }).state.count ?? 0) + 1 });
  const end: NodeFn = async (ctx) => ({ count: ((ctx as { state: { count?: number } }).state.count ?? 0) + 1 });
  const g = new Graph({ name: 'linear', entry: 'start' });
  g.add_node('start', start);
  g.add_node('mid', mid);
  g.add_node('end', end);
  g.add_edge('start', 'mid');
  g.add_edge('mid', 'end');
  g.add_exit('end');
  return g;
}

function demo_conditional_graph(): Graph {
  const want_yes: EdgeCondition = (ctx) =>
    (ctx as { state: { want_yes?: boolean } }).state.want_yes === true;
  const want_no: EdgeCondition = (ctx) =>
    (ctx as { state: { want_yes?: boolean } }).state.want_yes !== true;
  const g = new Graph({ name: 'conditional', entry: 'start' });
  g.add_node('start', noop);
  g.add_node('yes', async () => ({ branch: 'yes' }));
  g.add_node('no', async () => ({ branch: 'no' }));
  g.add_conditional_edge('start', 'yes', want_yes);
  g.add_conditional_edge('start', 'no', want_no);
  g.add_exit('yes');
  g.add_exit('no');
  return g;
}

function demo_loop_graph(): Graph {
  const again: EdgeCondition = (ctx) =>
    ((ctx as { state: { count?: number } }).state.count ?? 0) < 3;
  const g = new Graph({ name: 'loop', entry: 'start' });
  g.add_node('start', async () => ({ count: 0 }));
  g.add_node('loop', async (ctx) => ({
    count: ((ctx as { state: { count?: number } }).state.count ?? 0) + 1,
  }));
  g.add_node('exit', async () => ({ done: true }));
  g.add_edge('start', 'loop');
  g.add_conditional_edge('loop', 'loop', again);
  g.add_conditional_edge('loop', 'exit', () => true);
  g.add_exit('exit');
  return g;
}

// ── tests ───────────────────────────────────────────────────────────────

describe('Graph 编译校验', () => {
  it('线性图编译通过', () => {
    expect(() => demo_linear_graph().compile()).not.toThrow();
  });

  it('入口节点不存在 → GraphDefinitionError', () => {
    const g = new Graph({ name: 'g', entry: 'nope' });
    expect(() => g.compile()).toThrow(GraphDefinitionError);
  });

  it('边目标不存在 → NodeNotFoundError', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', noop);
    g.add_edge('a', 'ghost');
    expect(() => g.compile()).toThrow(NodeNotFoundError);
  });

  it('出口节点不存在 → NodeNotFoundError', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', noop);
    g.add_node('b', noop);
    g.add_edge('a', 'b');
    g.add_exit('ghost');
    expect(() => g.compile()).toThrow(NodeNotFoundError);
  });

  it('边源节点不存在 → NodeNotFoundError', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', noop);
    g.add_edge('ghost', 'a');
    expect(() => g.compile()).toThrow(NodeNotFoundError);
  });

  it('条件图节点注册齐全 + start 出度 2', () => {
    const g = demo_conditional_graph();
    expect(Object.keys(g.nodes).sort()).toEqual(['no', 'start', 'yes']);
    expect(g.edges['start']!.length).toBe(2);
  });

  it('循环图 loop 节点自指 + exit 出边', () => {
    const g = demo_loop_graph();
    const targets = g.edges['loop']!.map((e) => e.target);
    expect(targets).toEqual(['loop', 'exit']);
  });

  it('子图名冲突 → GraphDefinitionError', () => {
    const g = new Graph({ name: 'parent', entry: 'sub' });
    const sub = new Graph({ name: 'sub', entry: 'a' });
    sub.add_node('a', noop);
    sub.add_exit('a');
    g.add_node('sub', noop);
    expect(() => g.add_subgraph('sub', sub)).toThrow(GraphDefinitionError);
  });

  it('子图正常注册 + 可编译', () => {
    const g = new Graph({ name: 'parent', entry: 'sub' });
    const sub = new Graph({ name: 'sub', entry: 'a' });
    sub.add_node('a', noop);
    sub.add_exit('a');
    g.add_subgraph('sub', sub);
    expect(g.subgraphs['sub']).toBeDefined();
    expect(g.nodes['sub']).toBeUndefined(); // 占位由执行器按子图语义注入；图模块不放占位 fn
    expect(() => g.compile()).not.toThrow();
  });

  it('静态边与条件边混用 → GraphDefinitionError', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', noop);
    g.add_node('b', noop);
    g.add_node('c', noop);
    g.add_edge('a', 'b');
    g.add_conditional_edge('a', 'c', () => true);
    g.add_exit('b');
    expect(() => g.compile()).toThrow(GraphDefinitionError);
  });

  it('嵌套子图非法在父图 compile 期暴露', () => {
    const parent = new Graph({ name: 'parent', entry: 'sub' });
    const sub = new Graph({ name: 'sub', entry: 'ghost' });
    sub.add_node('a', noop);
    sub.add_exit('a');
    parent.add_subgraph('sub', sub);
    expect(() => parent.compile()).toThrow(GraphDefinitionError);
  });
});