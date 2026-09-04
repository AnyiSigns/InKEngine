/**
 * 运行时机壳数据契约（runtime.py 移植）：Host 嵌入契约五件套 + 装配配方
 * 数据形态（AssemblyRecipe/GraphRecipeContext/ToolWiring）+ 生命周期状态
 * 枚举 + 在途 run 登记凭证。
 *
 * 装配数据与宿主产品解耦：配方字段只允许核心类型与鸭子协议（架构门禁
 * 白名单强制）——宿主类型进入配方 = 机制层开始认识宿主。
 */

import type { InterruptPolicy } from '../approval/approval.js';
import { AssemblyConfig } from '../assembly/index.js';
import type { CompressionPolicy } from '../context/context_compression.js';
import type { EngineTransport } from '../events/events.js';
import type { HarnessDefinition } from '../harness/index.js';
import type { EntitySpec } from '../entities/entities.js';
import type { EventTypeSpec } from '../event_types/eventTypeSpec.js';
import type { Graph } from '../graph/graph.js';
import type { KnowledgeEntry } from '../knowledge_set/index.js';
import type { AsyncLLM } from '../llm/_guard_types.js';
import type { ToolSpec } from '../llm/tools.js';
import type { GraphRegistries } from '../registry/registry.js';
import type { Storage } from '../storage/storage.js';
import type { SelfApplicationPipeline } from '../self_application/index.js';
import type { ConvergenceHook, SelfToolContext } from '../self_tools/index.js';
import type { ToolPipeline } from '../tool_pipeline/tool_pipeline.js';
import { DEFAULT_BIND_CHANNELS } from '../ui_schema/uiSchemaSupport.js';

/** 回合装配源提供者形态（检索结果 + 知识注入 → 装配源清单）。 */
export type AssemblySourceProvider = (
  ctx: { state?: Record<string, unknown> },
) => Promise<unknown[]>;

/**
 * Host 嵌入契约（五件套；决议回流通道不在此——那是宿主自己的请求入口）。
 *
 * 存储工厂（后端/路径/进程锁归宿主）/ 模型解析（配置/密钥归宿主）/
 * 审批策略（直过白名单/超时窗口归宿主）/ 事件传输工厂 / 关停钩子。
 */
export interface Host {
  create_storage(): Promise<Storage>;
  resolve_llm(): Promise<AsyncLLM | null>;
  interrupt_policy(): InterruptPolicy;
  build_transport(): EngineTransport;
  close(): Promise<void>;
}

/** 运行时生命周期状态（镜像 Python RuntimeState StrEnum 值）。 */
export const RuntimeState = {
  UNINITIALIZED: 'uninitialized',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
} as const;
export type RuntimeState = (typeof RuntimeState)[keyof typeof RuntimeState];

