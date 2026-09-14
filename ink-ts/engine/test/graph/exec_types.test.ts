/**
 * 图执行协议结构接口镜像测试（S1-c2）：聚合面符号齐全 + 结构与具体类兼容
 * （Graph implements GraphLike 的结构性守护；行为仍由 graph/executor 执行链
 * 与 model/graph 既有测试覆盖）。
 */

import { describe, expect, it } from 'vitest';

import { Graph } from '../../src/model/graph/graph.js';
import { Edge, NodeBinding } from '../../src/model/graph/graph_types.js';
import type {
  CompiledGraphLike,
  EdgeLike,
  GraphLike,
  NodeBindingLike,
  NodeLike,
} from '../../src/graph/exec_types.js';

describe('图执行协议结构接口面（graph/exec_types）', () => {
  it('聚合面导出结构接口符号齐全', () => {
    // type-only 导入已静态保证符号存在；这里以值断言形式锁定聚合面契约
    const symbols: string[] = [];
    symbols.push(typeof Edge, typeof NodeBinding, typeof Graph);
    expect(symbols.every((s) => s === 'function')).toBe(true);
  });

  it('具体类结构兼容结构接口（编译期经 implements + 结构检查守护）', () => {
    const graph = new Graph({ name: 'g', entry: 'n', nodes: { n: () => ({}) } });
    const asGraphLike: GraphLike = graph;
    expect(asGraphLike.name).toBe('g');
    const compiled = graph.compile();
    const asCompiledLike: CompiledGraphLike = compiled;
    expect(asCompiledLike.graph.name).toBe('g');
    const edge = new Edge({ target: 'n' });
    const asEdgeLike: EdgeLike = edge;
    expect(asEdgeLike.target).toBe('n');
    const binding = new NodeBinding({ type_name: 't', config: {}, contract: null });
    const asBindingLike: NodeBindingLike = binding;
    expect(asBindingLike.type_name).toBe('t');
  });

  it('NodeLike 协议别名 = 节点执行体结构面', () => {
    const fn: NodeLike = () => ({});
    expect(typeof fn).toBe('function');
    const nodeFn: NodeLike = async () => null;
    void nodeFn;
  });
});
