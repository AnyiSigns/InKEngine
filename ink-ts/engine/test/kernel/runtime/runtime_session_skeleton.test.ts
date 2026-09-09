/**
 * 会话级骨架（P4 §五-b）runtime 集成单测——测的是：
 * - 首轮组装建立骨架（骨架随 checkpoint state 落库，与资产层分离）；
 * - 已有有效骨架 → 下一轮沿骨架推进（无组装动作/无组装事件）；
 * - 骨架失效（类型被治理移除）→ 回落组装用池内新终态候选重建骨架；
 * - 跨 runtime boot（同一存储重启）：登记资产 + 会话骨架均恢复、可续走；
 * - 「进化即留存」：会话内新类型经受控通道入资产层（node_registry 集合），
 *   骨架不携带专属本会话的资产定义（只引用池内类型名）。
 */

// gate: 超限(470 行) - 会话骨架会话生命周期成组单测（同一 helper 多断言便于对照 P4 阶段验收）

import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/kernel/runtime/index.js';
import type { Host } from '../../../src/kernel/runtime/index.js';
import type { RunResult } from '../../../src/core/run_result/run_result.js';
import { set_default_assembly_runtime } from '../../../src/kernel/path_assembler/index.js';
import { CollectorTransport } from '../../../src/core/events/events.js';
import { DefaultInterruptPolicy } from '../../../src/kernel/approval/approval.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/kernel/self_tools/index.js';
import type { SelfToolContext } from '../../../src/kernel/self_tools/index.js';
import { MemoryStorage } from '../executor/helpers.js';
import { deciderOnlyPoolSeed } from './_round_graphs.js';
import { ENGINE_STUB_REPLY, TYPE_LLM_DECIDER } from '../../../src/core/nodes/index.js';
import { NodeContract } from '../../../src/core/contracts/contracts.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import { THREAD_SKELETON_STATE_KEY, ThreadSkeleton } from '../../../src/core/thread_skeleton/index.js';
import type { NodeFactory } from '../../../src/core/registry/registry_types.js';

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

/** 共享存储宿主（同一 MemoryStorage 多次 boot = 跨会话重启恢复断言）。 */
class SharedStorageHost extends FakeHost {
  readonly storage: MemoryStorage = new MemoryStorage();
  override async create_storage(): Promise<MemoryStorage> {
    return this.storage;
  }
}

function toHost(host: FakeHost): Host {
  return host as unknown as Host;
}

/** 会话骨架测试配方（默认开 thread_skeleton_enabled；其余与回合测试一致）。 */
function skeletonRecipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'p4-skeleton',
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
    emit_timeline_events: true,
  });
  base.thread_skeleton_enabled = true;
  return Object.assign(base, overrides);
}

/** 会话骨架测试：读最新 checkpoint 中的骨架（无 = null）。 */
async function latestSkeleton(runtime: Runtime, thread_id: string): Promise<ThreadSkeleton | null> {
  const latest = await runtime.storage!.get_latest_checkpoint(thread_id);
  if (latest === null) return null;
  const raw = latest.state[THREAD_SKELETON_STATE_KEY];
  if (raw === null || raw === undefined) return null;
  return ThreadSkeleton.from_dict(raw);
}

/** 测试用终态类型注册（经受控 node_registry 集合写；flags.terminal=true）。 */
async function registerTerminalNode(
  runtime: Runtime,
  opts: { type_name: string; executor: string },
): Promise<NodeFactory> {
  const factory: NodeFactory = () => async () => ({ reply: `reply:${opts.type_name}` });
  const contract = new NodeContract({
    input_schema: null,
    output_schema: new SchemaSpec({
      name: `${opts.type_name}.output`,
      fields: [new SchemaField({ name: 'reply', required: true, kind: FIELD_STRING })],
    }),
    safety_tier: 0,
    version: 1,
  });
  const store = runtime.node_registry_store;
  if (store === null) {
    throw new Error('测试需要 node_registry_store（boot 后可用）');
  }
  await store.register(
    {
      type_name: opts.type_name,
      contract,
      executor: opts.executor,
      provenance: 'agent',
      status: 'active',
      flags: { terminal: true },
    },
    'test:agent registered terminal node',
  );
  runtime.graph_registries!.nodes.register(opts.type_name, factory, contract);
  return factory;
}

