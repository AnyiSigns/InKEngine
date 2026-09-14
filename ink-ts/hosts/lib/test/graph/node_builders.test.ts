/**
 * 图节点装配通道镜像测试（S1-b2 步 2）：清单唯一内核名对账 + 装配槽注入位。
 */

import { describe, expect, it } from 'vitest';
import {
  graphNodeKernelReport,
  injectGraphNodeBuilders,
  type GraphNodeBuilder,
} from '../../src/graph/node_builders.js';
import {
  GRAPH_NODE_DECLS,
  graphNodeKernels,
} from '../../src/assembly/graph_nodes.generated.js';

describe('graph node assembly', () => {
  it('清单与唯一内核名集合一致（8 声明 → 4 内核）', () => {
    expect(GRAPH_NODE_DECLS.length).toBe(8);
    const unique = new Set(graphNodeKernels());
    expect(unique.size).toBe(4);
    expect([...unique].sort()).toEqual(['agent', 'llm_decider', 'router_judge', 'tool_pipeline']);
  });

  it('每条声明的 executor 恒 ∈ 唯一内核名集合', () => {
    const unique = new Set(graphNodeKernels());
    for (const decl of GRAPH_NODE_DECLS) {
      expect(unique.has(decl.executor)).toBe(true);
    }
  });

  it('过渡期对账：四内核全部引擎可解析，missing 为空', () => {
    const report = graphNodeKernelReport();
    expect(report.total).toBe(8);
    expect(report.unique).toEqual([...graphNodeKernels()]);
    expect(report.missing).toEqual([]);
    expect([...report.resolvable].sort()).toEqual(['agent', 'llm_decider', 'router_judge', 'tool_pipeline']);
  });

  it('注入位：引擎全持有 → 零注入、幂等可重入', () => {
    let called = false;
    const report = injectGraphNodeBuilders((name) => {
      called = true;
      const builder: GraphNodeBuilder = () => (() => ({})) as never;
      return builder;
    });
    expect(report.engineHeld).toEqual(['agent', 'llm_decider', 'router_judge', 'tool_pipeline']);
    expect(report.injected).toEqual([]);
    expect(called).toBe(false);
    const again = injectGraphNodeBuilders(() => null);
    expect(again.injected).toEqual([]);
  });
});