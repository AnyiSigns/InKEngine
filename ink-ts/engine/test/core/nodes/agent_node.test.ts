/**
 * agent 子图型执行体测试（批4：#9 kind=agent + 作用域 llm/model 接线）。
 *
 * 测什么：
 * - 注册面：agent 执行体（executor=agent）可用、register_agent_node_type
 *   登记路径幂等、元数据表带 kind=agent；
 * - 最小递归展开（A）：图内 agent 结点引用实体 → 从实体目录取 EntitySpec →
 *   沿当前图内联展开内部子回路（persona 进子作用域 llm system，自定义层，
 *   boot 基线仍在前）→ reply/消息并入父状态；
 * - 作用域 llm override（B）：实体 model 非 null 时子作用域内 llm 调用使用
 *   resolve_scope_llm 解析出的实例（fake/mock 断言 override 生效、父默认 llm
 *   未被调用）；model:null = 沿用父作用域/会话默认；
 * - 诚实失败（不猜）：实体目录 seam 缺失 / 实体未注册 / model 引用缺解析
 *   seam / 解析失败 = 显式错误；
 * - 递归深度护栏（复用 spawn 护栏参数）：spawn_depth+1 超 spawn_max_depth
 *   拒绝展开。
 */
import { describe, expect, it } from 'vitest';

import { GraphRegistries } from '../../../src/core/registry/registry.js';
import {
  TYPE_AGENT,
  bind_engine_node_seams,
  default_engine_pool_seed,
  has_engine_executor,
  register_agent_node_type,
  register_engine_node_types,
} from '../../../src/core/nodes/index.js';
import { ENGINE_NODE_TYPE_META, NODE_KIND_AGENT } from '../../../src/core/nodes/constants.js';
import { Graph } from '../../../src/model/graph/graph.js';
import { Engine } from '../../../src/kernel/executor/index.js';
import { RunOptions } from '../../../src/core/run_result/run_result.js';
import { EntitySpec } from '../../../src/core/entities/entities.js';
import type { AsyncLLM, LLMChunk } from '../../../src/kernel/llm/_guard_types.js';
import type { Message } from '../../../src/kernel/llm/messages.js';
import { ToolPipeline } from '../../../src/kernel/tool_pipeline/tool_pipeline.js';

/** 装配测试注册表：出厂池种子 + agent 执行体（最小登记路径）。 */
function agent_registries(): GraphRegistries {
  const registries = new GraphRegistries();
  register_engine_node_types(registries, default_engine_pool_seed().node_types);
  expect(register_agent_node_type(registries)).toBe(true);
  return registries;
}

/** 记录调用（入参消息/工具）并按脚本文本应答的 stub 模型。 */
class RecordingLLM implements AsyncLLM {
  readonly adapter = 'recording';
  readonly config = { adapter: 'recording', model_id: 'recording', base_url: '' };
  readonly calls: Array<{ messages: Message[]; tools: unknown }> = [];
  constructor(
    readonly label: string,
    private readonly script: readonly string[],
  ) {}

  async ainvoke(): Promise<never> {
    throw new Error(`${this.label} 仅流式（astream）`);
  }

  async *astream(messages: readonly Message[], opts?: { tools?: unknown }): AsyncIterable<LLMChunk> {
    this.calls.push({ messages: [...messages], tools: opts?.tools ?? null });
    for (const text of this.script) {
      yield { token: text, tool_calls_delta: null };
    }
  }

  async aclose(): Promise<void> {}
}

/** 最小工具流水线（agent scope 内模型不产工具调用时不会触达）。 */
function inert_pipeline(): ToolPipeline {
  return new ToolPipeline({
    allow_unchecked: true,
    executor: async () => 'ok',
  });
}

/** 单节点 agent 图（入口=出口=agent 结点；引用实体后展开内部回路）。 */
function agent_graph(entity_id: string): Graph {
  const graph = new Graph({ name: 'agent.a', entry: 'main', exits: ['main'] });
  graph.add_node_type('main', TYPE_AGENT, { entity_id });
  return graph;
}

