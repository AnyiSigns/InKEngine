/**
 * 产品配方（AssemblyRecipe）构建 + 产品配方默认表。
 *
 * 机制开关默认表 PRODUCT_SWITCH_DEFAULTS 全开，每位都经 build 映射到
 * AssemblyRecipe 机制开关字段（edge_evidence/settle_hooks/memory_extract/
 * skill_crystal/memory_recall）或执行域 run_options
 * （multipath/时间线事件）——引擎逐位消费，关闭只走显式产品配置
 * （assembly.switches / assembly.run_options 覆写）。组装链路开关
 * （assembler/pool_governance/fingerprint_cache/contract/candidate_trial/
 * anti_monopoly/canary_verification/context_window_multidomain）与会话级骨架/
 * 自续跑（thread_skeleton/auto_continue）已随
 * 组装链路退役（W7-B），不再进产品表。安全/审批姿态不在本表（默认
 * fail-closed，autoApprove 显式才放行）。
 *
 * 其余装配（boot 引导资产 / 事件类型 / harness / ui_spec 白名单 / tool_wiring /
 * approval_levels）：engine 已具 boot 引导资产 → 直接引用不复制。boot 系统
 * 提示词经 AssemblyRecipe.boot_system_prompt 注入（llm 类结点 system 合成只读
 * 基线，见 engine core/nodes llm_system）；boot 不再作为 boot_prompt 知识条目
 * 注入（build_boot_seed_entries 保留定义供契约兼容/历史，产品 seeds 不再含
 * boot 项）。图 = 数据（引擎池种子 / 执行产物），本包不再产任何图配方；检索源
 * （vector/fts）由 createHost 装配后直注 recipe.retrieval_sources（属宿主领域
 * 层，见 retrieval/domain.ts）。apply_patch 落地后的回合续跑意图写入
 * （ROUND_CONTINUATION_STATE_KEY）已随组装回合自续跑机制退役
 * （self_tools.ts 随退），tool_wiring 直接接引擎 make_self_executor。
 *
 * boot 资产真源在 engine adapters/boot 与 core/self_tools：此处只引用。
 */

import {
  AssemblyRecipe,
  BOOT_EVENT_TYPES,
  BOOT_SYSTEM_PROMPT,
  BOOT_UI_SPEC,
  RunOptions,
  ToolGateConfig,
  boot_harness_definition,
  make_self_executor,
  operation_of,
  self_tool_specs,
} from '@ink-ts/engine';
import type { AssemblyRecipeInit, ToolWiring, AsyncLLM } from '@ink-ts/engine';
import { UI_CANONICAL_COMPONENTS } from './bridge/ui_canonical.generated.js';

