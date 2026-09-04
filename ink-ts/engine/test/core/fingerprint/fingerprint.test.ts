/**
 * 路径指纹：算法归引擎（复用图摘要），上下文指纹钉模型/上下文漂移。
 *
 * 覆盖：图指纹 = 图定义规范摘要（拓扑变更即指纹变化、同定义稳定）；
 * 上下文指纹含图摘要 + 上下文 + 模型标识（漂移即不命中）；请求指纹
 * 键形 = 目标字段/入口字段（排序入键）+ 域 + 安全档 + 模型标识。
 */

import { describe, expect, it } from 'vitest';

import { Graph } from '../../../src/core/graph/graph.js';
import {
  context_fingerprint,
  graph_fingerprint,
  request_fingerprint,
} from '../../../src/core/fingerprint/fingerprint.js';

function build(name = 'g'): Graph {
  const g = new Graph({ name, entry: 'a' });
  g.add_node_type('a', 'intent_parse', {}, null);
  g.add_node_type('b', 'answer_direct', {}, null);
  g.add_edge('a', 'b');
  g.add_exit('b');
  return g;
}

describe('graph_fingerprint', () => {
  it('同一定义指纹稳定；拓扑变更即指纹变化', () => {
    const g1 = build();
    const g2 = build();
    expect(graph_fingerprint(g1)).toBe(graph_fingerprint(g2));
    const g3 = build();
    g3.add_node_type('c', 'code_gen', {}, null);
    g3.add_edge('b', 'c');
    g3.add_exit('c');
    expect(graph_fingerprint(g3)).not.toBe(graph_fingerprint(g1));
  });

  it('图指纹 = Graph.digest（算法复用，不另立实现）', () => {
    const g = build();
    expect(graph_fingerprint(g)).toBe(g.digest());
  });
});

describe('context_fingerprint', () => {
  it('钉上下文与模型标识：漂移即不命中', () => {
    const g = build();
    const base = context_fingerprint(g, { context: { goal: 'x' }, model_id: 'm1' });
    expect(base).toBe(context_fingerprint(g, { context: { goal: 'x' }, model_id: 'm1' }));
    expect(base).not.toBe(context_fingerprint(g, { context: { goal: 'y' }, model_id: 'm1' }));
    expect(base).not.toBe(context_fingerprint(g, { context: { goal: 'x' }, model_id: 'm2' }));
    expect(context_fingerprint(g)).not.toBe(context_fingerprint(g, { context: { goal: 'x' } }));
  });

  it('16hex 形态（16 字符），JSON 规范序（键序无关）', () => {
    const g = build();
    const fp = context_fingerprint(g, { context: { a: 1, b: 2 }, model_id: 'm' });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toBe(context_fingerprint(g, { context: { b: 2, a: 1 }, model_id: 'm' }));
  });
});

describe('request_fingerprint', () => {
  it('字段序无关（排序后入键）', () => {
    const fp1 = request_fingerprint({
      goal_fields: ['g1', 'g2'],
      entry_fields: ['e1'],
      domain: 'd',
      max_safety_tier: 2,
      model_id: 'm',
    });
    const fp2 = request_fingerprint({
      goal_fields: ['g2', 'g1'],
      entry_fields: ['e1'],
      domain: 'd',
      max_safety_tier: 2,
      model_id: 'm',
    });
    expect(fp1).toBe(fp2);
  });

  it('任一维度漂移即指纹变化', () => {
    const base = request_fingerprint({
      goal_fields: ['g'],
      entry_fields: ['e'],
      domain: 'd',
      max_safety_tier: 2,
      model_id: 'm',
    });
    expect(base).not.toBe(
      request_fingerprint({ goal_fields: ['g2'], entry_fields: ['e'], domain: 'd', max_safety_tier: 2, model_id: 'm' }),
    );
    expect(base).not.toBe(
      request_fingerprint({ goal_fields: ['g'], entry_fields: ['e2'], domain: 'd', max_safety_tier: 2, model_id: 'm' }),
    );
    expect(base).not.toBe(
      request_fingerprint({ goal_fields: ['g'], entry_fields: ['e'], domain: 'd2', max_safety_tier: 2, model_id: 'm' }),
    );
    expect(base).not.toBe(
      request_fingerprint({ goal_fields: ['g'], entry_fields: ['e'], domain: 'd', max_safety_tier: 3, model_id: 'm' }),
    );
    expect(base).not.toBe(
      request_fingerprint({ goal_fields: ['g'], entry_fields: ['e'], domain: 'd', max_safety_tier: 2, model_id: 'm2' }),
    );
  });

  it('16hex 形态', () => {
    const fp = request_fingerprint({
      goal_fields: ['g'],
      entry_fields: ['e'],
      domain: 'd',
      max_safety_tier: 1,
      model_id: 'm',
    });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});