/** 在途 run 登记凭证（begin_run 发放，end_run 注销）。 */
export class RunTicket {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

/** 图配方的装配期上下文（Runtime 已装配组件注入，宿主配方按需取用）。 */
export interface GraphRecipeContext {
  llm: AsyncLLM | null;
  tool_pipeline: ToolPipeline | null;
  tool_specs: readonly ToolSpec[];
  all_tool_specs: readonly ToolSpec[];
  collect_specs: ((thread_id?: string | null) => ToolSpec[]) | null;
  storage: Storage | null;
  registries: GraphRegistries | null;
  system_events: ReadonlySet<string>;
  assembly: AssemblyConfig | null;
  assembly_sources: unknown;
}

/**
 * 统一工具分发的宿主差异声明（三路路由机制本身在 Runtime）。
 *
 * self_specs: 宿主自指工具清单工厂（内核 6 契约工具 + 宿主扩展）。
 * self_executor_factory: 宿主自指执行器工厂 (pipeline, context_getter)。
 * self_operation_of: 宿主合并后的自指操作判定（单一判定来源）。
 */
export interface ToolWiring {
  self_specs(): ToolSpec[];
  self_executor_factory(
    pipeline: SelfApplicationPipeline,
    context_getter: () => SelfToolContext,
  ): unknown;
  self_operation_of(spec: ToolSpec): [string, string];
}

/** 工具静态审查钩子（ruff/pyright/eslint…宿主注入；core 零 IO 不解释路径）。 */
export type StaticVettingHook = (paths: readonly unknown[]) => readonly string[];

/** AssemblyRecipe 构造选项（字段级覆盖；缺省 = 出厂默认值）。 */
export interface AssemblyRecipeInit {
  set_id?: string;
  seeds?: Array<[string, () => KnowledgeEntry[]]>;
  harness_definitions?: readonly HarnessDefinition[];
  event_type_specs?: readonly EventTypeSpec[];
  entity_specs?: readonly EntitySpec[];
  ui_spec?: Record<string, unknown> | null;
  ui_allowed_channels?: readonly string[];
  ui_allowed_components?: readonly string[];
  ui_allowed_theme_tokens?: readonly string[];
  tool_wiring?: ToolWiring | null;
  vetting_static_hooks?: readonly StaticVettingHook[] | null;
  vetting_l2_hook?: unknown;
  approval_levels?: Record<string, unknown>;
  retrieval_sources?: readonly ((runtime: unknown) => unknown)[];
  apply_targets?: Record<string, (runtime: unknown) => unknown>;
  graph_recipe?: ((ctx: GraphRecipeContext) => Graph) | null;
  on_reverted?: ((patch_id: number, reason: string) => unknown) | null;
  convergence_provider?: (() => ConvergenceHook | null) | null;
  run_options?: unknown;
  compress_policy?: CompressionPolicy | null;
  verify_retry_limit?: number;
  emit_timeline_events?: boolean;
}

/**
 * 装配数据：怎么装配引擎 = 数据（宿主换壳 = 换配方，机制层不感知）。
 *
 * 字段类型只允许核心类型 + 鸭子协议：宿主类型进入配方 = 机制层认识
 * 宿主，违反零绑定承诺。配方归宿主（图 = 宿主产品语义），装配动作归
 * 机制层。
 */
export class AssemblyRecipe {
  set_id = 'default';
  seeds: Array<[string, () => KnowledgeEntry[]]> = [];
  harness_definitions: HarnessDefinition[] = [];
  event_type_specs: EventTypeSpec[] = [];
  entity_specs: EntitySpec[] = [];
  ui_spec: Record<string, unknown> | null = null;
  ui_allowed_channels: readonly string[] = DEFAULT_BIND_CHANNELS;
  ui_allowed_components: readonly string[] = [];
  ui_allowed_theme_tokens: readonly string[] = [];
  tool_wiring: ToolWiring | null = null;
  vetting_static_hooks: readonly StaticVettingHook[] | null = null;
  vetting_l2_hook: unknown = null;
  approval_levels: Record<string, unknown> = {};
  retrieval_sources: Array<(runtime: unknown) => unknown> = [];
  apply_targets: Record<string, (runtime: unknown) => unknown> = {};
  graph_recipe: ((ctx: GraphRecipeContext) => Graph) | null = null;
  on_reverted: ((patch_id: number, reason: string) => unknown) | null = null;
  convergence_provider: (() => ConvergenceHook | null) | null = null;
  run_options: unknown = null;
  compress_policy: CompressionPolicy | null = null;
  verify_retry_limit = 0;
  emit_timeline_events = false;

  constructor(init: AssemblyRecipeInit = {}) {
    if (init.set_id !== undefined) this.set_id = init.set_id;
    if (init.seeds !== undefined) this.seeds = [...init.seeds];
    if (init.harness_definitions !== undefined) {
      this.harness_definitions = [...init.harness_definitions];
    }
    if (init.event_type_specs !== undefined) {
      this.event_type_specs = [...init.event_type_specs];
    }
    if (init.entity_specs !== undefined) this.entity_specs = [...init.entity_specs];
    if (init.ui_spec !== undefined) this.ui_spec = init.ui_spec;
    if (init.ui_allowed_channels !== undefined) {
      this.ui_allowed_channels = init.ui_allowed_channels;
    }
    if (init.ui_allowed_components !== undefined) {
      this.ui_allowed_components = init.ui_allowed_components;
    }
    if (init.ui_allowed_theme_tokens !== undefined) {
      this.ui_allowed_theme_tokens = init.ui_allowed_theme_tokens;
    }
    if (init.tool_wiring !== undefined) this.tool_wiring = init.tool_wiring;
    if (init.vetting_static_hooks !== undefined) {
      this.vetting_static_hooks = init.vetting_static_hooks;
    }
    if (init.vetting_l2_hook !== undefined) this.vetting_l2_hook = init.vetting_l2_hook;
    if (init.approval_levels !== undefined) {
      this.approval_levels = { ...init.approval_levels };
    }
    if (init.retrieval_sources !== undefined) {
      this.retrieval_sources = [...init.retrieval_sources];
    }
    if (init.apply_targets !== undefined) this.apply_targets = { ...init.apply_targets };
    if (init.graph_recipe !== undefined) this.graph_recipe = init.graph_recipe;
    if (init.on_reverted !== undefined) this.on_reverted = init.on_reverted;
    if (init.convergence_provider !== undefined) {
      this.convergence_provider = init.convergence_provider;
    }
    if (init.run_options !== undefined) this.run_options = init.run_options;
    if (init.compress_policy !== undefined) this.compress_policy = init.compress_policy;
    if (init.verify_retry_limit !== undefined) {
      this.verify_retry_limit = init.verify_retry_limit;
    }
    if (init.emit_timeline_events !== undefined) {
      this.emit_timeline_events = init.emit_timeline_events;
    }
  }
}