/** 产品机制开关默认表（机制开关全开；关闭只走显式产品配置）。 */
export const PRODUCT_SWITCH_DEFAULTS = {
  // ── AssemblyRecipe 机制开关位（引擎逐位消费；关闭 = 对应机制块不装配）──
  edge_evidence_enabled: true,
  settle_hooks_enabled: true,
  memory_extract_enabled: true,
  skill_crystal_enabled: true,
  memory_recall_enabled: true,
  // ── 执行域开关（run_options 通道：多径展开 + 时间线事件）──
  // W7-B 收口：canary_verification/context_window_multidomain 两位的装配域
  // 消费面（assembler canary/context 多域混合挂载）已随组装链路退役且无
  // 新落点，从默认表移除（保留位 = 全开且每位真实消费）。
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

/** 配方构建选项（approval_levels/tool_gate/ui 白名单属产品配置表；无图配方位——
 *  回合 = 组装出本轮数据图，宿主不产任何静态/默认图）。 */
export interface ProductRecipeInit extends ProductSwitchOverrides {
  approval_levels?: Record<string, unknown> | null;
  /** 统一工具流水线门禁装配数据（null/缺省 = 引擎默认 DENY 兜底无 review
   *  档——现行为不变）。review_tools = 权限命中的工具仍转审批挂卡（产品
   *  声明的工具审批档；autoApprove/直过名单语义仍走宿主 interrupt_policy）。 */
  tool_gate?: ToolGateConfig | null;
  /** 作用域 model 引用解析接线位（设计稿 §五/§7.5：作用域属性天然生效的装配
   *  面）：宿主按 model 引用（provider/model_id）从用户 model 列表取端点；
   *  null/缺省 = 未接线，agent 子作用域引用非 null model 时引擎显式失败，
   *  绝不静默跑父模型（执行运行时的作用域轮次经同一 resolver，见 boot.ts）。 */
  scope_model_llm?:
    | ((model: Record<string, string>) => AsyncLLM | Promise<AsyncLLM | null> | null)
    | null;
  ui_allowed_components?: readonly string[];
  ui_allowed_theme_tokens?: readonly string[];
}

/**
 * 出厂界面白名单（canonical 组件 = 产品主壳布局引用组件集）：真源 =
 * plugins/ui_features/<id>/spec.json 布局树（生成物
 * bridge/ui_canonical.generated.ts 派生，verify:plugin-manifest 强制一致；
 * 与旧侧 inkling/manifest.json contracts.renderer_components、web 组件
 * 注册表同值对码，gate 测试守漂移）。引擎 boot 最小面板（message_list/
 * agent_input）为其子集。加布局新组件 = plugins/ui_features 新增组件插件 +
 * 重跑生成器。
 */
// canonical 白名单 = 派生生成物（禁手改；改动走 plugins/ui_features 真源）
const DEFAULT_UI_COMPONENTS = UI_CANONICAL_COMPONENTS;
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

/** 工具三路声明（engine core/self_tools 契约工具；host 只装配不复制）。
 *  自指执行器 = 引擎缺省执行器直连（续跑意图写随组装回合自续跑退役）。 */
function product_tool_wiring(): ToolWiring {
  return {
    self_specs: () => self_tool_specs(),
    self_executor_factory: (pipeline, context_getter) =>
      make_self_executor(pipeline, context_getter as never),
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
 *  组装链开关（assembler/pool/fingerprint/contract/candidate_trial/
 *  anti_monopoly）与会话级骨架/自续跑已随组装链路退役，不再映射；其余
 *  保留开关（edge_evidence/settle/memory/skill_crystal）直配；出厂边先验
 *  （seed_edges_enabled）为引擎默认 false 保守档，不进产品开关表。 */
function assembly_flags_from(
  overrides: ProductSwitchOverrides | null | undefined,
): AssemblyRecipeInit {
  return {
    edge_evidence_enabled: switchValue(overrides, 'edge_evidence_enabled'),
    settle_hooks_enabled: switchValue(overrides, 'settle_hooks_enabled'),
    memory_extract_enabled: switchValue(overrides, 'memory_extract_enabled'),
    skill_crystal_enabled: switchValue(overrides, 'skill_crystal_enabled'),
    memory_recall_enabled: switchValue(overrides, 'memory_recall_enabled'),
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
 * 构建产品 AssemblyRecipe：保留开关位经 init 字段/run_options 逐位真实消费
 * （见 PRODUCT_SWITCH_DEFAULTS；组装链开关已随组装链路退役不入表）。图 =
 * 数据（引擎池种子 / 执行产物），配方不产任何图；检索源由装配方（createHost）
 * 注入 recipe.retrieval_sources。
 */
export function build_product_recipe(
  init: ProductRecipeInit = {},
): AssemblyRecipe {
  assert_product_switches_all_on();
  const recipe = new AssemblyRecipe({
    set_id: 'default',
    boot_system_prompt: BOOT_SYSTEM_PROMPT,
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
    tool_gate: init.tool_gate ?? null,
    // 公开 AsyncLLM 契约（core/llm/base）与 Runtime 守卫链 seam（_guard_types）
    // 结构近似但不平等——宿主实现经鸭子转换进入配方（host.ts 头注同款纪律）
    ...(init.scope_model_llm !== undefined && init.scope_model_llm !== null
      ? { scope_model_llm: init.scope_model_llm as unknown as AssemblyRecipeInit['scope_model_llm'] }
      : {}),
    ...assembly_flags_from(init),
  });
  recipe.run_options = run_options_from(init);
  return recipe;
}

/** 能力记录工具档位（tier_overrides）→ 门禁装配数据：'review' 档工具并入
 *  review_tools（装配期注入，重启后生效）；'allow' 档 = 权限命中常态直过，
 *  无门禁档位动作（未声明权限仍走 DENY 兜底）。门禁数据 + 能力档位并集，
 *  不丢配方既有 default_policy/review_tools。 */
export function merge_capability_tier_gate(
  gate: ToolGateConfig | null,
  tier_overrides: Record<string, unknown> | null | undefined,
): ToolGateConfig | null {
  const reviews: string[] = [];
  if (tier_overrides !== null && tier_overrides !== undefined) {
    for (const [name, value] of Object.entries(tier_overrides)) {
      if (value === 'review') reviews.push(name);
    }
  }
  if (reviews.length === 0) return gate;
  const baseTools = gate !== null ? [...gate.review_tools] : [];
  return new ToolGateConfig({
    default_policy: gate !== null ? gate.default_policy : undefined,
    review_tools: [...new Set([...baseTools, ...reviews])],
  });
}
