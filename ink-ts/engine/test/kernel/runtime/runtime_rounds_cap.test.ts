// gate: 超限(390 行) - B4 max_tool_rounds 接运行值专测（声明→组装图 llm_decider config→执行上限/恢复不覆盖）
/**
 * B4 端到端专测：max_tool_rounds 声明接成真实运行值。
 *
 * assemble_round 接受 opts.max_tool_rounds 覆写，把值写入组装出的本轮图
 * llm_decider 节点 config（cap 1..200，缺省引擎常量 8）；checkpoint 随 state
 * 落执行时图（含 config），恢复/分支按 checkpoint 关联图重建不覆盖。
 *
 * 断言：① 覆写 3 → 落库图 llm_decider config=3；② 确定性 stub 模型每轮产
 * 工具调用：max_tool_rounds=1 → 达上限收口（reason=error，工具副作用恰 1 次）；
 * ③ 无覆写 → 引擎缺省 8（工具副作用恰 8 次后收口）；④ 恢复续跑不覆盖
 * （resume_round 重建新叶图 = 锚点图，config 保持原值）。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/kernel/runtime/index.js';
import type { Host } from '../../../src/kernel/runtime/index.js';
import type { RunResult } from '../../../src/core/run_result/run_result.js';
import { set_default_assembly_runtime } from '../../../src/kernel/path_assembler/index.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { ToolSpec } from '../../../src/kernel/llm/tools.js';
import { ToolCallDelta } from '../../../src/kernel/llm/messages.js';
import type { AsyncLLM, LLMChunk } from '../../../src/kernel/llm/_guard_types.js';
import { DefaultInterruptPolicy } from '../../../src/kernel/approval/approval.js';
import {
  self_tool_specs,
  make_self_executor,
  operation_of,
} from '../../../src/kernel/self_tools/index.js';
import type { SelfToolContext } from '../../../src/kernel/self_tools/index.js';
import { ROUND_GRAPH_STATE_KEY } from '../../../src/kernel/runtime/_runtime_rounds.js';
import { MemoryStorage } from '../executor/helpers.js';

/** 探测工具（声明式权限命中 → 经门禁直过执行；副作用计数）。 */
const TOOL_PROBE = 'cap_probe';
const DEMO_PERMISSION = 'demo:apply:*';

/** boot 领域种子（知识集基线条目）。 */
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

