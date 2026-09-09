/**
 * 回合结束自续跑状态机（P4 §4.4/口径决议 12）runtime 单测——测的是：
 * - 自续链护栏：仅在回合正常收尾（reply/stop、无审批卡）且状态带显式续跑
 *   意图（ROUND_CONTINUATION_STATE_KEY）时自动发起下一轮；
 * - 单次显式触发自续链上限（auto_continue_limit）钳制；超限即停回落收尾；
 * - 无续跑配置（旧配方）时意图被忽略——旧行为不变（每轮整图组装照旧）；
 * - 意图只在回合起点重置——每一轮续跑都须重新显式声明（防 runaway）。
 *
 * 续跑意图由「会写意图标记的测试节点」在每个回合执行时写入 state（模拟 P4-B
 * 自修改工具在回合内的声明式产物），引擎回合收尾按其解析。
 */

// gate: 超限(430 行) - 自续跑护栏成组单测（同一 seed helper 多护栏断言，便于对照 P4 §4.4）

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
import { NodeContract } from '../../../src/core/contracts/contracts.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import {
  ROUND_CONTINUATION_STATE_KEY,
  THREAD_SKELETON_STATE_KEY,
} from '../../../src/kernel/runtime/index.js';
import { ThreadSkeleton } from '../../../src/core/thread_skeleton/index.js';
import { runRoundEngine, registerNodeType } from './_round_graphs.js';
import type { NodeFactory } from '../../../src/core/registry/registry_types.js';

const WRITER_TYPE = 'test.continue_writer';

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

/** 自续跑配方（默认开会话骨架 + 自续上限 1；overrides 可关）。 */
function autoRecipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'p4-autocontinue',
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
    emit_timeline_events: false,
  });
  base.thread_skeleton_enabled = true;
  base.auto_continue_limit = 1;
  return Object.assign(base, overrides);
}

/** 写续跑意图的测试节点工厂（每次执行显式写入 state 标记并发射 writer_step
 *  事件；事件计数 = 本轮链真实执行的 writer 回合数，可断言自续链长度）。 */
function makeWriterFactory(reason: 'continue' | 'evolved' | null): NodeFactory {
  return () => async (raw: unknown): Promise<Record<string, unknown>> => {
    const ctx = raw as {
      state: Record<string, unknown>;
      emit(type: string, payload: Record<string, unknown>): Promise<void>;
    };
    if (reason !== null) {
      ctx.state[ROUND_CONTINUATION_STATE_KEY] = { reason };
    }
    await ctx.emit('writer_step', {});
    return { reply: `step:${reason ?? 'plain'}` };
  };
}

