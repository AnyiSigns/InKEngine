/**
 * 引擎内置基础节点类型（llm_decider/tool_pipeline）执行与注册测试。
 *
 * - 注册面：register_engine_node_types 把种子类型/契约/回环条件边装进
 *   GraphRegistries，重复注册幂等跳过；
 * - 数据图直接执行：dict 装载（入口/节点类型引用/静态边/出口）在 bound
 *   registries + memory storage 下经 Engine.ainvoke 真实出 reply（无模型 =
 *   确定性 stub 语义）；工具回合 seam 绑定（stub 模型 + stub 流水线）下
 *   模型产出工具调用 → 逐条执行 → 结果回灌 → 收口回复，消息链随 state
 *   持久化、审批中断不重复执行已落结果工具。
 */
import { describe, expect, it } from 'vitest';

import { GraphRegistries } from '../../../src/core/registry/registry.js';
import {
  ROLE_TERMINAL,
  TYPE_LLM_DECIDER,
  TYPE_TOOL_PIPELINE,
  bind_engine_node_seams,
  default_engine_pool_seed,
  register_engine_node_types,
} from '../../../src/core/nodes/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { Engine } from '../../../src/kernel/executor/index.js';
import { RunOptions } from '../../../src/core/run_result/run_result.js';
import { CollectorTransport } from '../../../src/core/events/events.js';
import { MemoryStorage } from '../../kernel/executor/helpers.js';
import { ToolSpec } from '../../../src/kernel/llm/tools.js';
import { ToolPipeline } from '../../../src/kernel/tool_pipeline/tool_pipeline.js';
import type { AsyncLLM, LLMChunk } from '../../../src/kernel/llm/_guard_types.js';
import { ToolCallDelta } from '../../../src/kernel/llm/_shapes.js';
import { ENGINE_STUB_REPLY } from '../../../src/core/nodes/index.js';

/** 装配测试注册表（引擎内置池种子；契约池含 llm_decider/tool_pipeline）。 */
function seeded_registries(): GraphRegistries {
  const registries = new GraphRegistries();
  const seed = default_engine_pool_seed();
  expect(seed.enabled).toBe(true);
  register_engine_node_types(registries, seed.node_types);
  return registries;
}

/** 数据图定义（入口 llm_decider → terminal 出口；验收图形态）。 */
function chat_graph_data(): Record<string, unknown> {
  return {
    name: 'chat.a1',
    entry: TYPE_LLM_DECIDER,
    nodes: {
      [TYPE_LLM_DECIDER]: {
        type: TYPE_LLM_DECIDER,
        config: { max_tool_rounds: 3 },
      },
      end: { type: TYPE_TOOL_PIPELINE, config: { role: ROLE_TERMINAL } },
    },
    edges: { [TYPE_LLM_DECIDER]: [{ target: 'end' }] },
    exits: ['end'],
    subgraphs: {},
    schema: null,
  };
}

/** 事件收集传输。 */
class FakeTransport {
  readonly events: unknown[] = [];
  async send(event: unknown): Promise<void> {
    this.events.push(event);
  }
}

/** 按配置脚本应答的 stub 模型（首轮带工具调用增量，后续收口）。 */
class ScriptedLLM implements AsyncLLM {
  readonly adapter = 'stub';
  readonly config = { adapter: 'stub', model_id: 'stub', base_url: '' };
  rounds = 0;

  async ainvoke(): Promise<never> {
    throw new Error('stub 仅流式（astream）');
  }

  async *astream(): AsyncIterable<LLMChunk> {
    this.rounds += 1;
    if (this.rounds === 1) {
      yield {
        token: '前置',
        tool_calls_delta: [
          new ToolCallDelta({ index: 0, id: 'c1', name: 'echo', arguments_delta: '{"msg":"你好"}' }),
        ],
      };
      return;
    }
    yield { token: '完成', tool_calls_delta: null };
  }

  async aclose(): Promise<void> {}
}

