/**
 * A2-1 补充决策端到端专测：组装路径工具触发审批挂起 → interrupt 卡 →
 * resume(accept) 按 checkpoint 关联图重建续跑，已执行工具不重复执行。
 *
 * 走 assemble_round（组装出的数据图 llm_decider 自含工具回合），确定性 stub
 * LLM 先产含工具调用的回合再产收口回合：demo_safe 门禁直过先执行；demo_review
 * 被测试 seam 的 gate 路由 review → 挂 gate 卡中断；resume_run(accept) 按中断
 * checkpoint 的 _round_graph 重建本轮引擎续跑，stub 依消息链只重发未回执的
 * demo_review（demo_safe 结果已在链内 → 不重发 = 不重复执行）。
 *
 * 断言：① 挂起卡 + checkpoint 落 _round_graph（graph_version=关联图 digest）；
 * ② resume 走 _engine_for_checkpoint 图重建（spy + digest 自洽 + 链叶同图）；
 * ③ 已执行工具不重复（执行序/消息链唯一回执/tool_audit 各一次）；④ 收口 reply。
 *
 * 审批路由 seam：组装路径当前把统一工具流水线 gate 硬编码为默认 PermissionGate
 * （DENY 兜底无 review 档），无「工具转审批」产品配置入口。本测 boot 后替换
 * runtime.tool_pipeline 实例（gate 路由 demo_review→review、executor 副作用计数），
 * demo 工具规格经配方 self_specs 注入；机制环节（中断原语/checkpoint/恢复重建/
 * 注入消费）全走产品代码，不改产品语义。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { Runtime, AssemblyRecipe } from '../../../src/core/runtime/index.js';
import type { Host } from '../../../src/core/runtime/index.js';
import type { RunResult } from '../../../src/core/run_result/run_result.js';
import { set_default_assembly_runtime } from '../../../src/core/path_assembler/index.js';
import { CollectorTransport } from '../../../src/core/events/events.js';
import { DefaultInterruptPolicy } from '../../../src/core/approval/approval.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';
import { ToolPipeline } from '../../../src/core/tool_pipeline/tool_pipeline.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { GateResult, ALLOW, DENY, REVIEW } from '../../../src/core/permissions/permissions.js';
import { ToolCallDelta, type Message } from '../../../src/core/llm/messages.js';
import type { AsyncLLM, LLMChunk } from '../../../src/core/llm/_guard_types.js';
import {
  self_tool_specs,
  make_self_executor,
  operation_of,
} from '../../../src/core/self_tools/index.js';
import type { SelfToolContext } from '../../../src/core/self_tools/index.js';
import { ROUND_GRAPH_STATE_KEY } from '../../../src/core/runtime/_runtime_rounds.js';
import { MemoryStorage } from '../executor/helpers.js';

/** 门禁直过工具（先执行；结果回执入链后不重复执行）。 */
const TOOL_SAFE = 'demo_safe';
/** 审批工具（测试 gate 路由 review → 挂卡 interrupt）。 */
const TOOL_REVIEW = 'demo_review';
/** 收口回复（resume 后消息链全回执，模型产出最终回复）。 */
const FINAL_REPLY = '#审批通过收口';

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

/** Host 五件套 mock：resume 重建引擎走宿主 resolve_llm（resume_run 不收 llm
 *  参数），故 stub 模型挂在 host 上。 */
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

/** 无默认图配方（graph_recipe=null）；demo 工具经 self_specs 注入
 *  （boot 打 immutable 标签 → collect_specs 常驻注入表）。 */
function recipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'a2-approval-round',
    seeds: [['boot', boot_seed_entries]],
    harness_definitions: [
      new HarnessDefinition({ name: 'forge', description: '自举领域', keywords: ['自举'] }),
    ],
    event_type_specs: [new EventTypeSpec({ name: 'reply_token', renderer: 'StreamingRow' })],
    tool_wiring: {
      self_specs: () => [
        ...self_tool_specs(),
        new ToolSpec({ name: TOOL_SAFE, description: '安全直过演示工具（先执行）' }),
        new ToolSpec({ name: TOOL_REVIEW, description: '审批演示工具（挂卡后执行）' }),
      ],
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

/** 审批路由运行时 seam：boot 后替换统一工具流水线实例（gate 路由 review +
 *  executor 副作用计数）；approval/interrupt 机制仍走产品 ToolPipeline。 */
function install_approval_pipeline(runtime: Runtime, executed: string[]): void {
  const pipeline = new ToolPipeline({
    gate: {
      check: (tool: string, operation: string, target: string) => {
        if (tool === TOOL_SAFE) return new GateResult(ALLOW, tool, operation, target, '');
        if (tool === TOOL_REVIEW) {
          return new GateResult(REVIEW, tool, operation, target, '测试路由：转审批');
        }
        return new GateResult(DENY, tool, operation, target, '测试：未授权工具');
      },
    },
    extractor: () => ['write', 'test'],
    executor: async (_ctx, spec, args) => {
      executed.push(spec.name);
      return `exec:${spec.name}:${String(args['target'] ?? '')}`;
    },
    approval_policy: new DefaultInterruptPolicy(),
  });
  const rt = runtime as unknown as { tool_pipeline: ToolPipeline };
  rt.tool_pipeline = pipeline;
}

/** 消息链中未回执的 assistant 工具调用（按 tool_call_id 配对后续 tool 消息）。
 *  无 assistant 工具调用消息（首轮）返回 null。 */
function outstanding_calls(
  messages: readonly Message[],
): Array<{ id: string; name: string; arguments: string }> | null {
  let lastIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls!.length > 0) {
      lastIndex = i;
    }
  }
  if (lastIndex === -1) return null;
  const answered = new Set<string>();
  for (let i = lastIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role === 'tool' && msg.tool_call_id !== null) answered.add(msg.tool_call_id);
  }
  const calls = messages[lastIndex]!.tool_calls ?? [];
  const pending = calls.filter((call) => !answered.has(call.id));
  return pending.length > 0
    ? pending.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))
    : [];
}

/** 确定性审批 stub：首轮产 safe+review 两调用；此后按消息链未回执调用续发
 *  （只重发 review），全回执后产收口回复。 */
class ApprovingLLM implements AsyncLLM {
  readonly adapter = 'stub';
  readonly config = { adapter: 'stub', model_id: 'stub', base_url: '' };

  async ainvoke(): Promise<never> {
    throw new Error('stub 仅流式（astream）');
  }

  async *astream(messages: readonly Message[]): AsyncIterable<LLMChunk> {
    const pending = outstanding_calls(messages);
    if (pending === null) {
      yield {
        token: '首轮',
        tool_calls_delta: [
          new ToolCallDelta({
            index: 0,
            id: 'c-safe',
            name: TOOL_SAFE,
            arguments_delta: JSON.stringify({ target: 'a' }),
          }),
          new ToolCallDelta({
            index: 1,
            id: 'c-review',
            name: TOOL_REVIEW,
            arguments_delta: JSON.stringify({ target: 'b' }),
          }),
        ],
      };
      return;
    }
    if (pending.length > 0) {
      yield {
        token: '',
        tool_calls_delta: pending.map(
          (call, index) =>
            new ToolCallDelta({
              index,
              id: call.id,
              name: call.name,
              arguments_delta: call.arguments,
            }),
        ),
      };
      return;
    }
    yield { token: FINAL_REPLY, tool_calls_delta: null };
  }

  async aclose(): Promise<void> {}
}

function graphFromState(
  runtime: Runtime,
  state: Record<string, unknown>,
): { graph: Graph; digest: string } {
  const data = state[ROUND_GRAPH_STATE_KEY] as Record<string, unknown>;
  const graph = Graph.from_dict(data, {
    registry: runtime.graph_registries!.nodes,
    edge_registry: runtime.graph_registries!.edges,
  });
  return { graph, digest: graph.digest() };
}

