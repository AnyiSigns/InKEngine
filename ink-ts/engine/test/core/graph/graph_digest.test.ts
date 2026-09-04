/**
 * Graph digest 指纹（ENG9a-18 回归：name 不参与指纹）。
 * + resolve_conditions 按位置解析（ENG2-15：同源多条件边不首条错替）。
 */

import { describe, expect, it } from 'vitest';

import { NodeContract } from '../../../src/core/contracts/contracts.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';
import { Graph } from '../../../src/core/graph/graph.js';
import type { EdgeCondition, EdgeConditionRegistryLike } from '../../../src/core/graph/graph_types.js';

function build(name: string): Graph {
  const g = new Graph({ name, entry: 'a' });
  g.add_node_type('a', 'intent_parse', {}, new NodeContract());
  g.add_node_type('b', 'answer_direct', {}, new NodeContract());
  g.add_edge('a', 'b');
  g.add_exit('b');
  return g;
}

function other(name: string): Graph {
  const g = new Graph({ name, entry: 'a' });
  g.add_node_type('a', 'intent_parse', {}, new NodeContract());
  g.add_node_type('c', 'code_gen', {}, new NodeContract());
  g.add_edge('a', 'c');
  g.add_exit('c');
  return g;
}

describe('Graph.digest 指纹', () => {
  it('同拓扑不同 name = 同一指纹（name 不参与）', () => {
    const d1 = build('assembly.1.code').digest();
    const d2 = build('assembly.2.code').digest();
    const d3 = build('any.other.name').digest();
    expect(d1).toBe(d2);
    expect(d1).toBe(d3);
  });

  it('拓扑变化仍改变指纹（不变性与身份敏感性不冲突）', () => {
    const x = build('assembly.1.code').digest();
    const y = other('assembly.1.code').digest();
    expect(x).not.toBe(y);
  });

  it('指纹稳定（同一图二次调用同值）', () => {
    const g = build('stable');
    expect(g.digest()).toBe(g.digest());
  });

  it('指纹格式：64 位十六进制（16 个 hex 字符）', () => {
    const d = build('fmt').digest();
    expect(d).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── resolve_conditions 按位置替换 ────────────────────────────────────────

class Registry implements EdgeConditionRegistryLike {
  create(_name: string): EdgeCondition {
    return () => true;
  }
  has(name: string): boolean {
    return name === 'cond_b' || name === 'cond_c';
  }
}

describe('Graph.resolve_conditions 按位置解析', () => {
  it('同源多条件边按位置解析（不首条错替）', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', async () => ({}));
    g.add_node('b', async () => ({}));
    g.add_node('c', async () => ({}));
    g.add_conditional_edge_by_name('a', 'b', 'cond_b');
    g.add_conditional_edge_by_name('a', 'c', 'cond_c');
    g.add_exit('c');
    g.resolve_conditions(new Registry());
    const resolved = g.edges['a']!;
    expect(resolved.map((e) => e.target)).toEqual(['b', 'c']);
    expect(resolved[0]!.target).toBe('b');
    expect(resolved[0]!.condition_name).toBe('cond_b');
    expect(resolved[1]!.target).toBe('c');
    expect(resolved[1]!.condition_name).toBe('cond_c');
    expect(resolved.every((e) => e.condition !== null)).toBe(true);
  });

  it('无未解析条件边时 = 幂等 no-op', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', async () => ({}));
    g.add_node('b', async () => ({}));
    g.add_edge('a', 'b');
    g.add_exit('b');
    expect(() => g.resolve_conditions(new Registry())).not.toThrow();
  });

  it('含未解析条件边且未注入注册表 → GraphDefinitionError', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node('a', async () => ({}));
    g.add_node('b', async () => ({}));
    g.add_conditional_edge_by_name('a', 'b', 'missing');
    g.add_exit('b');
    expect(() => g.resolve_conditions(null)).toThrow(GraphDefinitionError);
  });

  it('声明式节点未注入注册表 → GraphDefinitionError', () => {
    const g = new Graph({ name: 'g', entry: 'a' });
    g.add_node_type('a', 'intent_parse', {}, new NodeContract());
    expect(() => g.resolve_types(null)).toThrow(GraphDefinitionError);
  });
});