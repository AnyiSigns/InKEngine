/**
 * e2e 装配夹具（镜像 stdio_host.py + test_runtime.py 的配方直注语义）。
 *
 * Host 五件套：create_storage 返回**真实 MemoryStorage**（adapters/storage），
 * resolve_llm 按测试注入真适配器产物（null = 不装配模型），build_transport
 * 产出事件收集传输。boot 配方 = boot 种子直注（系统提示词 / UI 描述 /
 * 事件类型 / 自举 harness），tool_wiring 复用 core/self_tools 契约工具——
 * 与 Python 端 stdio 配方同构，纯引擎侧、零后端代码。
 */
import { Runtime, AssemblyRecipe } from '../../src/core/runtime/index.js';
import type {
  GraphRecipeContext,
  Host,
} from '../../src/core/runtime/index.js';
import type { AsyncLLM } from '../../src/core/llm/base.js';
import type { Storage } from '../../src/core/storage/storage.js';
import { create_memory_storage, type MemoryStorage } from '../../src/adapters/storage/index.js';
import {
  BOOT_EVENT_TYPES,
  BOOT_SYSTEM_PROMPT,
  BOOT_UI_SPEC,
  boot_harness_definition,
  build_boot_seed_entries,
} from '../../src/adapters/boot/index.js';
import { DefaultInterruptPolicy } from '../../src/core/approval/approval.js';
import { CollectorTransport } from '../../src/core/events/events.js';
import type { EngineTransport, EngineEvent } from '../../src/core/events/events.js';
import { Graph } from '../../src/core/graph/graph.js';
import { system, user } from '../../src/core/llm/messages.js';
import {
  make_self_executor,
  operation_of,
  self_tool_specs,
} from '../../src/core/self_tools/index.js';
import type { SelfToolContext } from '../../src/core/self_tools/index.js';

/**
 * 事件收集 Host（五件套真实现；存储/模型按测试注入）。
 *
 * 注：base.AsyncLLM（核心契约）与 Runtime 内部 _guard_types.AsyncLLM（守卫
 * 链 seam）为两个结构近似但类型上不平等的协议形态，装配经 toHost 鸭子转换
 * 进入 Runtime（与 runtime.test.ts 的 toHost 同纪律），核心不反向依赖适配器。
 */
export class E2eHost {
  readonly storage: MemoryStorage;
  readonly transports: CollectorTransport[] = [];
  llm: AsyncLLM | null;

  constructor(llm: AsyncLLM | null = null) {
    this.storage = create_memory_storage();
    this.llm = llm;
  }

  async create_storage(): Promise<Storage> {
    return this.storage;
  }

  async resolve_llm(): Promise<AsyncLLM | null> {
    return this.llm;
  }

  interrupt_policy(): DefaultInterruptPolicy {
    return new DefaultInterruptPolicy();
  }

  build_transport(): EngineTransport {
    const transport = new CollectorTransport();
    this.transports.push(transport);
    return transport;
  }

  async close(): Promise<void> {
    // 存储由 Runtime 关停顺序关闭；宿主自身无其它资源（镜像 stdio_host）
  }
}

/** 鸭子转换：宿主实现 → Host 契约（存储/模型/策略形态见文件头注）。 */
export function toHost(host: E2eHost): Host {
  return host as unknown as Host;
}

/** 最新一个事件收集传输（ainvoke transports 传参用）。 */
export function latestTransport(host: E2eHost): CollectorTransport {
  return host.build_transport() as CollectorTransport;
}

/** 收集到的指定类型事件（事件序列断言）。 */
export function eventsOf(
  transport: CollectorTransport,
  type: string,
): EngineEvent[] {
  return transport.events.filter((e) => e.type === type);
}

/**
 * 最小装配配方（镜像 build_stdio_recipe）：boot 直注全部引导数据资产；
 * graph_recipe 缺省 = 回声图（无模型依赖）。set_id 每次唯一，多集隔离。
 */
export function e2e_recipe(
  overrides: Partial<AssemblyRecipe> = {},
): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'e2e',
    seeds: [['boot', build_boot_seed_entries]],
    harness_definitions: [boot_harness_definition()],
    event_type_specs: [...BOOT_EVENT_TYPES],
    ui_spec: BOOT_UI_SPEC as Record<string, unknown>,
    ui_allowed_components: ['column', 'message_list', 'agent_input'],
    ui_allowed_theme_tokens: ['bg', 'fg', 'accent'],
    tool_wiring: {
      self_specs: () => self_tool_specs(),
      self_executor_factory: (pipeline, context_getter) =>
        make_self_executor(
          pipeline,
          context_getter as unknown as () => SelfToolContext,
        ),
      self_operation_of: (spec) => operation_of(spec),
    },
    approval_levels: {},
  });
  return Object.assign(base, overrides);
}

/** 回声图：entry（写 count/reply）→ exit（写 done）。无模型依赖。 */
export function linear_graph_recipe(_ctx: GraphRecipeContext): Graph {
  const agent = async (
    ctx: { state: Record<string, unknown> },
  ): Promise<Record<string, unknown>> => ({
    count: ((ctx.state['count'] as number | undefined) ?? 0) + 1,
    reply: `回合:${String(ctx.state['input'] ?? '')}`,
  });
  const finish = async (
    ctx: { state: Record<string, unknown> },
  ): Promise<Record<string, unknown>> => ({
    done: true,
    seen: ctx.state['count'] ?? null,
  });
  const g = new Graph({ name: 'linear', entry: 'agent' });
  g.add_node('agent', agent as never);
  g.add_node('finish', finish as never);
  g.add_edge('agent', 'finish');
  g.add_exit('finish');
  return g;
}

/**
 * 模型回复图（镜像 build_stdio_graph 的最小面）：agent 节点用 ctx.llm
 * （引擎装配的守卫链，末端为真适配器）流式调用，token 逐帧发 reply_token
 * 事件并累积为 state.reply → exit。无工具循环，装配接线冒烟用。
 */
export function llm_chat_graph_recipe(ctx: GraphRecipeContext): Graph {
  const llm = ctx.llm;
  const agent = async (
    rawCtx: unknown,
  ): Promise<Record<string, unknown>> => {
    const nodeCtx = rawCtx as {
      state: Record<string, unknown>;
      emit(type: string, payload: Record<string, unknown>): Promise<void>;
    };
    if (llm === null || llm === undefined) {
      throw new Error('装配冒烟需注入模型（Host.resolve_llm 返回真适配器）');
    }
    const messages = [
      system(BOOT_SYSTEM_PROMPT),
      user(String(nodeCtx.state['input'] ?? '')),
    ];
    let reply = '';
    const stream = llm.astream(messages, { tools: null, params: null });
    for await (const chunk of stream) {
      if (chunk.token) {
        reply += chunk.token;
        await nodeCtx.emit('reply_token', { token: chunk.token });
      }
    }
    return { reply };
  };
  const g = new Graph({ name: 'llm_chat', entry: 'agent' });
  g.add_node('agent', agent as never);
  g.add_exit('agent');
  return g;
}

/** 便捷装配入口（stdio 宿主 = boot + run；此处镜像配方直注）。 */
export async function boot_runtime(
  host: E2eHost,
  recipe: AssemblyRecipe,
): Promise<Runtime> {
  return new Runtime().boot(toHost(host), recipe);
}
