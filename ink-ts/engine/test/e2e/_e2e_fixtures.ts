/**
 * e2e 装配夹具（镜像 stdio_host.py + test_runtime.py 的配方直注语义）。
 * // gate: test-exempt - e2e 夹具自含配方默认，真源 = plugins/ports/boot（S2 裁决：
 * //        引擎测试不引插件；BOOT_* 资产真源随插件，此处用最小配方常量自含）
 *
 * Host 五件套：create_storage 返回**测试本地 MemoryStorage**（graph/executor/
 * helpers 镜像 conftest memory_storage 口径，不引插件真源），resolve_llm 按
 * 测试注入真适配器产物（null = 不装配模型），build_transport 产出事件收集传输。
 * boot 配方 = 自含最小引导（系统提示词经 AssemblyRecipe.boot_system_prompt
 * 注入；harness/事件类型用公共面 EventTypeSpec/HarnessDefinition 本地最小
 * 定义——真源明细见 plugins/ports/boot，产品宿主经装配层消费）。
 */
import { Runtime, AssemblyRecipe } from '../../src/loop/runtime/index.js';
import type { Host } from '../../src/loop/runtime/index.js';
import type { AsyncLLM } from '../../src/dock/ports/llm.js';
import type { Storage } from '../../src/dock/ports/storage.js';
import { MemoryStorage } from '../graph/executor/helpers.js';
import {
  EventTypeSpec,
  HarnessDefinition,
} from '@ink-ts/engine';
import { DefaultInterruptPolicy } from '../../src/gate/approval/approval.js';
import { CollectorTransport } from '../../src/dock/ports/events.js';
import type { EngineTransport, EngineEvent } from '../../src/dock/ports/events.js';
import {
  make_self_executor,
  operation_of,
  self_tool_specs,
} from '../../src/evolve/proposal/self_edit_tools/index.js';
import type { SelfToolContext } from '../../src/evolve/proposal/self_edit_tools/index.js';

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
    this.storage = new MemoryStorage();
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
 * 最小装配配方（镜像 build_stdio_recipe / 产品宿主 P4.2b 装配形态）：
 * boot 系统提示词经 AssemblyRecipe.boot_system_prompt 注入（llm 类结点
 * system 合成只读基线）；boot 知识条目不再经 seeds 注入；引擎无常驻静态图——
 * 回合 = 组装出本轮数据图再执行（无模型 = 确定性 stub）。set_id 每次唯一，
 * 多集隔离。boot 引导资产 = 测试本地最小配方（EventTypeSpec/HarnessDefinition
 * 公共面构造；真源明细在 plugins/ports/boot，S2 裁决 e2e 不引插件）。
 */
export function e2e_recipe(
  overrides: Partial<AssemblyRecipe> = {},
): AssemblyRecipe {
  const base = new AssemblyRecipe({
    set_id: 'e2e',
    boot_system_prompt: '你是 Forge 自举系统提示词（e2e 最小配方，真源 = plugins/ports/boot）',
    harness_definitions: [
      new HarnessDefinition({
        name: 'InkLing',
        description: '自举领域：观察/提案/应用的元能力集',
        keywords: ['自举', '观察'],
      }),
    ],
    event_type_specs: [
      new EventTypeSpec({ name: 'reply_token', renderer: 'StreamingRow' }),
      new EventTypeSpec({ name: 'review_card', renderer: 'ReviewCard' }),
      new EventTypeSpec({ name: 'error', renderer: 'ErrorRow' }),
    ],
    ui_spec: {
      name: 'boot.panel',
      root: { kind: 'container', type: 'column', children: [] },
      theme: { bg: '#09090b' },
    },
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

/** 便捷装配入口（stdio 宿主 = boot + run；此处镜像配方直注）。 */
export async function boot_runtime(
  host: E2eHost,
  recipe: AssemblyRecipe,
): Promise<Runtime> {
  return new Runtime().boot(toHost(host), recipe);
}
