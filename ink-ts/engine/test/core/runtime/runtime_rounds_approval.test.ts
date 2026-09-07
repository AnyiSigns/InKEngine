/**
 * gate: 超限(407 行) - B1 审批装配配置端到端专测 + DENY/autoApprove 回归同文件
 * B1 决策端到端专测：工具经装配配置转审批挂卡 → interrupt 卡 → resume(accept)
 * 按 checkpoint 关联图重建续跑，已执行工具不重复执行。
 *
 * 走 assemble_round（组装出的数据图 llm_decider 自含工具回合），确定性 stub
 * LLM 先产含工具调用的回合再产收口回合：demo_safe 权限命中直过先执行；
 * demo_review 经装配 tool_gate.review_tools 路由 review → 挂 gate 卡中断；
 * resume_run(accept) 按中断 checkpoint 的 _round_graph 重建本轮引擎续跑，
 * stub 依消息链只重发未回执的 demo_review（demo_safe 结果已在链内 → 不重发
 * = 不重复执行）。
 *
 * 断言：① 挂起卡 + checkpoint 落 _round_graph（graph_version=关联图 digest）；
 * ② resume 走 _engine_for_checkpoint 图重建（spy + digest 自洽 + 链叶同图）；
 * ③ 已执行工具不重复（执行序/消息链唯一回执/tool_audit 各一次）；④ 收口 reply。
 *
 * 审批路由 = 装配配置（B1 注入点）：demo 工具规格经配方 self_specs 注入（含
 * 声明式权限 demo:apply:*）；review 分级经配方 tool_gate.review_tools 声明；
 * 执行体为配方 self_executor_factory seam（demo 名计数直出，契约工具回落
 * make_self_executor）——不再做运行时 tool_pipeline 实例替换。机制环节
 * （门禁/中断原语/checkpoint/恢复重建/注入消费）全走产品代码。
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
import { Graph } from '../../../src/core/graph/graph.js';
import { ToolGateConfig } from '../../../src/core/permissions/permissions.js';
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

/** 门禁直过工具（权限命中；先执行，结果回执入链后不重复执行）。 */
const TOOL_SAFE = 'demo_safe';
/** 审批工具（配方 tool_gate.review_tools 路由 review → 挂卡 interrupt）。 */
const TOOL_REVIEW = 'demo_review';
/** 未声明权限工具（缺省 DENY 回归用）。 */
const TOOL_DENY = 'demo_deny';
/** 收口回复（resume 后消息链全回执，模型产出最终回复）。 */
const FINAL_REPLY = '#审批通过收口';
/** demo 工具声明式权限：统一流水线 operation_of 判定 demo 名为
 *  (apply, patch)——权限命中（review 分级只对命中工具生效）。 */
const DEMO_PERMISSION = 'demo:apply:*';

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

/** 无静态图配方；demo 工具经 self_specs 注入（带声明式权限 demo:apply:*），
 *  review 分级经 tool_gate.review_tools 声明；执行体 = 配方 self_executor_factory
 *  seam（demo 名计数直出，契约工具回落 make_self_executor）——装配配置即可达，
 *  无运行时 tool_pipeline 实例替换。
 *
 * @param executed demo 工具副作用计数（每次实际执行入列一次）。
 * @param options.review 是否装配 tool_gate 路由 demo_review → review。
 * @param options.deny_probe 是否注入无权限 demo 工具（DENY 缺省回归探针）。
 */
function approvalRecipe(
  executed: string[],
  options: { review?: boolean; deny_probe?: boolean } = {},
): AssemblyRecipe {
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
        new ToolSpec({
          name: TOOL_SAFE,
          description: '安全直过演示工具（先执行）',
          permissions: [DEMO_PERMISSION],
        }),
        new ToolSpec({
          name: TOOL_REVIEW,
          description: '审批演示工具（挂卡后执行）',
          permissions: [DEMO_PERMISSION],
        }),
        ...(options.deny_probe === true
          ? [new ToolSpec({ name: TOOL_DENY, description: '无权限工具（DENY 缺省回归）' })]
          : []),
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
          if (spec.name === TOOL_SAFE || spec.name === TOOL_REVIEW) {
            executed.push(spec.name);
            return `exec:${spec.name}:${String(args['target'] ?? '')}`;
          }
          return contract(ctx as never, spec, args, approval);
        };
      },
      self_operation_of: (spec) => operation_of(spec),
    },
    tool_gate:
      options.review === true ? new ToolGateConfig({ review_tools: [TOOL_REVIEW] }) : null,
    approval_levels: {},
    emit_timeline_events: true,
  });
  return base;
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

describe('B1 工具经装配配置转审批挂卡重入同图', () => {
  afterEach(() => {
    set_default_assembly_runtime(null);
  });

  it('工具触发审批挂起 → resume(accept) 按 checkpoint 关联图重建续跑；已执行工具不重复', async () => {
    const host = new FakeHost();
    const stub = new ApprovingLLM();
    host.llm = stub;
    const executed: string[] = [];
    // 审批路由 = 装配配置：tool_gate.review_tools 声明 demo_review 转 review
    const runtime = await new Runtime().boot(
      toHost(host),
      approvalRecipe(executed, { review: true }),
    );
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

  it('autoApprove 路径回归：review 分级的工具命中宿主直过名单 → 不挂卡直接执行', async () => {
    const host = new FakeHost();
    host.policy = new DefaultInterruptPolicy(new Set<string>(), new Set<string>([TOOL_REVIEW]));
    const stub = new ApprovingLLM();
    host.llm = stub;
    const executed: string[] = [];
    const runtime = await new Runtime().boot(
      toHost(host),
      approvalRecipe(executed, { review: true }),
    );
    const events = new CollectorTransport();
    const result = (await runtime.assemble_round({
      state: { input: 'autoApprove 直过路径' },
      thread_id: 't-auto',
      round_id: 'r1',
      llm: stub,
      transports: [events],
    })) as RunResult;
    expect(result.reason).toBe('reply');
    expect(result.interrupt).toBeNull();
    expect(executed).toEqual([TOOL_SAFE, TOOL_REVIEW]);
    // auto 决议直过：执行结果带【已自动批准执行】前缀（可观测区分）
    const messages = (result.state['messages'] ?? []) as Array<{ content: string }>;
    expect(messages.some((m) => m.content.includes('【已自动批准执行】exec:demo_review:'))).toBe(
      true,
    );
    await runtime.stop();
  });

  it('DENY 缺省回归：未装配 review 分级时无权限工具拒绝（fail-closed）', async () => {
    const host = new FakeHost();
    const executed: string[] = [];
    const runtime = await new Runtime().boot(
      toHost(host),
      approvalRecipe(executed, { deny_probe: true }),
    );
    const spec = runtime.self_specs.find((s) => s.name === TOOL_DENY)!;
    const stubCtx = {
      state: {},
      emit: async () => undefined,
      interrupt: async () => ({ decision: 'reject' }),
      get_interrupt_payload: async () => null,
    };
    const result = await runtime.tool_pipeline!.execute(stubCtx as never, spec, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未声明权限或权限未命中');
    expect(executed).toEqual([]); // 未触达执行体
    await runtime.stop();
  });
});
