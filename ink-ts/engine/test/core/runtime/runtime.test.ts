// gate: 超限(706 行) - 运行时集成用例共用同一条 boot→装配→run 链与单引擎夹具，拆分需重复整链装配
/**
 * 运行时单测（镜像 test_runtime.py + test_runtime_abort.py 的纯机制子集）。
 *
 * 覆盖：boot 幂等装配与产物齐全；Host 五件套调用；状态机转换矩阵；pause
 * 拒新不打断在途；stop 排空在途且按序关停（MCP seam → 存储 → 宿主钩子）且
 * 幂等；resume_run 决议重入样板（挂起 → 注入 → 续跑）；引擎重建缓存（配置/
 * 工具表变更才重建）；装配配方缺件显式报错；工具标签/常驻必带集/thread
 * 标签；回合调参接线；知识注入/归因 settle 钩子；abort no-op 与 CANCELLED
 * 快照落链。
 *
 * 延后用例（头注原因，宿主/IO seam 未迁 core）：
 * - 真实 LLM/MCP：LLM 守卫调用路径、MCP server 会话（McpClientManager 属
 *   引擎 adapters/宿主装配面，缺省未注入即不启用）；
 * - 指令注入扫描：knowledge_set._sources 缺省扫描器为 no-op（宿主注入扫描
 *   器后生效），注入剔除断言延后；
 * - 真实 asyncio 任务取消：JS Promise 无 CancelledError 语义，引擎在途
 *   取消以宿主取消句柄 seam（RunTaskHandle）表达——引擎集成中止用例延后，
 *   本文件以 seam 驱动覆盖 Runtime 层快照逻辑。
 */
import { describe, it, expect } from 'vitest';

import { Runtime, RuntimeState, AssemblyRecipe, _KnowledgeUsageSettleHook } from '../../../src/core/runtime/index.js';
import type { Host } from '../../../src/core/runtime/index.js';
import type { GraphRecipeContext } from '../../../src/core/runtime/index.js';
import { Graph } from '../../../src/core/graph/graph.js';
import { RunResult, RunOptions } from '../../../src/core/run_result/run_result.js';
import { DefaultInterruptPolicy } from '../../../src/core/approval/approval.js';
import { CompressingLLM, UsageTrackingLLM } from '../../../src/core/llm/guard.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';
import { EventTypeSpec } from '../../../src/core/event_types/eventTypeSpec.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { KnowledgeEntry, KIND_RULE } from '../../../src/core/knowledge_set/index.js';
import { ProposalValidator, PatchKind } from '../../../src/core/self_proposal/index.js';
import { SelfProposal } from '../../../src/core/self_proposal/index.js';
import { ApprovalLevel } from '../../../src/core/self_application/index.js';
import { self_tool_specs, make_self_executor, operation_of, SelfToolContext } from '../../../src/core/self_tools/index.js';
import { MetaTuner, TunableParams, TurnMetrics } from '../../../src/core/tuning/index.js';
import { SettleContext } from '../../../src/core/settle/index.js';
import { MemoryStorage } from '../executor/helpers.js';
import { CheckpointRecord } from '../../../src/core/storage/storage_records.js';
import { TerminateReason } from '../../../src/core/graph/graph_types.js';
import { GENERAL_WEIGHTS_SEED_ID } from '../../../src/core/seeds/seeds.js';

/** 事件收集传输（EngineTransport 协议）。 */
class FakeTransport {
  readonly events: unknown[] = [];
  async send(event: unknown): Promise<void> {
    this.events.push(event);
  }
}

/** 可关闭假模型（stop/rebuild 显式关闭 LLM 链断言用）。 */
class _ClosableLLM {
  closed = false;
  async ainvoke(): Promise<unknown> {
    return null;
  }
  async aclose(): Promise<void> {
    this.closed = true;
  }
}

/** Host 五件套 mock（调用留痕供顺序断言；可注入假模型/策略）。 */
class FakeHost {
  readonly calls: string[] = [];
  llm: _ClosableLLM | null = null;
  policy: unknown = new DefaultInterruptPolicy();
  storage: MemoryStorage | null = null;

