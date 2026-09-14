/**
 * 图节点装配通道镜像测试（S1-b2 步 2/3）：清单唯一内核名对账 + 装配槽注入位 +
 * 清单→池种子转换与装配权威 lock（与引擎出厂默认对齐）。
 */

import { describe, expect, it } from 'vitest';
import { default_engine_pool_seed } from '@ink-ts/engine';
import {
  assertGraphNodeSeedsAligned,
  graphNodeAssemblySeed,
  graphNodeInstanceSeeds,
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

  it('清单→池种子：完整清单 8 条，装配注入面非 agent 7 条', () => {
    const full = graphNodeInstanceSeeds();
    expect(full.node_types.length).toBe(8);
    expect(full.node_types.map((s) => s.type)).toContain('agent');
    const asm = graphNodeAssemblySeed();
    expect(asm.node_types.length).toBe(7);
    expect(asm.node_types.map((s) => s.type)).not.toContain('agent');
    expect(asm.node_types.every((s) => s.executor !== undefined)).toBe(true);
  });

  it('装配权威 lock：清单注入面与引擎出厂默认结构面对齐（零行为漂移）', () => {
    const asm = graphNodeAssemblySeed();
    const def = default_engine_pool_seed();
    expect(def.node_types.length).toBe(7);
    expect(asm.node_types.map((s) => s.type).sort()).toEqual(
      def.node_types.map((s) => s.type).sort(),
    );
    expect(() => assertGraphNodeSeedsAligned(def)).not.toThrow();
    for (const seed of asm.node_types) {
      const match = def.node_types.find((d) => d.type === seed.type);
      expect(match).toBeDefined();
      expect(JSON.stringify(seed.default_config)).toBe(JSON.stringify(match!.default_config));
      expect(JSON.stringify(seed.contract)).toBe(JSON.stringify(match!.contract));
    }
  });

  it('装配权威 lock：清单与出厂漂移时抛错', () => {
    const drifted = default_engine_pool_seed();
    drifted.node_types = drifted.node_types.filter((s) => s.type !== 'llm_decider');
    expect(() => assertGraphNodeSeedsAligned(drifted)).toThrow(/类型集漂移/);
  });
});