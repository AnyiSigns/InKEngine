/**
 * 引擎内置基础节点 boot 接线测试：Runtime 装配默认注册引擎内置池种子 +
 * rebuild seams 绑定 + 组装运行期冷启动 base 图先验注入。
 *
 * - boot 后 graph_registries 含 llm_decider/tool_pipeline 及契约（注册表含
 *   新类型，引擎给多宿主用 = 引擎内置注册，宿主只给数据）；
 * - 冷启动 assemble（chat 域，无缓存/技能/证据）稳定产出合法候选数据图；
 *   候选图在 bound registries + memory storage 下真实执行出 stub 回复。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/kernel/runtime/index.js';
import type { Host } from '../../../src/kernel/runtime/index.js';
import { set_default_assembly_runtime } from '../../../src/kernel/path_assembler/index.js';
import { AssemblyRequest } from '../../../src/kernel/path_assembler/index.js';
import {
  ENGINE_STUB_REPLY,
  TYPE_LLM_DECIDER,
  TYPE_TOOL_PIPELINE,
  default_engine_pool_seed,
} from '../../../src/core/nodes/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { Engine } from '../../../src/kernel/executor/index.js';
import { RunOptions } from '../../../src/core/run_result/run_result.js';
import { DefaultInterruptPolicy } from '../../../src/kernel/approval/approval.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/kernel/self_tools/index.js';
import type { SelfToolContext } from '../../../src/kernel/self_tools/index.js';
import { MemoryStorage } from '../../kernel/executor/helpers.js';

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

/** chat 域组装请求（目标 reply；无缓存/技能/证据的冷启动形态）。 */
function chat_request(domain = 'chat'): AssemblyRequest {
  return new AssemblyRequest({
    goal_schema: new SchemaSpec({
      name: 'goal',
      fields: [new SchemaField({ name: 'reply', required: true, kind: FIELD_STRING })],
    }),
    entry_fields: [],
    domain,
    top_k: 2,
  });
}

/** 按注册表重建数据图并执行（内存存储；无模型 = 确定性 stub 回复）。 */
async function run_graph_data(
  registries: NonNullable<Runtime['graph_registries']>,
  graphData: Record<string, unknown>,
  storage: MemoryStorage,
): Promise<Record<string, unknown>> {
  const graph = Graph.from_dict(graphData, {
    registry: registries.nodes,
    edge_registry: registries.edges,
    validate: true,
  });
  const engine = new Engine(graph, new RunOptions({ storage, registries }));
  const result = await engine.ainvoke({ input: '冷启动' }, { thread_id: 't-cold', round_id: 'r1' });
  return { ...result.state, _reason: result.reason };
}

describe('Runtime boot：引擎内置池种子注册 + 冷启动组装', () => {
  it('boot 后注册表含引擎内置类型及契约', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    const registries = runtime.graph_registries!;
    expect(registries.nodes.has(TYPE_LLM_DECIDER)).toBe(true);
    expect(registries.nodes.has(TYPE_TOOL_PIPELINE)).toBe(true);
    expect(registries.nodes.contract_for(TYPE_LLM_DECIDER)).toBeTruthy();
    expect(registries.edges.has('llm.pending_nonempty')).toBe(true);
    await runtime.stop();
  });

  it('冷启动 assemble（chat 域）出合法候选并真实执行出 stub 回复', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    const assembler = runtime.assembly_runtime!;
    const result = await assembler.assemble_plan(chat_request('chat'));
    expect(result.is_empty).toBe(false);
    const first = result.candidates[0]!;
    expect(first.graph.node_bindings[TYPE_LLM_DECIDER]).toBeTruthy();
    expect(first.source).toBeTruthy();
    const graphData = first.to_dict()['graph'] as Record<string, unknown>;
    const state = await run_graph_data(runtime.graph_registries!, graphData, runtime.storage!.inner as MemoryStorage);
    expect(state['reply']).toBe(ENGINE_STUB_REPLY);
    expect(state['_reason']).toBe('reply');
    await runtime.stop();
  });

  it('配方 pool_seed 数据可覆写（自定义域模板经数据源生效；引擎类型仍注册）', async () => {
    const base = default_engine_pool_seed();
    const seed = {
      ...base,
      domains: [
        {
          domain: 'custom',
          enabled: true,
          graph: {
            name: 'engine.custom',
            entry: TYPE_LLM_DECIDER,
            nodes: {
              [TYPE_LLM_DECIDER]: { type: TYPE_LLM_DECIDER, config: {} },
              end: { type: TYPE_TOOL_PIPELINE, config: { role: 'terminal' } },
            },
            edges: { [TYPE_LLM_DECIDER]: [{ target: 'end' }] },
            exits: ['end'],
          },
        },
      ],
    };
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _minimal_recipe({ pool_seed: seed as never }),
    );
    expect(runtime.graph_registries!.nodes.has(TYPE_LLM_DECIDER)).toBe(true);
    const result = await runtime.assembly_runtime!.assemble_plan(chat_request('custom'));
    expect(result.is_empty).toBe(false);
    const graphData = result.candidates[0]!.to_dict()['graph'] as Record<string, unknown>;
    const state = await run_graph_data(runtime.graph_registries!, graphData, runtime.storage!.inner as MemoryStorage);
    expect(state['reply']).toBe(ENGINE_STUB_REPLY);
    await runtime.stop();
  });
});

afterEach(() => {
  set_default_assembly_runtime(null);
});
