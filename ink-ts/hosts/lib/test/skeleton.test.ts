/**
 * 会话级骨架 host 接线（P4-B-1 目标 1/3/4）——测的是：
 * - 产品配方默认开启会话级骨架 + 自续护栏（recipe 字段真实流入引擎）：骨架
 *   上显式进化标记 → rounds 收尾自动续回合（护栏内续、超限/关停不续）；
 * - validate_skeleton 入口的 host 可调封装：拒绝池外类型 / 缺出口（可写面
 *   先校验后挂载的接线点），校验通过才写入 state 保留键 _thread_skeleton。
 *
 * runtime 用产品配方装配（build_product_recipe 默认值），writer 测试节点模拟
 * 自修改工具在回合内把续跑意图写入 state（宿主接线目标语义），机制行为在
 * engine（P4-A 已测），这里只验产品配方的会话级接线面。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CollectorTransport,
  DefaultInterruptPolicy,
  FIELD_STRING,
  ROUND_CONTINUATION_STATE_KEY,
  Runtime,
  SchemaField,
  SchemaSpec,
  THREAD_SKELETON_STATE_KEY,
  ThreadSkeleton,
  NodeContract,
  create_storage,
} from '@ink-ts/engine';
import type {
  AsyncLLM,
  Engine,
  EngineTransport,
  Host,
  InterruptPolicy,
  Storage,
} from '@ink-ts/engine';

import { build_product_recipe } from '../src/recipe.js';
import {
  mount_skeleton_to_state,
  validate_skeleton_sketch,
} from '../src/skeleton.js';

/** writer 测试节点类型名（骨架 + 续跑意图标记载体）。 */
const WRITER_TYPE = 'host.session_writer';

/** 最小宿主（真 memory 存储 + 无模型 + 全挂起策略；装配冒烟用）。 */
class FakeHost {
  async create_storage(): Promise<Storage> {
    return create_storage('memory://');
  }
  async resolve_llm(): Promise<AsyncLLM | null> {
    return null;
  }
  interrupt_policy(): InterruptPolicy {
    return new DefaultInterruptPolicy();
  }
  build_transport(): EngineTransport {
    return new CollectorTransport();
  }
  async close(): Promise<void> {}
}

function toHost(host: FakeHost): Host {
  return host as unknown as Host;
}

/** 每个用例独立装配：boot 一次产品配方 runtime。 */
async function productRuntime(): Promise<Runtime> {
  const runtime = new Runtime();
  await runtime.boot(toHost(new FakeHost()), build_product_recipe());
  return runtime;
}

/** writer 节点工厂：每次执行把续跑意图写入 state（reason 非空时）并发射
 *  writer_step 事件（事件计数 = 真实走完的 writer 回合数）。 */