describe('register_engine_node_types 注册面', () => {
  it('种子类型/契约/条件边装进注册表；重复注册幂等', () => {
    const registries = seeded_registries();
    expect(registries.nodes.types()).toEqual([TYPE_LLM_DECIDER, TYPE_TOOL_PIPELINE]);
    expect(registries.nodes.has(TYPE_LLM_DECIDER)).toBe(true);
    expect(registries.nodes.contract_for(TYPE_LLM_DECIDER)).toBeTruthy();
    expect(registries.nodes.contract_for(TYPE_TOOL_PIPELINE)).toBeTruthy();
    expect(registries.edges.has('llm.pending_nonempty')).toBe(true);
    expect(registries.edges.has('llm.pending_empty')).toBe(true);
    // 幂等：重复登记跳过（不抛重复注册错误）
    const seed = default_engine_pool_seed();
    register_engine_node_types(registries, seed.node_types);
    expect(registries.nodes.size).toBe(2);
  });
});

describe('数据图直接执行（llm_decider → terminal）', () => {
  it('无模型绑定 = 确定性 stub 回复（reply_token 逐帧发射）', async () => {
    const registries = seeded_registries();
    const graph = Graph.from_dict(chat_graph_data(), {
      registry: registries.nodes,
      edge_registry: registries.edges,
      validate: true,
    });
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    const engine = new Engine(
      graph,
      new RunOptions({ storage, registries }),
    );
    const result = await engine.ainvoke(
      { input: '你好' },
      { thread_id: 't-stub', round_id: 'r1', transports: [transport as never] },
    );
    expect(result.reason).toBe('reply');
    expect((result.state as Record<string, unknown>)['reply']).toBe(ENGINE_STUB_REPLY);
    const tokens = (transport.events as Array<{ type?: string; payload?: Record<string, unknown> }>)
      .filter((event) => event.type === 'reply_token')
      .map((event) => String(event.payload?.['token'] ?? ''))
      .join('');
    expect(tokens).toBe(ENGINE_STUB_REPLY);
    const cps = await storage.list_checkpoints('t-stub', { limit: 100 });
    expect(cps.length).toBeGreaterThan(0);
  });

  it('bound seams（stub 模型 + stub 流水线）：工具回合执行 + 结果回灌 + 收口', async () => {
    const registries = seeded_registries();
    const llm = new ScriptedLLM();
    const echoSpec = new ToolSpec({ name: 'echo', description: '回声工具' });
    const executed: Array<{ spec: string; args: Record<string, unknown> }> = [];
    const pipeline = new ToolPipeline({
      allow_unchecked: true,
      executor: async (_ctx, spec, args) => {
        executed.push({ spec: spec.name, args: { ...args } });
        return `echo:${String(args['msg'] ?? '')}`;
      },
    });
    bind_engine_node_seams(registries, {
      llm,
      tool_pipeline: pipeline,
      tool_specs: [echoSpec],
      all_tool_specs: [echoSpec],
      collect_specs: null,
    });
    const graph = Graph.from_dict(chat_graph_data(), {
      registry: registries.nodes,
      edge_registry: registries.edges,
      validate: true,
    });
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    const engine = new Engine(graph, new RunOptions({ storage, registries }));
    const result = await engine.ainvoke(
      { input: '请回声' },
      { thread_id: 't-tool', round_id: 'r1', transports: [transport as never] },
    );
    expect(result.reason).toBe('reply');
    const state = result.state as Record<string, unknown>;
    expect(state['reply']).toBe('完成');
    expect(executed.length).toBe(1);
    expect(executed[0]!.spec).toBe('echo');
    expect(executed[0]!.args).toEqual({ msg: '你好' });
    // 工具结果以 tool 消息回灌消息链并随 state 持久化
    const messages = state['messages'] as Array<{
      role: string;
      content: string;
      tool_calls?: unknown;
      tool_call_id?: string | null;
    }>;
    expect(messages.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))).toBe(true);
    expect(messages.some((message) => message.role === 'tool' && message.content === 'echo:你好' && message.tool_call_id === 'c1')).toBe(true);
    // 终态节点（tool_pipeline role=terminal）执行完毕图即出口
    const tokens = (transport.events as Array<{ type?: string; payload?: Record<string, unknown> }>)
      .filter((event) => event.type === 'reply_token')
      .map((event) => String(event.payload?.['token'] ?? ''))
      .join('');
    expect(tokens).toBe('前置完成');
  });
});