/** Host 五件套 mock（内存存储 + 直过策略；llm 由各用例注入）。 */
class FakeHost {
  policy: unknown = new DefaultInterruptPolicy();
  llm: AsyncLLM | null = null;
  async create_storage(): Promise<MemoryStorage> {
    return new MemoryStorage();
  }
  async resolve_llm(): Promise<AsyncLLM | null> {
    return this.llm;
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

/** 无静态图配方：探测工具经 self_specs 注入（声明式权限 demo:apply:*），执行体
 *  = 配方 self_executor_factory seam（计数直出；契约工具回落 make_self_executor）。 */
function capRecipe(executed: string[]): AssemblyRecipe {
  return new AssemblyRecipe({
    set_id: 'b4-cap-round',
    seeds: [['boot', boot_seed_entries]],
    harness_definitions: [
      new HarnessDefinition({ name: 'forge', description: '自举领域', keywords: ['自举'] }),
    ],
    event_type_specs: [new EventTypeSpec({ name: 'reply_token', renderer: 'StreamingRow' })],
    tool_wiring: {
      self_specs: () => [
        ...self_tool_specs(),
        new ToolSpec({ name: TOOL_PROBE, description: '回合上限探测工具', permissions: [DEMO_PERMISSION] }),
      ],
      self_executor_factory: (pipeline, context_getter) => {
        const contract = make_self_executor(
          pipeline,
          context_getter as unknown as () => SelfToolContext,
        );
        return async (
          ctx: unknown,
          spec: ToolSpec,
          args: Record<string, unknown>,
          approval: unknown,
        ): Promise<string> => {
          if (spec.name === TOOL_PROBE) {
            executed.push(spec.name);
            return `probe:${String(args['x'] ?? '')}`;
          }
          return contract(ctx as never, spec, args, approval);
        };
      },
      self_operation_of: (spec) => operation_of(spec),
    },
    approval_levels: {},
    emit_timeline_events: true,
  });
}

/** 确定性工具轮次 stub：每轮都产一次 TOOL_PROBE 工具调用（永不主动收口）。
 *  用于断言达上限即收口（reason=error；副作用次数 = 上限值）。 */
class AlwaysToolLLM implements AsyncLLM {
  readonly adapter = 'stub';
  readonly config = { adapter: 'stub', model_id: 'stub', base_url: '' };

  async ainvoke(): Promise<never> {
    throw new Error('stub 仅流式（astream）');
  }

  async *astream(): AsyncIterable<LLMChunk> {
    yield {
      token: '',
      tool_calls_delta: [
        new ToolCallDelta({ index: 0, id: `c-${Math.random().toString(36).slice(2, 8)}`, name: TOOL_PROBE, arguments_delta: '{"x":1}' }),
      ],
    };
  }

  async aclose(): Promise<void> {}
}

/** 从 checkpoint state 的 _round_graph 取 llm_decider 节点声明（数据形态）。 */
function deciderNodeOf(graphData: unknown): Record<string, unknown> {
  const graph = graphData as { nodes?: Record<string, { type?: string; config?: Record<string, unknown> }> };
  const spec = Object.values(graph.nodes ?? {}).find((node) => node.type === 'llm_decider');
  if (spec === undefined) throw new Error('回合图缺 llm_decider 节点');
  return spec.config ?? {};
}

describe('B4 max_tool_rounds 声明 → 组装图 llm_decider config → 执行上限', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('覆写写入组装图 llm_decider config（checkpoint 落执行时 config）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), capRecipe([]));
    const result = (await runtime.assemble_round({
      state: { input: '第一轮' },
      thread_id: 't-cap-cfg',
      round_id: 'r1',
      max_tool_rounds: 3,
    })) as RunResult;
    expect(result.reason).toBe('reply');
    const latest = await runtime.storage!.get_latest_checkpoint('t-cap-cfg');
    expect(latest).not.toBeNull();
    expect(deciderNodeOf(latest!.state[ROUND_GRAPH_STATE_KEY])['max_tool_rounds']).toBe(3);
    await runtime.stop();
  });

  it('恢复续跑不覆盖：resume_round 重建新叶图 = 锚点图（config 保持原值 3）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), capRecipe([]));
    await runtime.assemble_round({
      state: { input: '锚点轮' },
      thread_id: 't-cap-resume',
      round_id: 'r1',
      max_tool_rounds: 3,
    });
    const anchor = await runtime.storage!.get_latest_checkpoint('t-cap-resume');
    const anchorGraph = anchor!.state[ROUND_GRAPH_STATE_KEY] as Record<string, unknown>;
    expect(deciderNodeOf(anchorGraph)['max_tool_rounds']).toBe(3);
    const resumed = (await runtime.resume_round({
      thread_id: 't-cap-resume',
      leaf: anchor!.checkpoint_id,
      state: { input: '续跑' },
      round_id: 'r2',
    })) as RunResult;
    const newLeaf = await runtime.storage!.get_checkpoint(resumed.checkpoint_id!);
    expect(newLeaf).not.toBeNull();
    expect(newLeaf!.state[ROUND_GRAPH_STATE_KEY]).toEqual(anchorGraph);
    expect(deciderNodeOf(newLeaf!.state[ROUND_GRAPH_STATE_KEY])['max_tool_rounds']).toBe(3);
    await runtime.stop();
  });

  it('max_tool_rounds=1 生效：达上限收口（reason=error，工具副作用恰 1 次）', async () => {
    const executed: string[] = [];
    const host = new FakeHost();
    const stub = new AlwaysToolLLM();
    host.llm = stub;
    const runtime = await new Runtime().boot(toHost(host), capRecipe(executed));
    const result = (await runtime.assemble_round({
      state: { input: '每轮都请求工具' },
      thread_id: 't-cap-1',
      round_id: 'r1',
      llm: stub,
      max_tool_rounds: 1,
    })) as RunResult;
    expect(result.reason).toBe('error');
    expect(executed).toHaveLength(1);
    await runtime.stop();
  });

  it('无覆写 → 引擎缺省 8：工具副作用恰 8 次后收口', async () => {
    const executed: string[] = [];
    const host = new FakeHost();
    const stub = new AlwaysToolLLM();
    host.llm = stub;
    const runtime = await new Runtime().boot(toHost(host), capRecipe(executed));
    const result = (await runtime.assemble_round({
      state: { input: '无覆写默认上限' },
      thread_id: 't-cap-default',
      round_id: 'r1',
      llm: stub,
    })) as RunResult;
    expect(result.reason).toBe('error');
    expect(executed).toHaveLength(8);
    await runtime.stop();
  });
});