describe('agent 执行体注册面 + 元数据', () => {
  it('注册路径幂等：register_agent_node_type 装 agent 执行体；重复登记跳过', () => {
    const registries = agent_registries();
    // engine:agent 执行体绑定可解析（runtime _register_registration_executor
    // 经 has_engine_executor 识别 `engine:agent` 登记行 → 恢复/seed 路径可用）
    expect(has_engine_executor(TYPE_AGENT)).toBe(true);
    expect(registries.nodes.has(TYPE_AGENT)).toBe(true);
    expect(registries.nodes.contract_for(TYPE_AGENT)).toBeTruthy();
    const count = registries.nodes.size;
    expect(register_agent_node_type(registries)).toBe(true);
    expect(registries.nodes.size).toBe(count);
  });

  it('元数据表：agent 类型 kind=agent（六类中 agent 类声明）', () => {
    const meta = ENGINE_NODE_TYPE_META[TYPE_AGENT];
    expect(meta).toBeDefined();
    expect(meta?.kind).toBe(NODE_KIND_AGENT);
  });
});

describe('agent 最小递归展开（A）：实体目录 → 内部子回路', () => {
  it('图内 agent 结点展开实体：persona 作 scope llm system 自定义层，reply 并入父状态', async () => {
    const registries = agent_registries();
    const parentLlm = new RecordingLLM('parent', ['查证汇总答复']);
    const childLlm = new RecordingLLM('child', ['不该用于 model:null 实体']);
    const entities = new Map<string, EntitySpec>([
      ['e1', new EntitySpec({ id: 'e1', label: '研究员', persona: '你是资深研究员', model: null })],
    ]);
    bind_engine_node_seams(registries, {
      llm: parentLlm,
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
      resolve_entity: (id) => entities.get(id) ?? null,
      resolve_scope_llm: null,
    });
    const engine = new Engine(agent_graph('e1'), new RunOptions({ registries }));
    const result = await engine.ainvoke({ input: '请查证并汇总' }, { thread_id: 't-a1', round_id: 'r1' });
    expect(result.reason).toBe('reply');
    const state = result.state as Record<string, unknown>;
    expect(state['reply']).toBe('查证汇总答复');
    // 实体 model null：父默认 llm 被调用（作用域沿用会话默认），child 未被调用
    expect(parentLlm.calls.length).toBe(1);
    expect(childLlm.calls.length).toBe(0);
    // persona 以 system 自定义层进入 scope 消息链（boot 为空 = 原样 persona）
    const first = parentLlm.calls[0]!.messages[0]!;
    expect(first.role).toBe('system');
    expect(first.content).toContain('你是资深研究员');
    // 子作用域消息链随状态回流到父（消息并入父状态）
    const messages = state['messages'] as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.role === 'system' && m.content.includes('你是资深研究员'))).toBe(true);
  });

  it('boot 基线在前：scope persona 作为自定义层不绕过 boot（P4.2b 语义）', async () => {
    const registries = agent_registries();
    const parentLlm = new RecordingLLM('parent', ['boot 层验证']);
    const entities = new Map<string, EntitySpec>([
      ['e1', new EntitySpec({ id: 'e1', persona: '实体自定义层', model: null })],
    ]);
    bind_engine_node_seams(registries, {
      llm: parentLlm,
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '装配注入的只读 boot 基线',
      resolve_entity: (id) => entities.get(id) ?? null,
      resolve_scope_llm: null,
    });
    const engine = new Engine(agent_graph('e1'), new RunOptions({ registries }));
    await engine.ainvoke({ input: '验证' }, { thread_id: 't-a2', round_id: 'r2' });
    const first = parentLlm.calls[0]!.messages[0]!;
    expect(first.role).toBe('system');
    const content = first.content;
    expect(content.startsWith('装配注入的只读 boot 基线')).toBe(true);
    expect(content).toContain('实体自定义层');
    // 拼接顺序：boot 恒在自定义之前
    expect(content.indexOf('装配注入的只读 boot 基线')).toBeLessThan(content.indexOf('实体自定义层'));
  });
});

