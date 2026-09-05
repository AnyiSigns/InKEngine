/**
 * 产品配方（AssemblyRecipe）构建 + 产品配方默认表（D14）。
 *
 * 机制接线靠引擎默认装配直接接上（cfe47b9，宿主零代码接线）；本文件只出
 * 两样东西：
 * 1. PRODUCT_SWITCH_DEFAULTS——产品配方开关默认表（一处种子默认表，非逐
 *    机制接线代码）：PathAssemblyFlags 七位与各布尔开关默认全开 true（含
 *    canary 验证链、context_window 多域模式、回合时间线事件）；关闭只走
 *    显式产品配置（assembly.switches / assembly.run_options 覆写）。安全/
 *    审批姿态不在本表（D8：默认 fail-closed，autoApprove 显式才放行）。
 * 2. build_product_recipe——boot 种子 / 事件类型 / harness / ui_spec 白名单
 *    / tool_wiring / approval_levels 的装配（engine 已具 boot 种子 → 直接
 *    引用不复制）；graph_recipe 为预留注入位（S6 填充，本阶段由调用方注入
 *    或显式留空——Runtime 装配要求非空图配方，留空由 index 装配入口给出
 *    明确错误而非静默装配）。
 *
 * boot 资产真源在 engine adapters/boot 与 core/self_tools：此处只引用。
 */

import {
  AssemblyRecipe,
  BOOT_EVENT_TYPES,
  BOOT_UI_SPEC,
  RunOptions,
  boot_harness_definition,
  build_boot_seed_entries,
  make_self_executor,
  operation_of,
  self_tool_specs,
} from '@ink-ts/engine';
import type { Graph, GraphRecipeContext, ToolWiring } from '@ink-ts/engine';

/** 图配方注入位形态（S6 填充产品图；本阶段测试/调用方注入）。 */
export type RecipeGraph = (ctx: GraphRecipeContext) => Graph;

/** 产品机制开关默认表（D14 全开；关闭只走显式产品配置）。 */
export const PRODUCT_SWITCH_DEFAULTS = {
  // ── PathAssemblyFlags 七位（域装配开关组；engine 构造缺省 false，
  //    产品默认表全开——逐机制读取点按需消费，无空转） ──
  contract_enabled: true,
  edge_evidence_enabled: true,
  settle_hooks_enabled: true,
  pool_governance_enabled: true,
  assembler_enabled: true,
  multipath_enabled: true,
  fingerprint_cache_enabled: true,
  // ── 布尔机制开关（含 canary 验证链 / context_window 多域模式 / 时间线） ──
  canary_verification: true,
  context_window_multidomain: true,
  emit_timeline_events: true,
} as const;

export type ProductSwitchName = keyof typeof PRODUCT_SWITCH_DEFAULTS;

/** 显式产品配置：开关局部覆写（false = 显式关闭；未列键 = 保持默认开）。 */
export interface ProductSwitchOverrides {
  switches?: Partial<Record<ProductSwitchName, boolean>> | null;
  /** 执行域选项（RunOptions 形态，非 None 字段覆盖配方默认——引擎唯一
   *  在执行面消费的多径/时间线开关通道）。 */
  run_options?: Partial<RunOptions> | null;
}

/** 配方构建选项（图配方为调用方注入位；approval_levels 属产品配置表）。 */
export interface ProductRecipeInit extends ProductSwitchOverrides {
  graph_recipe?: RecipeGraph | null;
  approval_levels?: Record<string, unknown> | null;
  ui_allowed_components?: readonly string[];
  ui_allowed_theme_tokens?: readonly string[];
}

/** 出厂界面白名单（与 boot BOOT_UI_SPEC 渲染面一致的最小集合）。 */
const DEFAULT_UI_COMPONENTS = ['column', 'message_list', 'agent_input'] as const;
const DEFAULT_UI_THEME_TOKENS = ['bg', 'fg', 'accent'] as const;

/** 工具三路声明（engine core/self_tools 契约工具；host 只装配不复制）。 */
function product_tool_wiring(): ToolWiring {
  return {
    self_specs: () => self_tool_specs(),
    self_executor_factory: (pipeline, context_getter) =>
      make_self_executor(pipeline, context_getter),
    self_operation_of: (spec) => operation_of(spec),
  };
}

/** 开关表 → 配方执行域选项（引擎执行面消费项；false = 显式关）。 */
function run_options_from(
  overrides: ProductSwitchOverrides | null | undefined,
): Partial<RunOptions> | null {
  const base: Partial<RunOptions> = {};
  const user = overrides?.switches;
  const multipath = user?.multipath_enabled ?? PRODUCT_SWITCH_DEFAULTS.multipath_enabled;
  const timeline = user?.emit_timeline_events ?? PRODUCT_SWITCH_DEFAULTS.emit_timeline_events;
  base.multipath_enabled = multipath;
  base.emit_timeline_events = timeline;
  Object.assign(base, overrides?.run_options ?? {});
  const effective = Object.entries(base).filter(
    ([, value]) => value !== null && value !== undefined,
  );
  return effective.length > 0 ? (Object.fromEntries(effective) as Partial<RunOptions>) : null;
}

/** 开关默认表断言（防默认表被误改关；单测亦断言）。 */
export function assert_product_switches_all_on(): void {
  const off = (Object.entries(PRODUCT_SWITCH_DEFAULTS) as Array<[string, boolean]>).filter(
    ([, value]) => value !== true,
  );
  if (off.length > 0) {
    throw new Error(`产品配方开关默认表含非 true 项（应全开）: ${off.map(([k]) => k).join(', ')}`);
  }
}

/**
 * 构建产品 AssemblyRecipe（boot 资产直接引用 engine；机制开关默认全开）。
 * graph_recipe 缺省 null（结构化空位）——Runtime 装配要求非空，装配入口
 * （createHost）对 null 给出明确错误，不静默装配空图。
 */
export function build_product_recipe(
  init: ProductRecipeInit = {},
): AssemblyRecipe {
  assert_product_switches_all_on();
  const recipe = new AssemblyRecipe({
    set_id: 'default',
    seeds: [['boot', build_boot_seed_entries]],
    harness_definitions: [boot_harness_definition()],
    event_type_specs: [...BOOT_EVENT_TYPES],
    ui_spec: BOOT_UI_SPEC as Record<string, unknown>,
    ui_allowed_components: [
      ...(init.ui_allowed_components ?? DEFAULT_UI_COMPONENTS),
    ],
    ui_allowed_theme_tokens: [
      ...(init.ui_allowed_theme_tokens ?? DEFAULT_UI_THEME_TOKENS),
    ],
    tool_wiring: product_tool_wiring(),
    approval_levels: (init.approval_levels ?? {}) as Record<string, unknown>,
  });
  recipe.graph_recipe = init.graph_recipe ?? null;
  recipe.run_options = run_options_from(init);
  return recipe;
}
