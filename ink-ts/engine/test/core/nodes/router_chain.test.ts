/**
 * router_judge 多结点链组装与执行（P4.2a 验证用链）：
 * 「router → [llm_decider | tool_pipeline(terminal)]」——router 单次判断产出
 * 目标 key 写入 `_route_to`，`route:<key>` 条件边把走向分发给对应分支。
 *
 * 覆盖：route:A 命中 → llm_decider 分支产出回复、route:B 命中 → 直达终态；
 * 未命中候选 → 显式空走向（写空串）收尾不猜分支；无模型 → 空走向收尾不崩溃；
 * route 条件族注册面防御（空 key / 含 ':' key 拒绝；幂等；判定只认精确 key）。
 */
import { describe, expect, it } from 'vitest';

import { GraphRegistries } from '../../../src/core/registry/registry.js';
import {
  ROLE_TERMINAL,
  STATE_ROUTE_TO,
  TYPE_LLM_DECIDER,
  TYPE_ROUTER_JUDGE,
  TYPE_TOOL_PIPELINE,
  bind_engine_node_seams,
  default_engine_pool_seed,
  register_engine_node_types,
  register_route_edge_condition,
  register_route_edge_conditions,
} from '../../../src/core/nodes/index.js';
import { Graph } from '../../../src/model/graph/graph.js';
import { Engine } from '../../../src/kernel/executor/index.js';
import { RunOptions } from '../../../src/core/run_result/run_result.js';
import { GraphDefinitionError } from '../../../src/model/errors.js';
import { MemoryStorage } from '../../kernel/executor/helpers.js';
import { ToolPipeline } from '../../../src/kernel/tool_pipeline/tool_pipeline.js';
import type { AsyncLLM, LLMChunk } from '../../../src/kernel/llm/_guard_types.js';
import type { Message } from '../../../src/kernel/llm/messages.js';

/** 按调用序回放正文的 stub 模型（router/llm_decider 共用同一 seam）。 */
function scriptedLLM(replies: readonly string[]): { llm: AsyncLLM; holder: { calls: number } } {
  const holder = { calls: 0 };
  const llm = {
    adapter: 'fake',
    config: { adapter: 'fake', model_id: 'm', base_url: '' },
    async ainvoke(): Promise<never> {
      throw new Error('链测试只走 astream');
    },
    async *astream(_messages: readonly Message[]): AsyncIterable<LLMChunk> {
      holder.calls += 1;
      const text = replies[holder.calls - 1] ?? '';
      if (text !== '') yield { token: text, tool_calls_delta: null };
    },
    async aclose(): Promise<void> {},
  } as AsyncLLM;
  return { llm, holder };
}

/** 装配测试注册表：引擎内置池种子 + route:<key> 条件族登记。 */
function seeded_registries(keys: readonly string[]): GraphRegistries {
  const registries = new GraphRegistries();
  register_engine_node_types(registries, default_engine_pool_seed().node_types);
  register_route_edge_conditions(registries, keys);
  return registries;
}

/** 路由分岔数据图（judge 静态路由 → A 分支 llm_decider 回复 / B 分支直达终态）。 */
function route_graph_data(): Record<string, unknown> {
  return {
    name: 'route.demo',
    entry: 'judge',
    nodes: {
      judge: {
        type: TYPE_ROUTER_JUDGE,
        config: {
          routes: [
            { key: 'A', label: '直接回答', description: '目标已明确直接回复' },
            { key: 'B', label: '走终态', description: '无需回复直接收口' },
          ],
        },
      },
      answer: { type: TYPE_LLM_DECIDER, config: { max_tool_rounds: 3 } },
      end_a: { type: TYPE_TOOL_PIPELINE, config: { role: ROLE_TERMINAL } },
      end_b: { type: TYPE_TOOL_PIPELINE, config: { role: ROLE_TERMINAL } },
    },
    edges: {
      judge: [
        { target: 'answer', condition: 'route:A' },
        { target: 'end_b', condition: 'route:B' },
      ],
      answer: [{ target: 'end_a' }],
    },
    exits: ['end_a', 'end_b'],
    subgraphs: {},
    schema: null,
  };
}