/** 给 runtime 注册 writer 类型（图注册表 + 登记 store 终态候选，可被骨架校验）。 */
async function registerWriter(runtime: Runtime, reason: 'continue' | 'evolved' | null): Promise<void> {
  const factory = makeWriterFactory(reason);
  const contract = new NodeContract({
    input_schema: null,
    output_schema: new SchemaSpec({
      name: 'writer.output',
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
      type_name: WRITER_TYPE,
      contract,
      executor: 'host.continue_writer',
      provenance: 'agent',
      status: 'active',
      flags: { terminal: true },
    },
    'test:register continue writer',
  );
  runtime.graph_registries!.nodes.register(WRITER_TYPE, factory, contract);
}

/** 构造含 writer 节点单节点图 + 会话骨架数据（entry=exit=writer，0 边）。 */
function writerGraphData(): Record<string, unknown> {
  return {
    name: 'test.continue',
    entry: WRITER_TYPE,
    nodes: { [WRITER_TYPE]: { type: WRITER_TYPE, config: {} } },
    edges: {},
    exits: [WRITER_TYPE],
    subgraphs: {},
    schema: null,
  };
}

function writerSkeleton(thread_id: string): ThreadSkeleton {
  return new ThreadSkeleton({
    thread_id,
    entry: WRITER_TYPE,
    nodes: { [WRITER_TYPE]: { type: WRITER_TYPE, config: {} } },
    edges: {},
    exits: [WRITER_TYPE],
    status: 'active',
  });
}

/** 预置线程：跑一个 writer 回合把骨架 + 图定义写入 checkpoint（后续组装回合读
 *  骨架沿其推进，每轮 writer 再次显式写意图 → 可观测自续链）。 */
async function seedThread(
  runtime: Runtime,
  opts: { thread_id: string; reason: 'continue' | 'evolved' | null },
): Promise<void> {
  await registerWriter(runtime, opts.reason);
  const graphData = writerGraphData();
  await runRoundEngine(runtime, graphData, {
    input: 'seed',
    [THREAD_SKELETON_STATE_KEY]: writerSkeleton(opts.thread_id).to_dict(),
  }, { thread_id: opts.thread_id, round_id: 'r-seed' });
}

/** 链上已收尾回合数（reason 非空 = 该链段真正走完的回合数；中间步骤快照不带
 *  reason——断言用回合数而非原始 checkpoint 数，避免绑定执行器快照细节）。 */
async function finishedRounds(runtime: Runtime, thread_id: string): Promise<number> {
  const chain = await runtime.storage!.chain_index(thread_id);
  return chain.filter((link) => link.reason !== null && link.reason !== undefined).length;
}

/** 统计 assemble_round 全程的 writer 回合执行次数（事件面，与 checkpoint 数解耦）。 */
function writerSteps(events: { events: readonly { type: string }[] }): number {
  return events.events.filter((event) => event.type === 'writer_step').length;
}

describe('回合结束自续跑状态机（P4 §4.4）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('无续跑配置（旧配方）：回合结束带意图也被忽略——旧行为不变（单回合）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), autoRecipe({
      auto_continue_limit: 0,
      thread_skeleton_enabled: false,
    }));
    const result = (await runtime.assemble_round({
      state: { input: '普通回合', [ROUND_CONTINUATION_STATE_KEY]: { reason: 'continue' } },
      thread_id: 't-legacy',
      round_id: 'r1',
    })) as RunResult;
    expect(result.reason).toBe('reply');
    // 无自续：链上只收尾一个回合
    expect(await finishedRounds(runtime, 't-legacy')).toBe(1);
    await runtime.stop();
  });

  it('自续护栏 1：显式意图且正常收尾 → 自动续 1 轮后停（意图须逐轮重声明）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), autoRecipe({ auto_continue_limit: 1 }));
    await seedThread(runtime, { thread_id: 't-auto1', reason: 'continue' });
    const events = new CollectorTransport();
    const result = (await runtime.assemble_round({
      state: {},
      thread_id: 't-auto1',
      round_id: 'r-user',
      transports: [events],
    })) as RunResult;
    expect(result.reason).toBe('reply');
    expect(result.state['reply']).toBe('step:continue');
    // 每轮 writer 都显式写意图 → 恰好 1 轮自续（用户轮 + 1 自动轮），未 runaway
    expect(writerSteps(events)).toBe(2);
    // 回合指标独立 auto 口径：seed 轮 + 用户轮非 auto，仅自续 1 轮计入
    expect(runtime.turn_metrics!.auto_turns).toBe(1);
    await runtime.stop();
  });

  it('自续上限 3：持续显式意图时恰好在 3 轮自动续后停（护栏钳制）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), autoRecipe({ auto_continue_limit: 3 }));
    await seedThread(runtime, { thread_id: 't-auto3', reason: 'evolved' });
    const events = new CollectorTransport();
    const result = (await runtime.assemble_round({
      state: {},
      thread_id: 't-auto3',
      round_id: 'r-user',
      transports: [events],
    })) as RunResult;
    expect(result.reason).toBe('reply');
    expect(result.state['reply']).toBe('step:evolved');
    // 持续意图亦不超过上限：用户轮 + 3 自动轮 = 4 次 writer 执行
    expect(writerSteps(events)).toBe(4);
    // auto 独立口径 = 恰好 3 轮自续
    expect(runtime.turn_metrics!.auto_turns).toBe(3);
    await runtime.stop();
  });

  it('无显式意图（writer 不写标记）：沿骨架推进 1 轮即停，不自动续', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), autoRecipe({ auto_continue_limit: 3 }));
    await seedThread(runtime, { thread_id: 't-plain', reason: null });
    const events = new CollectorTransport();
    const result = (await runtime.assemble_round({
      state: {},
      thread_id: 't-plain',
      round_id: 'r-user',
      transports: [events],
    })) as RunResult;
    expect(result.reason).toBe('reply');
    expect(result.state['reply']).toBe('step:plain');
    expect(writerSteps(events)).toBe(1);
    await runtime.stop();
  });

  it('自续轮起点意图置空：上一轮意图不泄漏为下一轮隐式声明（须显式重写）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), autoRecipe({ auto_continue_limit: 3 }));
    // 预置线程骨架中的 writer 不写意图（reason=null）→ 首轮后无意图即停
    await registerWriter(runtime, null);
    const graphData = writerGraphData();
    await runRoundEngine(runtime, graphData, {
      input: 'seed',
      [THREAD_SKELETON_STATE_KEY]: writerSkeleton('t-clear').to_dict(),
      [ROUND_CONTINUATION_STATE_KEY]: { reason: 'evolved' }, // 上一轮遗留意图
    }, { thread_id: 't-clear', round_id: 'r-seed' });
    const events = new CollectorTransport();
    const result = (await runtime.assemble_round({
      state: {},
      thread_id: 't-clear',
      round_id: 'r-user',
      transports: [events],
    })) as RunResult;
    // 用户轮起点已把遗留意图置空；writer 未重写 → 无续跑
    expect(result.reason).toBe('reply');
    expect(result.state[ROUND_CONTINUATION_STATE_KEY]).toBeNull();
    expect(writerSteps(events)).toBe(1);
    await runtime.stop();
  });

  it('仅限会话骨架校验可走的执行体：池外类型注册到图注册表但未登记终态 → 骨架不可用', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), autoRecipe({ auto_continue_limit: 3 }));
    // 只把 writer 装进图注册表（不落登记 store）→ 骨架校验不过（非池终态成员）
    registerNodeType(runtime, WRITER_TYPE, makeWriterFactory('continue'));
    await runRoundEngine(runtime, writerGraphData(), {
      input: 'seed',
      [THREAD_SKELETON_STATE_KEY]: writerSkeleton('t-nostore').to_dict(),
    }, { thread_id: 't-nostore', round_id: 'r-seed' });
    const events = new CollectorTransport();
    // 骨架引用的类型可执行但非池内登记终态 → 骨架失效 → 回落组装
    // （出厂池 llm_decider 仍可用：单轮 stub 回复；writer 未参与执行）
    const result = (await runtime.assemble_round({
      state: { input: '回落' },
      thread_id: 't-nostore',
      round_id: 'r-user',
      transports: [events],
    })) as RunResult;
    expect(result.reason).toBe('reply');
    expect(writerSteps(events)).toBe(0);
    await runtime.stop();
  });
});
