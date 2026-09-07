/**
 * run 级组装回合（A2）端到端单测（memory 存储，无默认图）。
 *
 * - boot 不再要求 graph_recipe（引擎机制态无图）；
 * - assemble_round：input/域 → 组装 → 本轮 Engine 执行（事件含组装时间线）；
 * - checkpoint 随 state 落本轮图定义（_round_graph）+ graph_version（digest
 *   自洽）；resume_round/branch 按 checkpoint 关联图重建；
 * - abort 后 CANCELLED 快照保留图定义，可续。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/core/runtime/index.js';
import type { Host } from '../../../src/core/runtime/index.js';
import type { RunResult } from '../../../src/core/run_result/run_result.js';
import { set_default_assembly_runtime } from '../../../src/core/path_assembler/index.js';
import { AssemblyRequest } from '../../../src/core/path_assembler/index.js';
import {
  ENGINE_STUB_REPLY,
  TYPE_LLM_DECIDER,
} from '../../../src/core/nodes/index.js';
import { ROUND_GRAPH_STATE_KEY } from '../../../src/core/runtime/_runtime_rounds.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { CollectorTransport } from '../../../src/core/events/events.js';
import { DefaultInterruptPolicy } from '../../../src/core/approval/approval.js';
import { FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { self_tool_specs, make_self_executor, operation_of } from '../../../src/core/self_tools/index.js';
import type { SelfToolContext } from '../../../src/core/self_tools/index.js';
import { MemoryStorage } from '../executor/helpers.js';
import { TerminateReason } from '../../../src/core/graph/graph_types.js';

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

/** Host 五件套 mock（内存存储 + 直过策略；无模型 → 确定性 stub）。 */
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

/** 无默认图配方（graph_recipe 缺省 null；pool seed 出厂默认）。 */
function _no_graph_recipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'a2-rounds',
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
    graph_recipe: null,
    emit_timeline_events: true,
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

describe('run 级组装回合（无默认图）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('无默认图 boot 成功；assemble_round 冷启动回合出 stub 回复 + 组装/执行事件', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _no_graph_recipe());
    expect(runtime.engine).toBeNull();
    const events = new CollectorTransport();
    const result = (await runtime.assemble_round({
      state: { input: '冷启动' },
      thread_id: 't-round',
      round_id: 'r1',
      transports: [events],
    })) as RunResult;
    expect(result.reason).toBe('reply');
    expect(result.state['reply']).toBe(ENGINE_STUB_REPLY);
    const types = new Set(events.events.map((event) => event.type));
    for (const name of [
      'turn_started',
      'assembly_started',
      'assembly_done',
      'assembly_candidate',
      'execution_started',
    ]) {
      expect(types.has(name)).toBe(true);
    }
    // 图数据链可装载（llm_decider 类型在注册表内）
    const latest = await runtime.storage!.get_latest_checkpoint('t-round');
    expect(latest).not.toBeNull();
    expect(latest!.reason).toBe('reply');
    await runtime.stop();
  });

  it('checkpoint 落本轮图定义（_round_graph）且 graph_version 为其 digest', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _no_graph_recipe());
    await runtime.assemble_round({ state: { input: '图落库' }, thread_id: 't-cp', round_id: 'r1' });
    const latest = await runtime.storage!.get_latest_checkpoint('t-cp');
    expect(latest).not.toBeNull();
    const graphData = latest!.state[ROUND_GRAPH_STATE_KEY] as Record<string, unknown>;
    expect(graphData).toBeTruthy();
    const rebuilt = Graph.from_dict(graphData, {
      registry: runtime.graph_registries!.nodes,
      edge_registry: runtime.graph_registries!.edges,
    });
    expect(rebuilt.digest()).toBe(latest!.graph_version);
    await runtime.stop();
  });

  it('branch/resume_round 按锚点 checkpoint 关联图重建（重放历史图，链叶续接）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _no_graph_recipe());
    const first = (await runtime.assemble_round({
      state: { input: '第一轮' },
      thread_id: 't-br',
      round_id: 'r1',
    })) as RunResult;
    await runtime.assemble_round({ state: { input: '第二轮' }, thread_id: 't-br', round_id: 'r2' });
    const chain = await runtime.storage!.chain_index('t-br');
    expect(chain.length).toBeGreaterThan(0);
    const leaf = Math.max(...chain.map((link) => link.checkpoint_id));
    const anchor = await runtime.storage!.get_checkpoint(leaf);
    expect(anchor).not.toBeNull();
    const anchorGraph = anchor!.state[ROUND_GRAPH_STATE_KEY] as Record<string, unknown>;
    expect(anchorGraph).toBeTruthy();
    const branch = (await runtime.resume_round({
      thread_id: 't-br',
      leaf,
      state: { input: '分支' },
      round_id: 'r-b',
    })) as RunResult;
    expect(branch.checkpoint_id).not.toBe(first.checkpoint_id);
    const newLeaf = await runtime.storage!.get_checkpoint(branch.checkpoint_id!);
    expect(newLeaf).not.toBeNull();
    expect(newLeaf!.state[ROUND_GRAPH_STATE_KEY]).toEqual(anchorGraph);
    expect(newLeaf!.parent_id).toBe(leaf);
    await runtime.stop();
  });

  it('abort 后 CANCELLED 快照保留图定义；resume_round 可续跑', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _no_graph_recipe());
    await runtime.assemble_round({ state: { input: '先跑一轮' }, thread_id: 't-ab', round_id: 'r1' });
    const before = await runtime.storage!.get_latest_checkpoint('t-ab');
    expect(before).not.toBeNull();
    // 模拟在途 run（宿主取消句柄 seam）→ abort 写 CANCELLED 快照
    let rejectFn: ((reason: unknown) => void) | null = null;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectFn = reject;
    });
    let cancelled = false;
    const handle = {
      done: () => cancelled,
      cancel: () => {
        cancelled = true;
        rejectFn?.(new Error('cancelled'));
      },
      then: pending.then.bind(pending),
    };
    const ticket = runtime.begin_run('t-ab');
    runtime.register_active_run_task(handle as never);
    expect(await runtime.abort_current_run()).toBe(true);
    runtime.end_run(ticket);
    const latest = await runtime.storage!.get_latest_checkpoint('t-ab');
    expect(latest).not.toBeNull();
    expect(latest!.reason).toBe(TerminateReason.CANCELLED);
    expect(latest!.state[ROUND_GRAPH_STATE_KEY]).toBeTruthy();
    // 续跑 CANCELLED 快照：按关联图重建，链续新叶不报错
    const resumed = (await runtime.resume_round({
      thread_id: 't-ab',
      leaf: latest!.checkpoint_id,
      state: { input: '继续' },
      round_id: 'r2',
    })) as RunResult;
    expect(resumed.checkpoint_id).not.toBeNull();
    await runtime.stop();
  });
});
