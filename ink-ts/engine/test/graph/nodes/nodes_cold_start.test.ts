/**
 * 引擎内置基础节点 boot 接线测试：Runtime 装配默认注册引擎内置池种子 +
 * rebuild seams 绑定。
 *
 * - boot 后 graph_registries 含 llm_decider/tool_pipeline 及契约（注册表含
 *   新类型，引擎给多宿主用 = 引擎内置注册，宿主只给数据）；
 * - boot 种子登记行元数据与配方 pool_seed 覆写面。
 *
 * （冷启动组装面已随组装链路退役：回合执行归 execution 执行运行时。）
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/loop/runtime/index.js';
import type { Host } from '../../../src/loop/runtime/index.js';
import {
  TYPE_LLM_DECIDER,
  TYPE_TOOL_PIPELINE,
  default_engine_pool_seed,
} from '../../../src/graph/nodes/index.js';
import type { EnginePoolSeed } from '../../../src/graph/nodes/index.js';
import { NODE_KIND_LLM, NODE_KIND_TOOL } from '../../../src/graph/nodes/constants.js';
import { DefaultInterruptPolicy } from '../../../src/gate/approval/approval.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/model/event_types/eventTypeSpec.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/kernel/self_tools/index.js';
import type { SelfToolContext } from '../../../src/kernel/self_tools/index.js';
import { MemoryStorage } from '../executor/helpers.js';


/** boot 领域种子（最小：知识集基线条目）。 */
function boot_seed_entries(): KnowledgeEntry[] {
  return [
    new KnowledgeEntry({
      id: 'seed.boot.system_prompt',
      level: 'work',
      kind: KIND_RULE,
      data: { rule: { message: '系统提示基线' } },
      source: 'model',
      credibility: 0.9,
      title: '系统提示',
      tags: ['boot'],
    }),
  ];
}

/** Host 五件套 mock（内存存储 + 直过策略；无模型）。 */
class FakeHost {
  policy: unknown = new DefaultInterruptPolicy();
  async create_storage(): Promise<MemoryStorage> {
    return new MemoryStorage();
  }
  async resolve_llm(): Promise<null> {
    return null;
  }
  interrupt_policy(): unknown {
    return this.policy;
  }
  build_transport(): { send(): Promise<void> } {
    return { async send() {} };
  }
  async close(): Promise<void> {}
}

function toHost(host: FakeHost): Host {
  return host as unknown as Host;
}

/** 最小装配配方（机制开关默认全开；无常驻静态引擎 = 常态）。 */
function _minimal_recipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'a1-boot',
    seeds: [['boot', boot_seed_entries]],
    harness_definitions: [
      new HarnessDefinition({ name: 'forge', description: '自举领域', keywords: ['自举'] }),
    ],
    event_type_specs: [new EventTypeSpec({ name: 'reply_token', renderer: 'StreamingRow' })],
    tool_wiring: {
      self_specs: () => self_tool_specs(),
      self_executor_factory: (pipeline, context_getter) =>
        make_self_executor(pipeline, context_getter as unknown as () => SelfToolContext),
      self_operation_of: (spec) => operation_of(spec),
    },
    approval_levels: {},
  });
  return Object.assign(base, overrides);
}

describe('Runtime boot：引擎内置池种子注册', () => {
  it('boot 后注册表含引擎内置类型及契约', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    const registries = runtime.graph_registries!;
    expect(registries.nodes.has(TYPE_LLM_DECIDER)).toBe(true);
    expect(registries.nodes.has(TYPE_TOOL_PIPELINE)).toBe(true);
    expect(registries.nodes.contract_for(TYPE_LLM_DECIDER)).toBeTruthy();
    expect(registries.edges.has('llm.pending_nonempty')).toBe(true);
    await runtime.stop();
  });

  it('boot 种子登记行携带元数据（kind/label/description/flags 透传登记入池）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    const regs = runtime.node_registrations();
    const llm = regs.find((r) => r.type_name === TYPE_LLM_DECIDER);
    expect(llm?.kind).toBe(NODE_KIND_LLM);
    expect(llm?.label).toBe('LLM 决策');
    expect(llm?.description).toBe('单节点内完成模型流式 + 工具回合');
    expect(llm?.flags).toEqual({ terminal: true });
    const tool = regs.find((r) => r.type_name === TYPE_TOOL_PIPELINE);
    expect(tool?.kind).toBe(NODE_KIND_TOOL);
    expect(tool?.label).toBe('工具流水线');
    expect(tool?.flags).toBeNull();
    await runtime.stop();
  });

  it('配方 pool_seed 数据可覆写（node_types 数据源生效；引擎类型按种子注册）', async () => {
    const base = default_engine_pool_seed();
    const seed: EnginePoolSeed = {
      enabled: true,
      node_types: base.node_types.filter((seedRow) => seedRow.type === TYPE_LLM_DECIDER),
    };
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _minimal_recipe({ pool_seed: seed }),
    );
    // 种子数据源生效：仅 llm_decider 入注册池（tool_pipeline 不注册）
    expect(runtime.graph_registries!.nodes.has(TYPE_LLM_DECIDER)).toBe(true);
    expect(runtime.graph_registries!.nodes.has(TYPE_TOOL_PIPELINE)).toBe(false);
    await runtime.stop();
  });
});
