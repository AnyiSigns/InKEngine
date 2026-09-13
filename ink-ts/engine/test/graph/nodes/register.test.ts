/**
 * S1-a 节点执行体装配槽（register_node_builder）：引擎执行体构造器槽公开为
 * 可扩展注册面——装配方（S1-b 起 = hosts/lib 出厂装配把 graph_node 插件工厂
 * 注入）按 executor 名注册构建器，声明式恢复经 has_engine_executor +
 * register_engine_node_type 解出并建节点。幂等语义：同名/空名拒绝（返回
 * false 不抛）；既有出厂内核槽不受影响。
 */
import { describe, expect, it } from 'vitest';

import { GraphRegistries } from '../../../src/graph/registry/registry.js';
import type { NodeFactory } from '../../../src/graph/registry/registry_types.js';
import {
  TYPE_LLM_DECIDER,
  has_engine_executor,
  has_engine_node_type,
  register_engine_node_type,
  register_node_builder,
} from '../../../src/graph/nodes/index.js';

/** stub 执行体构造器：读 state.input 回显的结果节点（确定性、零依赖）。 */
const stub_builder = (): NodeFactory => {
  return () => async (ctx) => {
    const state = (ctx as { state?: Record<string, unknown> } | null)?.state ?? {};
    return { ok: true, seen: state['input'] ?? null };
  };
};

describe('S1-a 节点执行体装配槽（register_node_builder）', () => {
  it('新 executor 注册后经 has/register_engine_node_type 建节点并可执行', async () => {
    expect(register_node_builder('stub_executor', stub_builder), 'register_node_builder 首次登记须成功').toBe(true);
    expect(has_engine_executor('stub_executor'), 'has_engine_executor 注册后须命中').toBe(true);
    expect(has_engine_node_type('stub_executor'), 'has_engine_node_type 注册后须命中').toBe(true);

    const registries = new GraphRegistries();
    expect(
      register_engine_node_type(registries, 'stub_node', null, null, 'stub_executor'),
      'register_engine_node_type 注册是否成功（显式 executor 指向新槽）',
    ).toBe(true);
    expect(registries.nodes.has('stub_node'), 'stub_node 应在注册表中').toBe(true);

    const fn = registries.nodes.create('stub_node', {});
    const result = await fn({
      state: { input: 'hi' },
      graph_path: [],
      round_id: null,
      trace_id: 't',
      emit: async () => undefined,
      interrupt: async () => null,
      get_interrupt_payload: () => null,
      account_usage: () => undefined,
      terminate: () => undefined,
      terminated: false,
    });
    expect(result).toEqual({ ok: true, seen: 'hi' });
  });

  it('同名（含出厂内核名）重复注册被拒（返回 false，不覆盖既有槽）', () => {
    expect(register_node_builder('stub_executor', stub_builder)).toBe(false);
    expect(register_node_builder(TYPE_LLM_DECIDER, stub_builder)).toBe(false);
    expect(has_engine_executor(TYPE_LLM_DECIDER)).toBe(true);
  });

  it('空 executor 名被拒', () => {
    expect(register_node_builder('', stub_builder)).toBe(false);
    expect(register_node_builder('   ', stub_builder)).toBe(false);
  });

  it('未注册 executor 保持未知（has=false、register 返回 false）', () => {
    expect(has_engine_executor('not_registered_executor')).toBe(false);
    const registries = new GraphRegistries();
    expect(register_engine_node_type(registries, 'ghost_node', null, null, 'not_registered_executor')).toBe(false);
    expect(registries.nodes.has('ghost_node')).toBe(false);
  });
});