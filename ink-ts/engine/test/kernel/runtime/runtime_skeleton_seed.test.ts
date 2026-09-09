/**
 * 会话骨架「显式种子」run 级接线（P4-B-2 可写/可分最小引擎面）——测的是：
 * - 首轮回合 state 显式携带校验过的骨架种子 → 沿种子骨架推进（不组装、不重建），
 *   骨架随本轮 checkpoint 落库；
 * - 非法种子（引用池外类型/结构畸形）→ 回落既有语义（组装建立），不因调用方
 *   预校验而盲信；
 * - 已有 checkpoint 骨架的线程收到显式种子 → 种子优先（命令面「骨架编辑后续跑
 *   沿新骨架推进」接线）；其后再无种子 → 沿上轮 checkpoint 骨架推进（编辑被持久）。
 *
 * 语义归属：本面是 P4 §4.1「可写/可分」的引擎最小接线（host 命令面唯一写口仍
 * 是 validate_skeleton_sketch/mount_skeleton_to_state，本测试直接以引擎 state
 * 承载经同一校验形态的种子；非法种子的回落边界亦在此固化）。
 */

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

/** 骨架种子测试配方（默认开 thread_skeleton_enabled；其余与回合测试一致）。 */
function seedRecipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'p4-skeleton-seed',
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

/** 测试用终态类型注册（经受控 node_registry 集合写；flags.terminal=true）。 */
async function registerTerminalNode(
  runtime: Runtime,
  opts: { type_name: string; executor: string; reply?: string },
): Promise<void> {
  const reply = opts.reply ?? `reply:${opts.type_name}`;
  const factory: NodeFactory = () => async () => ({ reply });
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
  if (store === null) throw new Error('测试需要 node_registry_store（boot 后可用）');
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
}

/** 读最新 checkpoint 中的骨架（无 = null）。 */
async function latestSkeleton(runtime: Runtime, thread_id: string): Promise<ThreadSkeleton | null> {
  const latest = await runtime.storage!.get_latest_checkpoint(thread_id);
  if (latest === null) return null;
  const raw = latest.state[THREAD_SKELETON_STATE_KEY];
  if (raw === null || raw === undefined) return null;
  return ThreadSkeleton.from_dict(raw);
}

/** 单节点终态骨架（种子形态；thread_id 随目标线程）。 */
function singleNodeSkeleton(thread_id: string, type_name: string): ThreadSkeleton {
  return new ThreadSkeleton({
    thread_id,
    entry: type_name,
    nodes: { [type_name]: { type: type_name, config: {} } },
    edges: {},
    exits: [type_name],
    status: 'active',
  });
}

describe('会话骨架显式种子（P4-B-2 run 级接线）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('首轮 state 显式种子 → 沿种子推进（无组装事件），骨架随 checkpoint 落库', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), seedRecipe());
    try {
      await registerTerminalNode(runtime, { type_name: 't_seed_first', executor: 'host.t_seed_first' });
      const events = new CollectorTransport();
      const seed = singleNodeSkeleton('t-seed-a', 't_seed_first');
      const result = (await runtime.assemble_round({
        state: { input: '沿种子', [THREAD_SKELETON_STATE_KEY]: seed.to_dict() },
        thread_id: 't-seed-a',
        round_id: 'r1',
        transports: [events],
      })) as RunResult;
      expect(result.reason).toBe('reply');
      expect(result.state['reply']).toBe('reply:t_seed_first');
      const types = new Set(events.events.map((event) => event.type));
      expect(types.has('assembly_started')).toBe(false);
      const persisted = await latestSkeleton(runtime, 't-seed-a');
      expect(persisted).not.toBeNull();
      expect(persisted!.node_types()).toEqual(['t_seed_first']);
    } finally {
      await runtime.stop();
    }
  });

  it('非法种子（引用池外类型）→ 回落组装建立，不因调用方携带而生效', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), seedRecipe());
    try {
      const events = new CollectorTransport();
      const ghost = singleNodeSkeleton('t-seed-bad', 'ghost_type');
      const result = (await runtime.assemble_round({
        state: { input: '坏种子', [THREAD_SKELETON_STATE_KEY]: ghost.to_dict() },
        thread_id: 't-seed-bad',
        round_id: 'r1',
        transports: [events],
      })) as RunResult;
      expect(result.reason).toBe('reply');
      expect(result.state['reply']).toBe(ENGINE_STUB_REPLY);
      const types = new Set(events.events.map((event) => event.type));
      expect(types.has('assembly_started')).toBe(true);
      const persisted = await latestSkeleton(runtime, 't-seed-bad');
      expect(persisted).not.toBeNull();
      expect(persisted!.node_types()).not.toContain('ghost_type');
    } finally {
      await runtime.stop();
    }
  });

  it('已有 checkpoint 骨架的线程：显式种子优先（编辑接管）→ 持久后无种子仍沿新骨架', async () => {
    // 首轮默认组装 = 单节点终态兜底语义（P4.2a-3 默认池扩充后顶选为字段链
    // 实例；本用例断言首轮骨架引用 llm_decider，池种子过滤回落单实例）。
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      seedRecipe({ pool_seed: deciderOnlyPoolSeed() }),
    );
    try {
      const first = (await runtime.assemble_round({
        state: { input: '第一轮' },
        thread_id: 't-seed-c',
        round_id: 'r1',
      })) as RunResult;
      expect(first.state['reply']).toBe(ENGINE_STUB_REPLY);
      const before = await latestSkeleton(runtime, 't-seed-c');
      expect(before!.node_types()).toContain(TYPE_LLM_DECIDER);

      // 会话内进化产物（受控通道入资产层）→ 编辑后的骨架显式接管下一轮
      await registerTerminalNode(runtime, {
        type_name: 't_seed_edit',
        executor: 'host.t_seed_edit',
        reply: 'edited-path',
      });
      const takeover = singleNodeSkeleton('t-seed-c', 't_seed_edit');
      const edited = (await runtime.assemble_round({
        state: { input: '编辑接管', [THREAD_SKELETON_STATE_KEY]: takeover.to_dict() },
        thread_id: 't-seed-c',
        round_id: 'r2',
      })) as RunResult;
      expect(edited.state['reply']).toBe('edited-path');
      const afterEdit = await latestSkeleton(runtime, 't-seed-c');
      expect(afterEdit!.node_types()).toEqual(['t_seed_edit']);

      // 后续无种子：沿已持久的新骨架推进（编辑不丢，仍不组装）
      const events = new CollectorTransport();
      const next = (await runtime.assemble_round({
        state: { input: '第三轮' },
        thread_id: 't-seed-c',
        round_id: 'r3',
        transports: [events],
      })) as RunResult;
      expect(next.state['reply']).toBe('edited-path');
      const types = new Set(events.events.map((event) => event.type));
      expect(types.has('assembly_started')).toBe(false);
    } finally {
      await runtime.stop();
    }
  });
});
