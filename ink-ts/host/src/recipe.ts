/**
 * 产品配方（AssemblyRecipe）构建 + 产品配方默认表。
 *
 * 机制开关默认表 PRODUCT_SWITCH_DEFAULTS 十位全开，每位都经 build 映射到
 * AssemblyRecipe 机制开关字段（edge_evidence/settle/pool/assembler/
 * fingerprint/canary/context_window/contract）或执行域 run_options
 * （multipath/时间线事件）——引擎逐位消费，关闭只走显式产品配置
 * （assembly.switches / assembly.run_options 覆写）。安全/审批姿态不在本表
 * （默认 fail-closed，autoApprove 显式才放行）。
 *
 * 其余装配（boot 种子 / 事件类型 / harness / ui_spec 白名单 / tool_wiring /
 * approval_levels）：engine 已具 boot 种子 → 直接引用不复制。图 = 数据
 * （引擎池种子 / 组装产物），本包不再产任何图配方；检索源（vector/fts）由
 * createHost 装配后直注 recipe.retrieval_sources（属宿主领域层，见
 * retrieval/domain.ts）。
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
import type { AssemblyRecipeInit, ToolWiring } from '@ink-ts/engine';

/** 产品机制开关默认表（机制开关全开；关闭只走显式产品配置）。 */
export const PRODUCT_SWITCH_DEFAULTS = {
  // ── AssemblyRecipe 机制开关位（引擎逐位消费；关闭 = 对应机制块不装配）──
  contract_enabled: true,
  edge_evidence_enabled: true,
  settle_hooks_enabled: true,
  pool_governance_enabled: true,
  assembler_enabled: true,
  fingerprint_cache_enabled: true,
  // ── 执行域/独立机制开关（canary 试跑验证 / context 多域混合 / 多径）──
  canary_verification: true,
  context_window_multidomain: true,
  multipath_enabled: true,
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

/** 配方构建选项（approval_levels/ui 白名单属产品配置表；无图配方位——
 *  回合 = 组装出本轮数据图，宿主不产任何静态/默认图）。 */
export interface ProductRecipeInit extends ProductSwitchOverrides {
  approval_levels?: Record<string, unknown> | null;
  ui_allowed_components?: readonly string[];
  ui_allowed_theme_tokens?: readonly string[];
}

/**
 * 出厂界面白名单（与 seed ui_spec / manifest renderer_components 同源）：
 * canonical 组件 = 产品 spec 直渲主壳引用的组件集（映射到前端产品实现，
 * 见 web/src/app/rendererAdapters）；引擎 boot 最小面板（message_list/
 * agent_input）为子集。改动白名单须同步 seed ui_spec 使用集 + manifest
 * contracts.renderer_components + web 组件注册表（gate 对码测试守门）。
 */
const DEFAULT_UI_COMPONENTS = [
  'agent_input',
  'evolution_feed',
  'file_tree',
  'ledger_view',
  'mechanism_view',
  'message_list',
  'review_card',
  'session_list',
  'settings_floater',
  'task_capsule',
  'todo_view',
  'top_bar',
  'trajectory_view',
] as const;
/** 主题 token 白名单 = 引擎 boot 面板 token（bg/fg/accent）∪ 前端语义 token。 */
const DEFAULT_UI_THEME_TOKENS = [
  'bg',
  'fg',
  'accent',
  'bg.base',
  'text.base',
  'accent.approval',
  'status.bubble.fill',
  'status.bubble.edge',
  'status.card.edge',
] as const;

/** 工具三路声明（engine core/self_tools 契约工具；host 只装配不复制）。 */
function product_tool_wiring(): ToolWiring {
  return {
    self_specs: () => self_tool_specs(),
    self_executor_factory: (pipeline, context_getter) =>
      make_self_executor(pipeline, context_getter),
    self_operation_of: (spec) => operation_of(spec),
  };
}

/** 开关取值解析（显式覆写优先；未列键 = 默认表值）。 */
function switchValue(
  overrides: ProductSwitchOverrides | null | undefined,
  name: ProductSwitchName,
): boolean {
  return overrides?.switches?.[name] ?? PRODUCT_SWITCH_DEFAULTS[name];
}

/** 开关表 → AssemblyRecipe 机制开关位（引擎 init 直配，逐位真实消费）。
 *  memory_extract/skill_crystal 自学习族开关不在产品表（引擎默认开）。 */
function assembly_flags_from(
  overrides: ProductSwitchOverrides | null | undefined,
): AssemblyRecipeInit {
  return {
    contract_enabled: switchValue(overrides, 'contract_enabled'),
    edge_evidence_enabled: switchValue(overrides, 'edge_evidence_enabled'),
    settle_hooks_enabled: switchValue(overrides, 'settle_hooks_enabled'),
    pool_governance_enabled: switchValue(overrides, 'pool_governance_enabled'),
    assembler_enabled: switchValue(overrides, 'assembler_enabled'),
    fingerprint_cache_enabled: switchValue(overrides, 'fingerprint_cache_enabled'),
    canary_verification: switchValue(overrides, 'canary_verification'),
    context_window_multidomain: switchValue(overrides, 'context_window_multidomain'),
    emit_timeline_events: switchValue(overrides, 'emit_timeline_events'),
  };
}

/** 开关表 → 配方执行域选项（引擎执行面消费项：多径 + 时间线双通道）。 */
function run_options_from(
  overrides: ProductSwitchOverrides | null | undefined,
): Partial<RunOptions> | null {
  const base: Partial<RunOptions> = {};
  base.multipath_enabled = switchValue(overrides, 'multipath_enabled');
  base.emit_timeline_events = switchValue(overrides, 'emit_timeline_events');
  Object.assign(base, overrides?.run_options ?? {});
  const effective = Object.entries(base).filter(
    ([, value]) => value !== null && value !== undefined,
  );
  return effective.length > 0 ? (Object.fromEntries(effective) as Partial<RunOptions>) : null;
}

/** 开关默认表断言（防默认表被误改关；与开关表同删同留——删表须同步删断言）。 */
export function assert_product_switches_all_on(): void {
  const off = (Object.entries(PRODUCT_SWITCH_DEFAULTS) as Array<[string, boolean]>).filter(
    ([, value]) => value !== true,
  );
  if (off.length > 0) {
    throw new Error(`产品配方开关默认表含非 true 项（应全开）: ${off.map(([k]) => k).join(', ')}`);
  }
}

/**
 * 构建产品 AssemblyRecipe：十位机制开关经 init 字段/run_options 逐位真实
 * 消费（见 PRODUCT_SWITCH_DEFAULTS）。图 = 数据（引擎池种子 / 组装产物），
 * 配方不产任何图配方（graph_recipe 恒为引擎缺省 null）；检索源由装配方
 * （createHost）注入 recipe.retrieval_sources。
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
    ...assembly_flags_from(init),
  });
  recipe.run_options = run_options_from(init);
  return recipe;
}