  async create_storage(): Promise<MemoryStorage> {
    this.calls.push('create_storage');
    this.storage = new MemoryStorage();
    return this.storage;
  }
  async resolve_llm(): Promise<_ClosableLLM | null> {
    this.calls.push('resolve_llm');
    return this.llm;
  }
  interrupt_policy(): unknown {
    this.calls.push('interrupt_policy');
    return this.policy;
  }
  build_transport(): FakeTransport {
    this.calls.push('build_transport');
    return new FakeTransport();
  }
  async close(): Promise<void> {
    this.calls.push('host_close');
  }
}

/** boot 领域种子（镜像 ink_engine/seeds/boot：system_prompt 种子条目）。 */
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

/** 出厂界面基线（在白名单内的最小合法形态）。 */
const boot_ui_spec: Record<string, unknown> = {
  name: 'boot.panel',
  root: {
    kind: 'container',
    type: 'column',
    children: [
      {
        kind: 'component',
        type: 'agent_input',
        bind: { channel: 'state', path: 'input' },
      },
    ],
  },
};

async function _echo_agent(ctx: never): Promise<Record<string, unknown>> {
  void ctx;
  return { reply: 'ok' };
}

function _echo_graph_recipe(ctx: GraphRecipeContext): Graph {
  void ctx;
  const g = new Graph({ name: 'echo', entry: 'agent' });
  g.add_node('agent', _echo_agent as never);
  g.add_exit('agent');
  return g;
}

async function _gate_agent(ctx: never): Promise<Record<string, unknown>> {
  void ctx;
  const anyCtx = ctx as { interrupt(key: string, payload: unknown): Promise<unknown> };
  const decision = await anyCtx.interrupt('approval', { review_type: 'gate' });
  return { decision, done: true };
}

function _gate_graph_recipe(ctx: GraphRecipeContext): Graph {
  void ctx;
  const g = new Graph({ name: 'gate', entry: 'gate' });
  g.add_node('gate', _gate_agent as never);
  g.add_exit('gate');
  return g;
}

function toHost(host: FakeHost): Host {
  return host as unknown as Host;
}

function _minimal_recipe(overrides: Partial<AssemblyRecipe> = {}): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'default',
    seeds: [['boot', boot_seed_entries]],
    harness_definitions: [
      new HarnessDefinition({
        name: 'forge',
        description: '自举领域',
        keywords: ['自举'],
      }),
    ],
    event_type_specs: [new EventTypeSpec({ name: 'reply_token', renderer: 'StreamingRow' })],
    ui_spec: boot_ui_spec,
    ui_allowed_components: ['column', 'message_list', 'agent_input'],
    ui_allowed_theme_tokens: ['bg', 'fg', 'accent'],
    tool_wiring: {
      self_specs: () => self_tool_specs(),
      self_executor_factory: (pipeline, context_getter) =>
        make_self_executor(pipeline, context_getter as unknown as () => SelfToolContext),
      self_operation_of: (spec) => operation_of(spec),
    },
    approval_levels: { [PatchKind.THEME]: ApprovalLevel.L0 },
    graph_recipe: _echo_graph_recipe,
  });
  return Object.assign(base, overrides);
}