describe('组装路径审批中断重入同图（A2-1）', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('工具触发审批挂起 → resume(accept) 按 checkpoint 关联图重建续跑；已执行工具不重复', async () => {
    const host = new FakeHost();
    const stub = new ApprovingLLM();
    host.llm = stub;
    const runtime = await new Runtime().boot(toHost(host), recipe());
    const executed: string[] = [];
    install_approval_pipeline(runtime, executed);
    // resume 图重建 spy：resume_run 应走 _engine_for_checkpoint（按关联图重建）
    const runtimeAny = runtime as unknown as {
      _engine_for_checkpoint: (
        checkpoint: { checkpoint_id?: number | null; reason?: string | null },
        opts?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    const rebuiltAnchors: Array<{ checkpoint_id: number | null; reason: string | null }> = [];
    const baseRebuild = runtimeAny._engine_for_checkpoint.bind(runtime);
    runtimeAny._engine_for_checkpoint = async (checkpoint, opts) => {
      rebuiltAnchors.push({
        checkpoint_id: checkpoint.checkpoint_id ?? null,
        reason: checkpoint.reason ?? null,
      });
      return await baseRebuild(checkpoint, opts);
    };

    const events = new CollectorTransport();
    const thread = 't-approval';
    const first = (await runtime.assemble_round({
      state: { input: '执行一个含审批的写流程' },
      thread_id: thread,
      round_id: 'r1',
      llm: stub,
      transports: [events],
    })) as RunResult;

    // ① 挂起卡产生 + checkpoint 落本轮图定义（digest 自洽）
    expect(first.reason).toBe('interrupted');
    expect(first.interrupt).not.toBeNull();
    expect(first.interrupt!.key).toBe(`gate:${TOOL_REVIEW}`);
    expect(executed).toEqual([TOOL_SAFE]); // 已执行工具（safe）副作用已计数一次
    const hung = await runtime.storage!.get_latest_checkpoint(thread);
    expect(hung).not.toBeNull();
    expect(hung!.reason).toBe('interrupted');
    expect(hung!.interrupt).not.toBeNull();
    expect(hung!.interrupt!.key).toBe(`gate:${TOOL_REVIEW}`);
    const hungGraph = hung!.state[ROUND_GRAPH_STATE_KEY] as Record<string, unknown>;
    expect(hungGraph).toBeTruthy();
    expect(graphFromState(runtime, hung!.state).digest).toBe(hung!.graph_version);
    expect(
      events.events.some(
        (event) =>
          event.type === 'review_card'
          && (event.payload as Record<string, unknown>)['key'] === `gate:${TOOL_REVIEW}`,
      ),
    ).toBe(true);

    // ② resume 走 _engine_for_checkpoint 图重建 + 决议注入（accept）
    const resumed = (await runtime.resume_run(
      thread,
      { decision: 'accept', reason: 'e2e 同意执行' },
      { round_id: 'r2', transports: [events] },
    )) as RunResult;
    expect(rebuiltAnchors.length).toBe(1);
    expect(rebuiltAnchors[0]!.checkpoint_id).toBe(hung!.checkpoint_id);
    expect(rebuiltAnchors[0]!.reason).toBe('interrupted');

    // ④ 回合正常收口
    expect(resumed.reason).toBe('reply');
    expect(resumed.state['reply']).toBe(FINAL_REPLY);
    expect(resumed.checkpoint_id).not.toBe(hung!.checkpoint_id);

    // ③ 已执行工具不重复：safe 仅一次（结果在链内 stub 不重发）；review resume 后一次
    expect(executed).toEqual([TOOL_SAFE, TOOL_REVIEW]);
    const messages = (resumed.state['messages'] ?? []) as Array<{
      role: string;
      content: string;
    }>;
    const toolContents = messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolContents.filter((c) => c.startsWith('exec:demo_safe:')).length).toBe(1);
    expect(toolContents.filter((c) => c.startsWith('exec:demo_review:')).length).toBe(1);
    const audits = events.events.filter((event) => event.type === 'tool_audit');
    const auditTools = audits
      .filter((event) => (event.payload as Record<string, unknown>)['decision'] === 'ok')
      .map((event) => String((event.payload as Record<string, unknown>)['tool'] ?? ''));
    expect(auditTools.filter((name) => name === TOOL_SAFE).length).toBe(1);
    expect(auditTools.filter((name) => name === TOOL_REVIEW).length).toBe(1);

    // 链叶同图：resume 新叶 checkpoint 保留同一本轮图定义且 digest 自洽
    const leaf = await runtime.storage!.get_checkpoint(resumed.checkpoint_id!);
    expect(leaf).not.toBeNull();
    expect(leaf!.state[ROUND_GRAPH_STATE_KEY]).toEqual(hungGraph);
    expect(graphFromState(runtime, leaf!.state).digest).toBe(leaf!.graph_version);
    expect(leaf!.parent_id).not.toBeNull();
    await runtime.stop();
  });
});
