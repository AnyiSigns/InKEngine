// gate: 超限(356 行) - 运行时机壳数据契约（Host 嵌入契约五件套 + 装配配方数据形态 + P4.2a-3 seed_edges 字段逐键构造，拆字段破坏装配键与构造一一对应可读性）
/**
 * 运行时机壳数据契约（runtime.py 移植）：Host 嵌入契约五件套 + 装配配方
 * 数据形态（AssemblyRecipe/ToolWiring）+ 生命周期状态枚举 + 在途 run 登记凭证。
 *
 * 装配数据与宿主产品解耦：配方字段只允许核心类型与鸭子协议（架构门禁
 * 白名单强制）——宿主类型进入配方 = 机制层开始认识宿主。
 */

import type { InterruptPolicy } from '../../gate/approval/approval.js';
import type { CompressionPolicy } from '../../core/context/context_compression.js';
import type { EngineTransport } from '../../core/events/events.js';
import type { HarnessDefinition } from '../../core/harness/index.js';
import type { EntitySpec } from '../../core/entities/entities.js';
import type { EnvironmentSpec } from '../../core/environments/spec.js';
import type { EventTypeSpec } from '../../model/event_types/eventTypeSpec.js';
import type { KnowledgeEntry } from '../../core/knowledge_set/index.js';
import type { EnginePoolSeed } from '../../graph/nodes/index.js';
import type { AsyncLLM } from '../llm/_guard_types.js';
import type { ToolSpec } from '../llm/tools.js';
import type { ToolGateConfig } from '../../gate/permissions/permissions.js';
import type { NodeFactory } from '../../graph/registry/registry_types.js';
import type { Storage } from '../../dock/ports/storage.js';
import type { SelfApplicationPipeline } from '../self_application/index.js';
import type { ConvergenceHook, SelfToolContext } from '../self_tools/index.js';
import { DEFAULT_BIND_CHANNELS } from '../../model/ui_schema/uiSchemaSupport.js';

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

/**
 * Runtime 实例级可覆写默认（宿主构造时注入；缺省 = runtime 内部确定性
 * 默认，见 _runtime_base）。键源/时钟为运行时装配注入机制件（审计/成长/
 * 回合账本等）的确定性 seam——unit 级机制模块直接构造仍用其自身确定性
 * 缺省，本面只影响 Runtime 装配产物。
 */
