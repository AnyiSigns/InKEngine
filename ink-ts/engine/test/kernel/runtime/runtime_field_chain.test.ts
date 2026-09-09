/**
 * P4.2a-3 字段链端到端 + 组装候选多样性：
 * - 组装（默认出厂池）产出**不同候选链**：单节点 llm_decider 兜底与
 *   planner→reviewer→main 字段链并存，顶选 = 字段链；候选链节点绑定携带
 *   实例 config（output_field/read_fields 分化随图定义真实生效）；
 * - planner→reviewer→main 真字段链执行：plan/review 值跨节点传递，下游节点
 *   提示含上游产出投影（只读投影进提示、不进持久化消息链）；
 * - 出厂边先验装配（recipe.seed_edges_enabled）：evidence 面含 planner→
 *   reviewer / reviewer→main 行；executor 解耦登记（engine:llm_decider）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { GraphRegistries } from '../../../src/core/registry/registry.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { Engine } from '../../../src/kernel/executor/index.js';
import { RunOptions } from '../../../src/core/run_result/run_result.js';
import { MemoryStorage } from '../executor/helpers.js';
import { DefaultInterruptPolicy } from '../../../src/kernel/approval/approval.js';
import { ToolPipeline } from '../../../src/kernel/tool_pipeline/tool_pipeline.js';
import { LLMChunk, LLMConfig } from '../../../src/kernel/llm/base.js';
import type { AsyncLLM } from '../../../src/kernel/llm/_guard_types.js';
import type { Message } from '../../../src/kernel/llm/messages.js';
import type { ToolSpec } from '../../../src/kernel/llm/tools.js';
import type { LLMParams } from '../../../src/kernel/llm/base.js';
import { Runtime, AssemblyRecipe } from '../../../src/kernel/runtime/index.js';
import type { Host } from '../../../src/kernel/runtime/index.js';
import { set_default_assembly_runtime } from '../../../src/kernel/path_assembler/index.js';
import { AssemblyRequest } from '../../../src/kernel/path_assembler/index.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/kernel/self_tools/index.js';
import type { SelfToolContext } from '../../../src/kernel/self_tools/index.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import {
  STATE_PLAN,
  STATE_REVIEW,
  TYPE_LLM_DECIDER,
  TYPE_LLM_MAIN,
  TYPE_LLM_PLANNER,
  TYPE_LLM_REVIEWER,
  bind_engine_node_seams,
  default_engine_pool_seed,
  register_engine_node_types,
} from '../../../src/core/nodes/index.js';

/** 记录每次 astream 收到的消息链 + 按调用序回放正文（字段链 3 节点）。 */
function scriptedChainLLM(replies: readonly string[]): { llm: AsyncLLM; seen: Message[][] } {
  const seen: Message[][] = [];
  let call = 0;
  const llm = {
    adapter: 'fake',
    config: new LLMConfig({ adapter: 'fake', model_id: 'm', base_url: 'http://x' }),
    async ainvoke(): Promise<never> {
      throw new Error('字段链测试只走 astream');
    },
    async *astream(
      messages: readonly Message[],
      _opts?: { tools?: readonly ToolSpec[] | null; params?: LLMParams | null },
    ): AsyncIterable<LLMChunk> {
      seen.push([...messages]);
      const text = replies[call] ?? '收口';
      call += 1;
      if (text !== '') yield new LLMChunk({ token: text });
    },
    async aclose(): Promise<void> {},
  } as AsyncLLM;
  return { llm, seen };
}

const textOf = (messages: readonly Message[]): string =>
  messages
    .map((m) => String((m as unknown as { content: string }).content ?? ''))
    .join('\n');

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

/** 最小装配配方（默认池种子；机制开关引擎缺省）。 */
function _recipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'p42a3',
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

/** 出厂池种子 config 表（按类型名取实例 config_defaults）。 */
function defaultInstanceConfigs(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const row of default_engine_pool_seed().node_types) {
    out[row.type] = { ...row.default_config };
  }
  return out;
}

function chat_request(domain = 'chat', top_k = 8): AssemblyRequest {
  return new AssemblyRequest({
    goal_schema: new SchemaSpec({
      name: 'goal',
      fields: [new SchemaField({ name: 'reply', required: true, kind: FIELD_STRING })],
    }),
    entry_fields: [],
    domain,
    top_k,
  });
}