describe('runtime boot 装配', () => {
  it('Host 五件套契约齐备', async () => {
    const host = new FakeHost();
    const storage = await host.create_storage();
    expect(storage).toBeTruthy();
    expect(await host.resolve_llm()).toBeNull();
    expect(host.interrupt_policy()).toBe(host.policy);
    const transport = host.build_transport();
    expect(transport).toBeInstanceOf(FakeTransport);
    await host.close();
    expect(host.calls[host.calls.length - 1]).toBe('host_close');
  });

  it('配方注入后装配产物齐全', async () => {
    const host = new FakeHost();
    const runtime = await new Runtime().boot(toHost(host), _minimal_recipe());
    expect(runtime.state).toBe(RuntimeState.RUNNING);
    expect(host.calls[0]).toBe('create_storage');
    expect(runtime.storage).toBeTruthy();
    expect(runtime.guard_token).toBeTruthy();
    expect(runtime.graph_registries).toBeTruthy();
    // 种子注入（通用基线 + boot 领域种子）
    expect(runtime.knowledge_set!.entries().length).toBeGreaterThan(0);
    expect(runtime.knowledge_set!.get('seed.boot.system_prompt')).not.toBeNull();
    // harness 注册 + 落库
    expect(runtime.harness_registry!.names()).toContain('forge');
    const saved = await runtime.harness_repository!.get('forge');
    expect(saved).not.toBeNull();
    // 事件类型注册表（基线登记）
    expect(runtime.event_type_registry!.names()).toContain('reply_token');
    // 元工具流水线（内省 6 + 自指 6）
    expect(runtime.introspection_specs.length).toBe(6);
    expect(runtime.self_specs.length).toBe(6);
    expect(runtime.introspection_service).toBeTruthy();
    expect(runtime.introspection_pipeline).toBeTruthy();
    expect(runtime.self_pipeline).toBeTruthy();
    expect(runtime.self_pipeline_runner).toBeTruthy();
    expect(runtime.retriever_registry).toBeTruthy();
    expect(runtime.tool_pipeline).toBeTruthy();
    // MCP seam：宿主适配器未注入 = 不启用（引擎 adapters 未迁 core）
    expect(runtime.mcp_manager).toBeNull();
    // 引擎已重建；未配置模型 → engine_llm 为 null（路由端引导）
    expect(runtime.engine).toBeTruthy();
    expect(runtime.engine_llm).toBeNull();
    // 界面基线经白名单校验后装配（未回落未定形）
    const snapshot = runtime.introspection_service!.snapshot_ui();
    expect(snapshot['ui_spec']).not.toBeNull();
  });

  it('boot 幂等：已装配再次调用直接返回自身', async () => {
    const host = new FakeHost();
    const runtime = new Runtime();
    const first = await runtime.boot(toHost(host), _minimal_recipe());
    const second = await runtime.boot(toHost(new FakeHost()), _minimal_recipe());
    expect(first).toBe(runtime);
    expect(second).toBe(runtime);
    expect(host.calls.filter((c) => c === 'create_storage').length).toBe(1);
  });

  it('配方缺件显式报错（tool_wiring/graph_recipe 为非谈判项）', async () => {
    const recipe1 = _minimal_recipe();
    recipe1.tool_wiring = null;
    await expect(new Runtime().boot(toHost(new FakeHost()), recipe1)).rejects.toThrow(/tool_wiring/);
    const recipe2 = _minimal_recipe();
    recipe2.graph_recipe = null;
    await expect(new Runtime().boot(toHost(new FakeHost()), recipe2)).rejects.toThrow(/graph_recipe/);
  });

  it('界面绑定通道白名单可由配方扩展', async () => {
    const spec: Record<string, unknown> = {
      name: 'boot.panel',
      root: {
        kind: 'container',
        type: 'column',
        children: [
          {
            kind: 'component',
            type: 'message_list',
            bind: { channel: 'events.reply_token', path: '' },
          },
        ],
      },
    };
    // 默认白名单仅 state：events 绑定被判违规，界面基线回落未定形
    const r1 = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe({ ui_spec: spec }));
    expect(r1.introspection_service!.snapshot_ui()['ui_spec']).toBeNull();
    // 配方放行 events 族：界面基线存活
    const r2 = await new Runtime().boot(
      toHost(new FakeHost()),
      _minimal_recipe({
        ui_spec: spec,
        ui_allowed_channels: ['state', 'events.reply_token'],
      }),
    );
    expect(r2.introspection_service!.snapshot_ui()['ui_spec']).toEqual(spec);
  });
});