describe('会话级骨架（P4 runtime）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('首轮组装建立骨架并落 checkpoint；下一轮沿骨架推进（无组装事件）', async () => {
    // 本用例沿「单节点最小可行回合」语义断言骨架引用 llm_decider：配方池种子
    // 过滤到 llm_decider 单实例（P4.2a-3 默认池扩充后顶选为字段链实例）。
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      skeletonRecipe({ pool_seed: deciderOnlyPoolSeed() }),
    );
    const firstEvents = new CollectorTransport();
    const first = (await runtime.assemble_round({
      state: { input: '冷启动' },
      thread_id: 't-sk',
      round_id: 'r1',
      transports: [firstEvents],
    })) as RunResult;
    expect(first.reason).toBe('reply');
    expect(first.state['reply']).toBe(ENGINE_STUB_REPLY);
    const firstTypes = new Set(firstEvents.events.map((event) => event.type));
    expect(firstTypes.has('assembly_started')).toBe(true);
    const skeleton1 = await latestSkeleton(runtime, 't-sk');
    expect(skeleton1).not.toBeNull();
    expect(skeleton1!.thread_id).toBe('t-sk');
    expect(skeleton1!.entry).toBe(TYPE_LLM_DECIDER);
    expect(skeleton1!.node_types()).toContain(TYPE_LLM_DECIDER);
    expect(skeleton1!.status).toBe('active');
    // 第二轮回合：有效骨架 → 沿骨架推进（不重新组装 → 无组装事件）
    const secondEvents = new CollectorTransport();
    const second = (await runtime.assemble_round({
      state: { input: '第二轮' },
      thread_id: 't-sk',
      round_id: 'r2',
      transports: [secondEvents],
    })) as RunResult;
    expect(second.reason).toBe('reply');
    const secondTypes = new Set(secondEvents.events.map((event) => event.type));
    expect(secondTypes.has('assembly_started')).toBe(false);
    expect(secondTypes.has('turn_started')).toBe(false);
    expect(secondTypes.has('reply_token')).toBe(true);
    // 骨架持久随第二轮回合 checkpoint（节点结构延续，不重建）
    const skeleton2 = await latestSkeleton(runtime, 't-sk');
    expect(skeleton2).not.toBeNull();
    expect(skeleton2!.nodes).toEqual(skeleton1!.nodes);
    expect(skeleton2!.entry).toBe(skeleton1!.entry);
    await runtime.stop();
  });

  it('骨架失效（类型治理移除）→ 回落组装用池内新终态候选重建骨架', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      skeletonRecipe({ pool_seed: deciderOnlyPoolSeed() }),
    );
    await runtime.assemble_round({
      state: { input: '第一轮' },
      thread_id: 't-fb',
      round_id: 'r1',
    });
    const before = await latestSkeleton(runtime, 't-fb');
    expect(before!.node_types()).toContain(TYPE_LLM_DECIDER);
    // 会话内进化产物：注册新终态类型（受控通道入资产层）+ 治理移除 llm_decider
    const factory = await registerTerminalNode(runtime, {
      type_name: 't_reply_fb',
      executor: 'host.t_reply_fb',
    });
    void factory;
    await runtime.disable_node_type(TYPE_LLM_DECIDER, 'test disable');
    // 既有骨架引用的类型不可执行 = 骨架失效 → 回落组装（新终态候选出单节点图）
    const second = (await runtime.assemble_round({
      state: { input: '第二轮' },
      thread_id: 't-fb',
      round_id: 'r2',
    })) as RunResult;
    expect(second.reason).toBe('reply');
    expect(second.state['reply']).toBe('reply:t_reply_fb');
    const after = await latestSkeleton(runtime, 't-fb');
    expect(after!.node_types()).toEqual(['t_reply_fb']);
    // 注册的类型已在持久资产层（node_registry 集合），非会话临时态
    const registrations = runtime.node_registrations().map((row) => row.type_name);
    expect(registrations).toContain('t_reply_fb');
    expect(runtime.node_registrations().find((row) => row.type_name === 't_reply_fb')!.status).toBe('active');
    await runtime.stop();
  });

  it('「进化即留存」：跨 runtime 重启（同一存储）登记资产 + 会话骨架恢复', async () => {
    const host = new SharedStorageHost();
    const recipe = skeletonRecipe({
      node_executors: { 'host.reply_persist': (() => async () => ({ reply: 'persisted reply' })) as NodeFactory },
      pool_seed: deciderOnlyPoolSeed(),
    });
    const first = await new Runtime().boot(toHost(host), recipe);
    await registerTerminalNode(first, {
      type_name: 't_reply_persist',
      executor: 'host.reply_persist',
    });
    await first.assemble_round({ state: { input: '会话一' }, thread_id: 't-p', round_id: 'r1' });
    const registrations1 = first.node_registrations().map((row) => row.type_name);
    expect(registrations1).toContain('t_reply_persist');
    await first.stop();
    // 重启（第二次 boot 同一 storage）：登记资产恢复 + 骨架随 checkpoint 恢复
    const second = await new Runtime().boot(toHost(host), recipe);
    const restored = second.node_registrations().map((row) => row.type_name);
    expect(restored).toContain('t_reply_persist');
    expect(restored).toContain(TYPE_LLM_DECIDER);
    const skeleton = await latestSkeleton(second, 't-p');
    expect(skeleton).not.toBeNull();
    expect(skeleton!.node_types()).toContain(TYPE_LLM_DECIDER);
    // 沿恢复骨架推进（骨架引用的 llm_decider 仍 active 可执行）
    const continued = (await second.assemble_round({
      state: { input: '会话二' },
      thread_id: 't-p',
      round_id: 'r2',
    })) as RunResult;
    expect(continued.reason).toBe('reply');
    const skeletonAfter = await latestSkeleton(second, 't-p');
    expect(skeletonAfter!.nodes).toEqual(skeleton!.nodes);
    await second.stop();
  });

  it('骨架只携带对池内类型的引用（不携带本会话专属资产定义）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), skeletonRecipe());
    await runtime.assemble_round({ state: { input: '检查' }, thread_id: 't-ref', round_id: 'r1' });
    const skeleton = await latestSkeleton(runtime, 't-ref');
    const poolTypes = new Set(runtime.node_registrations().map((row) => row.type_name));
    for (const type of skeleton!.node_types()) {
      expect(poolTypes.has(type)).toBe(true);
    }
    // 序列化形态不携带任何执行体引用/宿主词（纯 JSON 数据；节点实例只含类型引用）
    const data = JSON.stringify(skeleton!.to_dict());
    expect(data).not.toContain('function');
    await runtime.stop();
  });

  it('validate_skeleton 公开面：合法骨架通过；引用池外类型/结构畸形拒绝', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), skeletonRecipe());
    const valid = new ThreadSkeleton({
      thread_id: 't-v',
      entry: TYPE_LLM_DECIDER,
      nodes: { [TYPE_LLM_DECIDER]: { type: TYPE_LLM_DECIDER } },
      exits: [TYPE_LLM_DECIDER],
    });
    const pass = runtime.validate_skeleton(valid.to_dict());
    expect(pass.ok).toBe(true);
    const unknown = runtime.validate_skeleton({
      thread_id: 't-v',
      entry: 'ghost',
      nodes: { ghost: { type: 'no_such_pool_type' } },
      exits: ['ghost'],
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.reasons.join('')).toContain('未入池类型');
    const malformed = runtime.validate_skeleton({ thread_id: 't-v', nodes: {} });
    expect(malformed.ok).toBe(false);
    await runtime.stop();
  });
});