describe('组装候选多样性（可区分实例在池）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('默认池组装产出字段链候选（顶选）与单节点兜底候选；绑定携带实例 config', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _recipe());
    // executor 解耦登记：llm_planner 实例键登记为 engine:llm_decider 执行体
    const plannerReg = runtime.node_registrations().find((row) => row.type_name === TYPE_LLM_PLANNER);
    expect(plannerReg?.executor).toBe('engine:llm_decider');
    expect(runtime.graph_registries!.nodes.has(TYPE_LLM_PLANNER)).toBe(true);

    const result = await runtime.assembly_runtime!.assemble_plan(chat_request('chat', 8));
    expect(result.is_empty).toBe(false);
    const chains = result.candidates.map((candidate) => candidate.chain);
    expect(chains[0]).toEqual([TYPE_LLM_PLANNER, TYPE_LLM_REVIEWER, TYPE_LLM_MAIN]);
    expect(chains).toContainEqual([TYPE_LLM_DECIDER]);
    // 顶选字段链绑定实例 config：planner 带 output_field=plan、main 带 read_fields
    const top = result.candidates[0]!;
    const bindings = top.graph.node_bindings;
    expect((bindings[TYPE_LLM_PLANNER]!.config as Record<string, unknown>)['output_field']).toBe(STATE_PLAN);
    expect((bindings[TYPE_LLM_REVIEWER]!.config as Record<string, unknown>)['output_field']).toBe(STATE_REVIEW);
    expect((bindings[TYPE_LLM_MAIN]!.config as Record<string, unknown>)['read_fields']).toEqual([
      STATE_PLAN,
      STATE_REVIEW,
    ]);
    await runtime.stop();
  });
});

describe('planner→reviewer→main 真字段链执行', () => {
  it('plan/review 跨节点传值；下游提示含上游产出投影（不进持久化消息链）', async () => {
    const registries = new GraphRegistries();
    register(registries);
    const { llm, seen } = scriptedChainLLM(['PLAN:先检索', 'REVIEW:计划可行', 'REPLY:完成答复']);
    bind_engine_node_seams(registries, {
      llm,
      tool_pipeline: new ToolPipeline({ allow_unchecked: true, executor: async () => 'ok' }),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
    });
    const configs = defaultInstanceConfigs();
    const graphData = {
      name: 'chain.field',
      entry: 'p',
      nodes: {
        p: { type: TYPE_LLM_PLANNER, config: configs[TYPE_LLM_PLANNER] },
        r: { type: TYPE_LLM_REVIEWER, config: configs[TYPE_LLM_REVIEWER] },
        m: { type: TYPE_LLM_MAIN, config: configs[TYPE_LLM_MAIN] },
      },
      edges: { p: [{ target: 'r' }], r: [{ target: 'm' }] },
      exits: ['m'],
      subgraphs: {},
      schema: null,
    };
    const graph = Graph.from_dict(graphData, {
      registry: registries.nodes,
      edge_registry: registries.edges,
      validate: true,
    });
    const engine = new Engine(graph, new RunOptions({ storage: new MemoryStorage(), registries }));
    const result = await engine.ainvoke(
      { input: '给个方案' },
      { thread_id: 't-chain', round_id: 'r1' },
    );
    const state = result.state as Record<string, unknown>;
    expect(state[STATE_PLAN]).toBe('PLAN:先检索');
    expect(state[STATE_REVIEW]).toBe('REVIEW:计划可行');
    expect(state['reply']).toBe('REPLY:完成答复');
    // 下游提示含上游产出投影（reviewer 见 plan；main 见 plan+review）
    expect(textOf(seen[1]!)).toContain('PLAN:先检索');
    expect(textOf(seen[2]!)).toContain('PLAN:先检索');
    expect(textOf(seen[2]!)).toContain('REVIEW:计划可行');
    // 投影不进持久化消息链（消息链内无只读投影块，字段值只随 state 通道）
    const stored = JSON.stringify(state['messages']);
    expect(stored).not.toContain('只读投影');
  });
});

describe('出厂边先验装配（recipe.seed_edges_enabled）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('开启后 evidence 面含 planner→reviewer / reviewer→main 先验行', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _recipe({ seed_edges_enabled: true }));
    const store = runtime.edge_evidence_store!;
    const rows = await store.list_edges('general');
    const pairs = rows.map((row) => {
      const key = row.key as unknown as { src_type?: string; dst_type?: string };
      return [key['src_type'], key['dst_type']];
    });
    expect(pairs).toContainEqual([TYPE_LLM_PLANNER, TYPE_LLM_REVIEWER]);
    expect(pairs).toContainEqual([TYPE_LLM_REVIEWER, TYPE_LLM_MAIN]);
    await runtime.stop();
  });
});

// 装配测试注册表：引擎内置池种子（可区分实例 executor 解耦注册）。
function register(registries: GraphRegistries): void {
  register_engine_node_types(registries, default_engine_pool_seed().node_types);
}