describe('作用域 llm/model 接线（B）', () => {
  it('实体 model 非 null：scope 内 llm 调用切换 resolve_scope_llm 返回的模型（父默认不被调用）', async () => {
    const registries = agent_registries();
    const parentLlm = new RecordingLLM('parent-default', ['默认模型不应回答']);
    const scopedLlm = new RecordingLLM('scoped', ['我是实体指定模型，已答复']);
    let resolverCalls = 0;
    const entities = new Map<string, EntitySpec>([
      ['e1', new EntitySpec({ id: 'e1', persona: '指定模型的实体', model: { provider: 'testp', model_id: 'm2' } })],
    ]);
    bind_engine_node_seams(registries, {
      llm: parentLlm,
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
      resolve_entity: (id) => entities.get(id) ?? null,
      resolve_scope_llm: (model) => {
        resolverCalls += 1;
        expect(model).toEqual({ provider: 'testp', model_id: 'm2' });
        return scopedLlm;
      },
    });
    const engine = new Engine(agent_graph('e1'), new RunOptions({ registries }));
    const result = await engine.ainvoke({ input: '请回答' }, { thread_id: 't-b1', round_id: 'r3' });
    expect(result.reason).toBe('reply');
    expect((result.state as Record<string, unknown>)['reply']).toBe('我是实体指定模型，已答复');
    // override 生效断言：scoped 模型被调用、父默认未被调用、解析 seam 恰好被问一次
    expect(scopedLlm.calls.length).toBe(1);
    expect(parentLlm.calls.length).toBe(0);
    expect(resolverCalls).toBe(1);
  });

  it('model:null：沿用父作用域/会话默认（不请求 override，父默认 llm 被调用）', async () => {
    const registries = agent_registries();
    const parentLlm = new RecordingLLM('parent-default', ['默认模型回答']);
    let resolverCalls = 0;
    const entities = new Map<string, EntitySpec>([
      ['e1', new EntitySpec({ id: 'e1', persona: '无指定模型实体', model: null })],
    ]);
    bind_engine_node_seams(registries, {
      llm: parentLlm,
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
      resolve_entity: (id) => entities.get(id) ?? null,
      resolve_scope_llm: (model) => {
        resolverCalls += 1;
        void model;
        return null;
      },
    });
    const engine = new Engine(agent_graph('e1'), new RunOptions({ registries }));
    const result = await engine.ainvoke({ input: '请回答' }, { thread_id: 't-b2', round_id: 'r4' });
    expect(result.reason).toBe('reply');
    expect((result.state as Record<string, unknown>)['reply']).toBe('默认模型回答');
    expect(parentLlm.calls.length).toBe(1);
    expect(resolverCalls).toBe(0);
  });

  it('递归深度护栏：agent 展开深度 = spawn_depth+1 超 spawn_max_depth 拒绝（显式 error）', async () => {
    const registries = agent_registries();
    const parentLlm = new RecordingLLM('parent', ['不达此处']);
    const entities = new Map<string, EntitySpec>([
      ['e1', new EntitySpec({ id: 'e1', persona: '深嵌套实体', model: null })],
    ]);
    bind_engine_node_seams(registries, {
      llm: parentLlm,
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
      resolve_entity: (id) => entities.get(id) ?? null,
      resolve_scope_llm: null,
    });
    // 顶层引擎已处于 spawn_depth=2（模拟已在子作用域内再展开 agent）：
    // 展开子作用域 child_depth=3 > spawn_max_depth=2 → fail-closed
    const engine = new Engine(
      agent_graph('e1'),
      new RunOptions({ registries, spawn_depth: 2, spawn_max_depth: 2 }),
    );
    const result = await engine.ainvoke({ input: '深' }, { thread_id: 't-a3', round_id: 'r5' });
    expect(result.reason).toBe('error');
    expect(parentLlm.calls.length).toBe(0);
  });
});