describe('runtime 生命周期状态机', () => {
  it('状态机转换矩阵：合法通过、非法显式拒绝', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    runtime.pause();
    expect(runtime.state).toBe(RuntimeState.PAUSED);
    expect(() => runtime.pause()).toThrow(/非法状态转换/);
    runtime.resume();
    expect(runtime.state).toBe(RuntimeState.RUNNING);
    expect(() => runtime.resume()).toThrow(/非法状态转换/);
    runtime.pause();
    await runtime.stop();
    expect(runtime.state).toBe(RuntimeState.STOPPED);
    await runtime.stop(); // stop 幂等
    expect(runtime.state).toBe(RuntimeState.STOPPED);
    expect(() => runtime.resume()).toThrow(/非法状态转换/);
    expect(() => runtime.pause()).toThrow(/非法状态转换/);
  });

  it('pause 拒新 run、不打断在途 run', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    const ticket = runtime.begin_run();
    runtime.pause();
    expect(() => runtime.begin_run()).toThrow(/不允许开始新 run/);
    runtime.end_run(ticket); // 在途登记注销不受 pause 影响
    runtime.resume();
    const ticket2 = runtime.begin_run();
    runtime.end_run(ticket2);
  });

  it('stop 排在途完成：在途未注销时等待，注销后完成关停', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    const ticket = runtime.begin_run();
    const stopping = runtime.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 在途未完成 → stop 尚未返回（等待排空）
    let done = false;
    void stopping.then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toBe(false);
    runtime.end_run(ticket);
    await stopping;
    expect(runtime.state).toBe(RuntimeState.STOPPED);
  });

  it('关停顺序：MCP seam → 存储 → 宿主 close 钩子', async () => {
    const host = new FakeHost();
    const runtime = await new Runtime().boot(toHost(host), _minimal_recipe());
    const order: string[] = [];
    runtime.mcp_manager = {
      async close_all(): Promise<void> {
        order.push('mcp');
      },
    };
    const recorder = {
      async close(): Promise<void> {
        order.push('storage');
      },
    };
    runtime.storage = recorder as never;
    await runtime.stop();
    expect(order).toEqual(['mcp', 'storage']);
    expect(host.calls[host.calls.length - 1]).toBe('host_close');
  });

  it('stop 显式关闭 LLM 链', async () => {
    const host = new FakeHost();
    const llm = new _ClosableLLM();
    host.llm = llm;
    const runtime = await new Runtime().boot(toHost(host), _minimal_recipe());
    expect(runtime.engine_llm).toBe(llm as never);
    await runtime.stop();
    expect(llm.closed).toBe(true);
  });

  it('引擎重建换模型时显式关闭旧 LLM 链', async () => {
    const host = new FakeHost();
    const runtime = await new Runtime().boot(toHost(host), _minimal_recipe());
    const old = new _ClosableLLM();
    await runtime.rebuild_engine(old as never);
    expect(old.closed).toBe(false);
    const next = new _ClosableLLM();
    await runtime.rebuild_engine(next as never);
    expect(old.closed).toBe(true);
    expect(next.closed).toBe(false);
    expect(runtime.engine_llm).toBe(next as never);
    await runtime.stop();
    expect(next.closed).toBe(true);
  });

  it('引擎装配把 LLM 包上守卫链（用量闭环 + 回合内压缩）', async () => {
    const host = new FakeHost();
    const llm = new _ClosableLLM();
    host.llm = llm;
    const captured: unknown[] = [];
    const policy = {
      should_compress: () => true,
      budget_chars: () => 100,
    };
    const captureRecipe = (ctx: GraphRecipeContext): Graph => {
      captured.push(ctx.llm);
      return _echo_graph_recipe(ctx);
    };
    const runtime = await new Runtime().boot(
      toHost(host),
      _minimal_recipe({
        compress_policy: policy as never,
        graph_recipe: captureRecipe,
      }),
    );
    const guard = captured[0];
    expect(guard).toBeInstanceOf(UsageTrackingLLM);
    const compressing = (guard as unknown as { _inner: unknown })._inner;
    expect(compressing).toBeInstanceOf(CompressingLLM);
    expect((compressing as unknown as { _policy: unknown })._policy).toBe(policy);
    await runtime.stop();
  });

  it('引擎重建缓存：模型/工具表不变复用实例，变更才重建', async () => {
    const host = new FakeHost();
    const runtime = await new Runtime().boot(toHost(host), _minimal_recipe());
    const first = runtime.engine;
    expect(await runtime.rebuild_engine()).toBe(first);
    const newLlm = new _ClosableLLM();
    const rebuilt = await runtime.rebuild_engine(newLlm as never);
    expect(rebuilt).not.toBe(first);
    // 工具表变化（MCP 挂载/补丁链工具）→ 重建
    runtime.tool_registry['injected_tool'] = self_tool_specs()[0]!;
    const rebuilt2 = await runtime.rebuild_engine(newLlm as never);
    expect(rebuilt2).not.toBe(rebuilt);
    runtime.tool_registry = {};
    const rebuilt3 = await runtime.rebuild_engine(newLlm as never);
    expect(rebuilt3).not.toBe(rebuilt2);
    expect(await runtime.rebuild_engine(newLlm as never)).toBe(rebuilt3);
    await runtime.stop();
  });

  it('配方 run_options 执行域覆盖：非 None 字段生效，装配产物保持注入', async () => {
    const recipe = _minimal_recipe({
      run_options: new RunOptions({ plan_policy: 'strict', max_plan_steps: 3 }),
    });
    const runtime = await new Runtime().boot(toHost(new FakeHost()), recipe);
    const engine = runtime.engine!;
    expect(engine.options.plan_policy).toBe('strict');
    expect(engine.options.max_plan_steps).toBe(3);
    expect(engine.options.storage).toBe(runtime.storage as never);
    expect(engine.options.registries).toBe(runtime.graph_registries);
    expect(engine.options.error_on_exception).toBe(true);
  });
});