export interface RuntimeConfigInit {
  /** 时间源（epoch 秒）；缺省 = 实时钟（模块时钟 seam，可 set_runtime_clock 冻结）。 */
  now?: (() => number) | null;
  /** 审计键片段源（12 位 hex）；缺省 = 每 Runtime 实例自增确定序列。 */
  audit_key_gen?: (() => string) | null;
  /** 成长条目 id 片段源（12 位 hex）；缺省 = 每 Runtime 实例自增确定序列。 */
  growth_uuid_gen?: (() => string) | null;
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

/** AssemblyRecipe 构造选项（字段级覆盖；缺省 = 出厂默认值）。 */
export interface AssemblyRecipeInit {
  set_id?: string;
  seeds?: Array<[string, () => KnowledgeEntry[]]>;
  harness_definitions?: readonly HarnessDefinition[];
  event_type_specs?: readonly EventTypeSpec[];
  entity_specs?: readonly EntitySpec[];
  environment_specs?: readonly EnvironmentSpec[];
  ui_spec?: Record<string, unknown> | null;
  ui_allowed_channels?: readonly string[];
  ui_allowed_components?: readonly string[];
  ui_allowed_theme_tokens?: readonly string[];
  tool_wiring?: ToolWiring | null;
  vetting_l2_hook?: unknown;
  approval_levels?: Record<string, unknown>;
  /** 统一工具流水线权限门禁装配数据（null = 引擎默认 DENY 兜底、无 review
   *  档——现行为不变；review_tools = 某工具命中权限仍转审批挂卡）。 */
  tool_gate?: ToolGateConfig | null;
  /** llm 类结点 system 合成基线（装配注入只读 boot 提示词；缺省 '' =
   *  无基线 = 既有自定义 system_prompt 直取行为零漂移）。文本由宿主/adapters
   *  装配端提供（core 不持有 boot 内容），经 seams.boot_system_prompt 落到
   *  llm_decider/router_judge 等 llm 类结点执行面。 */
  boot_system_prompt?: string;
  retrieval_sources?: readonly ((runtime: unknown) => unknown)[];
  apply_targets?: Record<string, (runtime: unknown) => unknown>;
  /** 引擎内置基础节点池种子（null = 出厂默认池种子；显式空启停数据见
   *  EnginePoolSeed.enabled——覆写走数据不进代码）。 */
  pool_seed?: EnginePoolSeed | null;
  /** 宿主/agent 注入结点类型的执行体绑定解析表（binding name → 工厂）。
   *  声明式注册表恢复时按登记行 executor 绑定名查此表重建执行体注册；
   *  缺绑定 = 登记保留、运行时不注册（diag 留痕）。 */
  node_executors?: Record<string, NodeFactory> | null;
  on_reverted?: ((patch_id: number, reason: string) => unknown) | null;
  convergence_provider?: (() => ConvergenceHook | null) | null;
  /** 执行域选项（RunOptions 形态；随装配保留——当前引擎装配面不再逐字段
   *  消费（执行主线 = execution_runtime），字段仅作配方兼容不做行为注入）。 */
  run_options?: unknown;
  compress_policy?: CompressionPolicy | null;
  // ── 机制开关（引擎默认全开；false = 对应机制块显式关闭）──
  /** 边证据写入钩子（证据归集/失败审计证据源；false = 不登记归因钩子）。 */
  edge_evidence_enabled?: boolean;
  /** 沉淀钩子族整体（归因/审计/提案/晋升/复审族；false = 整族不注册）。 */
  settle_hooks_enabled?: boolean;
  // ── 出厂边先验（引擎默认关闭——先验入证据面会改变归因统计，保守档）──
  /** 出厂边先验写入开关：开启时经 import_seed_paths 把（缺省 = 出厂可喂链
   *  default_engine_seed_edges，或本配方 seed_edges）写入证据面。缺省 false
   *  = 先验不入证据面。 */
  seed_edges_enabled?: boolean;
  /** 出厂边先验数据覆写（null/缺省 = 引擎出厂 default_engine_seed_edges）。 */
  seed_edges?: readonly (
    | import('../../core/edge_evidence/seed.js').SeedEdgeRaw
    | Record<string, unknown>
  )[] | null;
  // ── 自学习族开关（引擎默认全开；false = 该块不装配）──
  /** 回合记忆抽取（回合账本 → memory 域 settle 钩子；false = 不装配存储/钩子）。 */
  memory_extract_enabled?: boolean;
  /** 技能知识容器（知识集 kind=path 条目访问器；false = 不装配）。 */
  skill_crystal_enabled?: boolean;
  /** 记忆自动回灌（回合上下文源 recall user:default 条目；false = 回合不回灌记忆）。
   *  仅 memory_store 已装配（memory_extract_enabled）时生效。 */
  memory_recall_enabled?: boolean;
  // ── 作用域模型解析（批4 agent 子作用域 model override 的装配接线位）──
  /** 按 model 引用（provider/model_id）解析 AsyncLLM 的宿主接线（null/缺省
   *  = 未接线：agent 结点实体引用非 null model 时显式失败，不静默跑父模型）。
   *  解析返回实例由装配统一包守卫链（用量/压缩）；缺省 null = seams
   *  resolve_scope_llm 不注入，engine 不持有厂商模型解析实现。 */
  scope_model_llm?:
    | ((model: Record<string, string>) => AsyncLLM | Promise<AsyncLLM | null> | null)
    | null;
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
  environment_specs: EnvironmentSpec[] = [];
  ui_spec: Record<string, unknown> | null = null;
  ui_allowed_channels: readonly string[] = DEFAULT_BIND_CHANNELS;
  ui_allowed_components: readonly string[] = [];
  ui_allowed_theme_tokens: readonly string[] = [];
  tool_wiring: ToolWiring | null = null;
  vetting_l2_hook: unknown = null;
  approval_levels: Record<string, unknown> = {};
  tool_gate: ToolGateConfig | null = null;
  boot_system_prompt = '';
  retrieval_sources: Array<(runtime: unknown) => unknown> = [];
  apply_targets: Record<string, (runtime: unknown) => unknown> = {};
  pool_seed: EnginePoolSeed | null = null;
  node_executors: Record<string, NodeFactory> | null = null;
  on_reverted: ((patch_id: number, reason: string) => unknown) | null = null;
  convergence_provider: (() => ConvergenceHook | null) | null = null;
  run_options: unknown = null;
  compress_policy: CompressionPolicy | null = null;
  // ── 机制开关（引擎默认全开；false = 对应机制块显式关闭）──
  edge_evidence_enabled = true;
  settle_hooks_enabled = true;
  // ── 出厂边先验（引擎默认关闭——先验入证据面会改变归因统计，保守档）──
  seed_edges_enabled = false;
  seed_edges: readonly (
    | import('../../core/edge_evidence/seed.js').SeedEdgeRaw
    | Record<string, unknown>
  )[] | null = null;
  // ── 自学习族开关（引擎默认全开；false = 该块不装配）──
  memory_extract_enabled = true;
  skill_crystal_enabled = true;
  memory_recall_enabled = true;
  // ── 作用域模型解析（批4 agent 子作用域 model override 装配接线位）──
  scope_model_llm: ((model: Record<string, string>) => AsyncLLM | Promise<AsyncLLM | null> | null) | null = null;

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
    if (init.environment_specs !== undefined) {
      this.environment_specs = [...init.environment_specs];
    }
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
    if (init.vetting_l2_hook !== undefined) this.vetting_l2_hook = init.vetting_l2_hook;
    if (init.approval_levels !== undefined) {
      this.approval_levels = { ...init.approval_levels };
    }
    if (init.tool_gate !== undefined) this.tool_gate = init.tool_gate;
    if (init.boot_system_prompt !== undefined) {
      this.boot_system_prompt = init.boot_system_prompt;
    }
    if (init.retrieval_sources !== undefined) {
      this.retrieval_sources = [...init.retrieval_sources];
    }
    if (init.apply_targets !== undefined) this.apply_targets = { ...init.apply_targets };
    if (init.pool_seed !== undefined) this.pool_seed = init.pool_seed;
    if (init.node_executors !== undefined) this.node_executors = init.node_executors;
    if (init.on_reverted !== undefined) this.on_reverted = init.on_reverted;
    if (init.convergence_provider !== undefined) {
      this.convergence_provider = init.convergence_provider;
    }
    if (init.run_options !== undefined) this.run_options = init.run_options;
    if (init.compress_policy !== undefined) this.compress_policy = init.compress_policy;
    if (init.edge_evidence_enabled !== undefined) {
      this.edge_evidence_enabled = init.edge_evidence_enabled;
    }
    if (init.settle_hooks_enabled !== undefined) {
      this.settle_hooks_enabled = init.settle_hooks_enabled;
    }
    if (init.seed_edges_enabled !== undefined) {
      this.seed_edges_enabled = init.seed_edges_enabled;
    }
    if (init.seed_edges !== undefined && init.seed_edges !== null) {
      this.seed_edges = init.seed_edges;
    }
    if (init.memory_extract_enabled !== undefined) {
      this.memory_extract_enabled = init.memory_extract_enabled;
    }
    if (init.skill_crystal_enabled !== undefined) {
      this.skill_crystal_enabled = init.skill_crystal_enabled;
    }
    if (init.memory_recall_enabled !== undefined) {
      this.memory_recall_enabled = init.memory_recall_enabled;
    }
    if (init.scope_model_llm !== undefined) {
      this.scope_model_llm = init.scope_model_llm;
    }
  }
}