/** 按注册表重建数据图并执行；返回最终 state + reason。 */
async function run_route_graph(
  llm: AsyncLLM | null,
  keys: readonly string[],
): Promise<{ state: Record<string, unknown>; reason: string }> {
  const registries = seeded_registries(keys);
  if (llm !== null) {
    bind_engine_node_seams(registries, {
      llm,
      tool_pipeline: new ToolPipeline({ allow_unchecked: true, executor: async () => '工具结果' }),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
    });
  }
  const graph = Graph.from_dict(route_graph_data(), {
    registry: registries.nodes,
    edge_registry: registries.edges,
    validate: true,
  });
  const storage = new MemoryStorage();
  const engine = new Engine(graph, new RunOptions({ storage, registries }));
  const result = await engine.ainvoke(
    { input: '走哪条分支' },
    { thread_id: 't-route', round_id: 'r1' },
  );
  return { state: { ...result.state }, reason: result.reason };
}

describe('router 多结点链：路由分支走向', () => {
  it('route:A 命中 → 走 llm_decider 分支产出回复（非选中分支未执行）', async () => {
    const { llm, holder } = scriptedLLM(['A', '完成']);
    const { state, reason } = await run_route_graph(llm, ['A', 'B']);
    expect(reason).toBe('reply');
    expect(state[STATE_ROUTE_TO]).toBe('A');
    expect(state['reply']).toBe('完成');
    // 仅 router 判断一次 + llm_decider 回复一次；终态分支不消耗模型调用
    expect(holder.calls).toBe(2);
  });

  it('route:B 命中 → 直达终态收口（llm_decider 分支未执行、无回复）', async () => {
    const { llm, holder } = scriptedLLM(['B']);
    const { state, reason } = await run_route_graph(llm, ['A', 'B']);
    expect(reason).toBe('reply');
    expect(state[STATE_ROUTE_TO]).toBe('B');
    expect(state['reply']).toBeUndefined();
    expect(holder.calls).toBe(1);
  });

  it('模型未命中候选 → 写空走向、无分支被选（回合以 stop 诚实收尾）', async () => {
    const { llm } = scriptedLLM(['X']);
    const { state, reason } = await run_route_graph(llm, ['A', 'B']);
    expect(state[STATE_ROUTE_TO]).toBe('');
    expect(state['reply']).toBeUndefined();
    expect(reason).toBe('stop');
  });

  it('无模型（seams.llm null）→ 空走向、回合不崩溃（stop 诚实收尾）', async () => {
    const { state, reason } = await run_route_graph(null, ['A', 'B']);
    expect(state[STATE_ROUTE_TO]).toBeUndefined();
    expect(reason).toBe('stop');
  });
});

describe('route 条件族注册面', () => {
  it('注册后可解析：判定只认 state._route_to 精确等于声明 key', async () => {
    const registries = seeded_registries(['A']);
    const cond = registries.edges.create('route:A');
    expect(await cond({ state: { [STATE_ROUTE_TO]: 'A' } })).toBe(true);
    expect(await cond({ state: { [STATE_ROUTE_TO]: 'B' } })).toBe(false);
    expect(await cond({ state: {} })).toBe(false);
    expect(registries.edges.has('route:B')).toBe(false);
  });

  it('重复登记幂等跳过；空 key / 含冒号 key 拒绝', () => {
    const registries = new GraphRegistries();
    register_route_edge_condition(registries, 'A');
    register_route_edge_condition(registries, 'A');
    expect(registries.edges.size).toBe(1);
    expect(() => register_route_edge_condition(registries, '')).toThrow(GraphDefinitionError);
    expect(() => register_route_edge_condition(registries, '  ')).toThrow(GraphDefinitionError);
    expect(() => register_route_edge_condition(registries, 'a:b')).toThrow(GraphDefinitionError);
  });
});