describe('runtime 审批决议重入', () => {
  it('resume_run：挂起 → 决议注入 → 续跑', async () => {
    const runtime = await new Runtime().boot(
      toHost(new FakeHost()),
      _minimal_recipe({ graph_recipe: _gate_graph_recipe }),
    );
    const result = await runtime.engine!.ainvoke(
      { input: 'x' },
      { thread_id: 't-gate', round_id: 'r-gate' },
    );
    expect(result.interrupt).not.toBeNull();
    expect(result.interrupt!.key).toBe('approval');
    // 无挂起卡时显式报错
    await expect(
      runtime.resume_run('t-empty', { decision: 'accept' }),
    ).rejects.toThrow(/无挂起审批卡/);
    // 决议注入重入
    const resumed = await runtime.resume_run('t-gate', { decision: 'accept' });
    const r = resumed as RunResult;
    expect(r.interrupt).toBeNull();
    expect((r.state as Record<string, unknown>)['done']).toBe(true);
    expect((r.state as Record<string, unknown>)['decision']).toEqual({ decision: 'accept' });
  });

  it('挂起卡已失效（链尾非挂起卡）显式报错，不静默重放', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    await runtime.engine!.ainvoke(
      { input: 'x' },
      { thread_id: 't-ok', round_id: 'r-ok' },
    );
    await expect(
      runtime.resume_run('t-ok', { decision: 'accept' }),
    ).rejects.toThrow(/无挂起审批卡/);
  });
});