function writerFactory(reason: 'evolved' | null): (config: Record<string, unknown>) => (raw: unknown) => Promise<Record<string, unknown>> {
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

/** 注册 writer 到 runtime（图注册表 + 登记 store 终态候选，可被骨架校验）。 */
async function registerWriter(
  runtime: Runtime,
  reason: 'evolved' | null,
): Promise<void> {
  const factory = writerFactory(reason);
  const contract = new NodeContract({
    input_schema: null,
    output_schema: new SchemaSpec({
      name: 'host.session_writer.output',
      fields: [new SchemaField({ name: 'reply', required: true, kind: FIELD_STRING })],
    }),
    safety_tier: 0,
    version: 1,
  });
  const store = runtime.node_registry_store;
  if (store === null) throw new Error('writer 测试需要 node_registry_store（boot 后可用）');
  await store.register(
    {
      type_name: WRITER_TYPE,
      contract,
      executor: 'host.session_writer',
      provenance: 'agent',
      status: 'active',
      flags: { terminal: true },
    },
    'host.test:register session writer',
  );
  runtime.graph_registries!.nodes.register(WRITER_TYPE, factory, contract);
}

/** writer 单节点图数据（seed 用直接引擎执行；沿骨架回合走 skeleton 数据）。 */
function writerGraphData(): Record<string, unknown> {
  return {
    name: 'host.session_writer',
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

/** seed 回合：直接按图执行把会话骨架 + 图定义写入 checkpoint（后续组装回合读
 *  骨架沿其推进）。 */
async function seedThread(
  runtime: Runtime,
  opts: { thread_id: string; reason: 'evolved' | null },
): Promise<void> {
  await registerWriter(runtime, opts.reason);
  const anyRt = runtime as unknown as {
    _build_graph_engine(
      data: Record<string, unknown>,
      opts?: { llm?: unknown | null; domain?: string | null },
    ): Promise<Engine>;
  };
  const engine = await anyRt._build_graph_engine(writerGraphData(), {});
  await engine.ainvoke(
    {
      input: 'seed',
      [THREAD_SKELETON_STATE_KEY]: writerSkeleton(opts.thread_id).to_dict(),
    },
    { thread_id: opts.thread_id, round_id: 'r-seed', continue_chain: true },
  );
}

/** assemble_round 全程的 writer 回合执行次数（事件面计数，与 checkpoint 数解耦）。 */
function writerSteps(events: CollectorTransport): number {
  return events.events.filter((event) => event.type === 'writer_step').length;
}

/** 单节点 llm_decider 骨架（池内终态类型，校验应通过）。 */
function poolTerminalSkeleton(thread_id: string): ThreadSkeleton {
  return new ThreadSkeleton({
    thread_id,
    entry: 'llm_decider',
    nodes: { llm_decider: { type: 'llm_decider', config: {} } },
    edges: {},
    exits: ['llm_decider'],
    status: 'active',
  });
}

describe('产品会话级骨架（recipe 默认开 + 续跑护栏接线）', () => {
  let runtime: Runtime;

  beforeEach(async () => {
    runtime = await productRuntime();
  });

  afterEach(async () => {
    await runtime.stop();
  });

  it('骨架写意图 evolved：默认自续护栏 3 → 用户轮 + 3 自动轮（护栏钳制不 runaway）', async () => {
    await seedThread(runtime, { thread_id: 'host-t-evo', reason: 'evolved' });
    const events = new CollectorTransport();
    const result = (await runtime.assemble_round({
      state: {},
      thread_id: 'host-t-evo',
      round_id: 'r-user',
      transports: [events],
    })) as { reason: string; state: Record<string, unknown> };
    expect(result.reason).toBe('reply');
    expect(result.state['reply']).toBe('step:evolved');
    expect(writerSteps(events)).toBe(4);
  });

  it('配方覆写 auto_continue_limit=1 → 恰好 1 轮自动续（2 次 writer）', async () => {
    const limited = new Runtime();
    await limited.boot(toHost(new FakeHost()), build_product_recipe({ session: { auto_continue_limit: 1 } }));
    try {
      await seedThread(limited, { thread_id: 'host-t-limit', reason: 'evolved' });
      const events = new CollectorTransport();
      await limited.assemble_round({
        state: {},
        thread_id: 'host-t-limit',
        round_id: 'r-user',
        transports: [events],
      });
      expect(writerSteps(events)).toBe(2);
    } finally {
      await limited.stop();
    }
  });

  it('配方覆写 auto_continue_limit=0（关闭自续）：意图被忽略，用户轮即停', async () => {
    const off = new Runtime();
    await off.boot(toHost(new FakeHost()), build_product_recipe({ session: { auto_continue_limit: 0 } }));
    try {
      await seedThread(off, { thread_id: 'host-t-off', reason: 'evolved' });
      const events = new CollectorTransport();
      const result = (await off.assemble_round({
        state: {},
        thread_id: 'host-t-off',
        round_id: 'r-user',
        transports: [events],
      })) as { state: Record<string, unknown> };
      expect(result.state['reply']).toBe('step:evolved');
      expect(writerSteps(events)).toBe(1);
    } finally {
      await off.stop();
    }
  });
});

describe('validate_skeleton host 接线点（先校验后挂载）', () => {
  let runtime: Runtime;

  beforeEach(async () => {
    runtime = await productRuntime();
  });

  afterEach(async () => {
    await runtime.stop();
  });

  it('池内终态类型骨架 → 校验通过', () => {
    const check = validate_skeleton_sketch(runtime, poolTerminalSkeleton('host-t-valid'));
    expect(check.ok).toBe(true);
    expect(check.reasons).toEqual([]);
  });

  it('拒绝池外类型（执行体只能来自池）', () => {
    const foreign = new ThreadSkeleton({
      thread_id: 'host-t-foreign',
      entry: 'agent',
      nodes: { agent: { type: 'host.not.in.pool' } },
      edges: {},
      exits: ['agent'],
    });
    const check = validate_skeleton_sketch(runtime, foreign);
    expect(check.ok).toBe(false);
    expect(check.reasons.join('；')).toContain('未入池类型');
  });

  it('拒绝缺出口（骨架不可终止）', () => {
    const noExit = new ThreadSkeleton({
      thread_id: 'host-t-noexit',
      entry: 'llm_decider',
      nodes: { llm_decider: { type: 'llm_decider' } },
      edges: {},
      exits: [],
    });
    const check = validate_skeleton_sketch(runtime, noExit);
    expect(check.ok).toBe(false);
    expect(check.reasons.join('；')).toContain('无出口');
  });

  it('mount_skeleton_to_state：校验通过才写 _thread_skeleton；拒绝不落写', () => {
    const state: Record<string, unknown> = {};
    const valid = mount_skeleton_to_state(
      runtime,
      state,
      poolTerminalSkeleton('host-t-mount'),
    );
    expect(valid.ok).toBe(true);
    expect(valid.mounted).toBe(true);
    const embedded = state[THREAD_SKELETON_STATE_KEY] as Record<string, unknown>;
    expect(embedded['thread_id']).toBe('host-t-mount');
    expect(embedded['nodes']).toEqual({
      llm_decider: { type: 'llm_decider', config: {} },
    });

    const rejected = mount_skeleton_to_state(
      runtime,
      state,
      new ThreadSkeleton({
        thread_id: 'host-t-bad',
        entry: 'agent',
        nodes: { agent: { type: 'host.not.in.pool' } },
        edges: {},
        exits: ['agent'],
      }),
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.mounted).toBe(false);
    // 拒绝后骨架键保持上一次通过挂载的数据（未覆盖）
    expect((state[THREAD_SKELETON_STATE_KEY] as Record<string, unknown>)['thread_id']).toBe(
      'host-t-mount',
    );
  });

  it('runtime 未装配（null）→ 校验入口显式不可用空态', () => {
    const check = validate_skeleton_sketch(null, poolTerminalSkeleton('host-t-null'));
    expect(check.ok).toBe(false);
    expect(check.reasons.join('；')).toContain('validate_skeleton');
  });
});