describe('agent 展开的诚实失败（不猜测）', () => {
  it('实体目录 seam 缺失 / 实体未注册：显式错误', async () => {
    const registries = new GraphRegistries();
    register_engine_node_types(registries, default_engine_pool_seed().node_types);
    register_agent_node_type(registries);
    bind_engine_node_seams(registries, {
      llm: new RecordingLLM('p', ['x']),
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
      // resolve_entity 不注入 = 目录 seam 缺失
      resolve_scope_llm: null,
    });
    const fn = registries.nodes.create(TYPE_AGENT, { entity_id: 'e-miss' });
    await expect(fn({ state: { input: 'hi' } })).rejects.toThrow(/resolve_entity 未装配/);

    bind_engine_node_seams(registries, {
      llm: new RecordingLLM('p2', ['x']),
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
      resolve_entity: () => null,
      resolve_scope_llm: null,
    });
    await expect(fn({ state: { input: 'hi' } })).rejects.toThrow(/实体未注册: e-miss/);
  });

  it('实体 model 非 null 但装配未注入 resolve_scope_llm / 解析失败：显式错误不静默跑父模型', async () => {
    const registries = new GraphRegistries();
    register_engine_node_types(registries, default_engine_pool_seed().node_types);
    register_agent_node_type(registries);
    const entity = new EntitySpec({ id: 'e-m', model: { provider: 'p', model_id: 'm' } });
    bind_engine_node_seams(registries, {
      llm: new RecordingLLM('p', ['x']),
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
      resolve_entity: () => entity,
      resolve_scope_llm: null,
    });
    const fn = registries.nodes.create(TYPE_AGENT, { entity_id: 'e-m' });
    await expect(fn({ state: { input: 'hi' } })).rejects.toThrow(/无法 override/);

    bind_engine_node_seams(registries, {
      llm: new RecordingLLM('p2', ['x']),
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
      resolve_entity: () => entity,
      resolve_scope_llm: async () => null,
    });
    await expect(fn({ state: { input: 'hi' } })).rejects.toThrow(/model 引用无法解析/);
  });

  it('内部子回路引用未注册的 scope llm 类型：子图校验期显式报错', async () => {
    const registries = new GraphRegistries();
    register_engine_node_types(registries, default_engine_pool_seed().node_types);
    register_agent_node_type(registries);
    const entity = new EntitySpec({ id: 'e-bad', persona: 'x', model: null });
    bind_engine_node_seams(registries, {
      llm: new RecordingLLM('p', ['x']),
      tool_pipeline: inert_pipeline(),
      tool_specs: [],
      all_tool_specs: [],
      collect_specs: null,
      boot_system_prompt: '',
      resolve_entity: () => entity,
      resolve_scope_llm: null,
    });
    const graph = new Graph({ name: 'agent.bad', entry: 'main', exits: ['main'] });
    graph.add_node_type('main', TYPE_AGENT, { entity_id: 'e-bad', scope_type: 'ghost_llm_type' });
    const engine = new Engine(graph, new RunOptions({ registries }));
    const result = await engine.ainvoke({ input: 'hi' }, { thread_id: 't-bad', round_id: 'r9' });
    // 子图校验失败 → 节点 error（不静默回落其他类型）
    expect(result.reason).toBe('error');
  });

  it('agent 结点 config 缺 entity_id：建图即拒绝（声明不完整不执行）', () => {
    const registries = new GraphRegistries();
    register_engine_node_types(registries, default_engine_pool_seed().node_types);
    register_agent_node_type(registries);
    expect(() => registries.nodes.create(TYPE_AGENT, {})).toThrow(/缺实体引用/);
  });
});