describe('runtime 工具清单（单源 + 标签）', () => {
  it('注入集 = immutable 恒注入 + baseline 必带；动态工具不进 tools 参数', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    for (const name of ['file_read', 'file_write', 'file_edit', 'grep', 'glob']) {
      runtime.tool_registry[name] = new ToolSpec({ name, description: `${name} 工具` });
    }
    const specs = runtime.collect_specs();
    expect(specs.length).toBe(17);
    expect(new Set(specs.map((s) => s.name))).toEqual(
      new Set([
        'inspect_graph', 'inspect_rules', 'inspect_knowledge', 'inspect_ui',
        'inspect_tools', 'inspect_entities',
        'propose_patch', 'apply_patch', 'revert_patch',
        'propose_domain_manifest', 'search_tools', 'request_tool',
        'file_read', 'file_write', 'file_edit', 'grep', 'glob',
      ]),
    );
    // 动态注册的无标签工具不进 tools 参数
    runtime.tool_registry['custom_dynamic'] = new ToolSpec({
      name: 'custom_dynamic',
      description: '动态注入',
    });
    expect(runtime.collect_specs().length).toBe(17);
    // merged_specs 全量可见（工具 tab / 检索同源）
    expect(runtime.merged_specs().some((s) => s.name === 'custom_dynamic')).toBe(true);
  });

  it('统一工具流水线按名路由：契约自指工具（apply_patch）可执行', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    const spec = runtime.self_specs.find((s) => s.name === 'apply_patch')!;
    // 节点上下文桩（emit/挂起协议子集：L0 直过路径不弹卡，审计事件可发）
    const stubCtx = {
      state: {},
      emit: async () => undefined,
      interrupt: async () => ({ decision: 'accept', content: null }),
      get_interrupt_payload: async () => null,
    };
    const result = await runtime.tool_pipeline!.execute(
      stubCtx as never,
      spec,
      { kind: 'theme', payload: { tokens: { bg: '#123456' } } },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('"ok":true');
    const state = await runtime.self_pipeline!.chain.assemble();
    expect((state as Record<string, unknown>)['theme']).toEqual({ bg: '#123456' });
  });

  it('tag_tool/untag_tool/collect_specs thread 标签隔离', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    const spec = new ToolSpec({ name: 'custom_x', description: 'x' });
    runtime.tool_registry['custom_x'] = spec;
    runtime.tag_tool('custom_x', 'thread:t1');
    const names = new Set(runtime.collect_specs('t1').map((s) => s.name));
    expect(names.has('custom_x')).toBe(true);
    expect(runtime.collect_specs('t2').some((s) => s.name === 'custom_x')).toBe(false);
    runtime.untag_tool('custom_x', 'thread:t1');
    expect(runtime.collect_specs('t1').some((s) => s.name === 'custom_x')).toBe(false);
  });

  it('常驻必带集设置/恢复（records 通道）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    // 出厂基线外的工具登记后加入常驻必带集 → baseline 标签生效
    runtime.tool_registry['custom_baseline_tool'] = new ToolSpec({
      name: 'custom_baseline_tool',
      description: '出厂外工具',
    });
    const names = await runtime.set_baseline_names(['custom_baseline_tool']);
    expect(names).toContain('custom_baseline_tool');
    expect(runtime.tool_tags('custom_baseline_tool').has('baseline')).toBe(true);
    expect(runtime.collect_specs().some((s) => s.name === 'custom_baseline_tool')).toBe(true);
  });
});

describe('runtime 回合调参接线（E-P5）', () => {
  it('回合收尾调参：失败信号聚合 → MetaTuner 调参 → 参数回写知识集', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    expect(runtime.meta_tuner).toBeTruthy();
    expect(runtime.turn_metrics).toBeTruthy();
    for (let i = 0; i < 5; i += 1) {
      runtime.tune_after_round({ failed: true, error: '连续失败信号' });
    }
    expect(runtime.turn_metrics!.turns).toBe(5);
    expect(runtime.turn_metrics!.failure_rate).toBeCloseTo(1.0);
    const entry = runtime.knowledge_set!.get(GENERAL_WEIGHTS_SEED_ID);
    expect(entry).not.toBeNull();
    const params = TunableParams.from_dict(entry!.data as never);
    expect(params.retry_budget).toBeGreaterThanOrEqual(2);
    expect(params.web_verify_threshold).toBeLessThan(0.5);
  });

  it('低失败信号：重试预算不虚增，验证阈值回调', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    const result = runtime.tune_after_round({ failed: false });
    expect(result).not.toBeNull();
    const entry = runtime.knowledge_set!.get(GENERAL_WEIGHTS_SEED_ID);
    const params = TunableParams.from_dict(entry!.data as never);
    expect(params.retry_budget).toBe(1);
    expect(params.web_verify_threshold).toBeGreaterThan(0.5);
  });
});

describe('runtime 知识注入与归因 settle', () => {
  function addEntry(runtime: Runtime, id: string, message: string, source = 'model'): void {
    runtime.knowledge_set!.add(
      new KnowledgeEntry({
        id,
        level: 'work',
        kind: KIND_RULE,
        data: { rule: { message } },
        source,
        credibility: 0.6,
        title: id,
        tags: ['注入'],
      }),
    );
  }

  it('回合装配命中知识即 record_usage（使用留痕）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    addEntry(runtime, 'k-usage-track', '被注入使用的知识');
    const provider = runtime._assembly_sources();
    const sources = (await provider({ state: { input: 'k-usage-track' } })) as Array<{
      meta?: Record<string, unknown>;
    }>;
    expect(sources.length).toBeGreaterThan(0);
    expect(runtime._round_knowledge_hits.has('k-usage-track')).toBe(true);
    expect(runtime.knowledge_set!.get('k-usage-track')!.usage_count).toBeGreaterThanOrEqual(1);
  });

  it('回合收尾失败归因：注入知识补记 fail（失败日志 → 进化候选）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    addEntry(runtime, 'k-fail-track', '失败回合注入的知识');
    runtime._round_knowledge_hits.add('k-fail-track');
    runtime._round_knowledge_hits.add('k-missing'); // 不存在条目：静默跳过
    const ctx = new SettleContext({
      thread_id: 't1',
      round_id: 'r1',
      trace_id: 'tr1',
      domain: 'default',
      steps: [],
      result: new RunResult({ state: {}, reason: 'error', error: '节点执行失败' }),
    });
    const hook = new _KnowledgeUsageSettleHook(runtime);
    await hook.settle(ctx);
    const entry = runtime.knowledge_set!.get('k-fail-track')!;
    expect(entry.usage_count).toBe(1);
    expect(entry.fail_count).toBe(1);
    expect(entry.failure_logs.some((log) => log.includes('节点执行失败'))).toBe(true);
    expect(runtime._round_knowledge_hits.has('k-fail-track')).toBe(false);
  });

  it('回合正常回复：注入知识只记成功使用，不补失败日志', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    addEntry(runtime, 'k-neutral-track', '成功回合注入的知识');
    runtime._round_knowledge_hits.add('k-neutral-track');
    const ctx = new SettleContext({
      thread_id: 't1',
      round_id: 'r1',
      trace_id: 'tr1',
      domain: 'default',
      steps: [],
      result: new RunResult({ state: {}, reason: 'reply' }),
    });
    const hook = new _KnowledgeUsageSettleHook(runtime);
    await hook.settle(ctx);
    const entry = runtime.knowledge_set!.get('k-neutral-track')!;
    expect(entry.fail_count).toBe(0);
    expect(entry.failure_logs.length).toBe(0);
    expect(runtime._round_knowledge_hits.size).toBe(0);
  });
});

describe('runtime 中止（abort_current_run）', () => {
  it('无在途 run：幂等 no-op', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    expect(await runtime.abort_current_run()).toBe(false);
    expect(runtime.state).toBe(RuntimeState.RUNNING);
  });

  it('中止取消在途并写 CANCELLED 终态快照（RunTaskHandle seam 驱动）', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
    // 先跑一个正常回合产生链尾 checkpoint（快照续接锚点）
    await runtime.engine!.ainvoke({}, { thread_id: 't-abort', round_id: 'r1' });
    const before = await runtime.storage!.get_latest_checkpoint('t-abort');
    expect(before).not.toBeNull();
    // 模拟在途 run：宿主取消句柄（JS 无 asyncio 取消——见文件头延后说明）
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
    const ticket = runtime.begin_run('t-abort');
    runtime.register_active_run_task(handle as never);
    expect(await runtime.abort_current_run()).toBe(true);
    runtime.end_run(ticket);
    const latest = await runtime.storage!.get_latest_checkpoint('t-abort');
    expect(latest).not.toBeNull();
    expect(latest!.reason).toBe(TerminateReason.CANCELLED);
    expect(latest!.state).toEqual(before!.state);
    expect(latest!.parent_id).toBe(before!.checkpoint_id);
    expect(runtime.state).toBe(RuntimeState.RUNNING);
  });

  it('中止不改变生命周期状态；中止后可 stop 正常排空', async () => {
    const runtime = await new Runtime().boot(toHost(new FakeHost()), _minimal_recipe());
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
    const ticket = runtime.begin_run();
    runtime.register_active_run_task(handle as never);
    await runtime.abort_current_run();
    runtime.end_run(ticket);
    expect(runtime.state).toBe(RuntimeState.RUNNING);
    await runtime.stop(); // 无悬挂登记 → 立即关停
    expect(runtime.state).toBe(RuntimeState.STOPPED);
  });
});
