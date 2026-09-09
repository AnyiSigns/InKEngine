/**
 * 产品配方（AssemblyRecipe）构建 + 产品配方默认表。
 *
 * 机制开关默认表 PRODUCT_SWITCH_DEFAULTS 十二位全开，每位都经 build 映射到
 * AssemblyRecipe 机制开关字段（edge_evidence/settle/pool/assembler/
 * fingerprint/canary/context_window/contract/candidate_trial/anti_monopoly）
 * 或执行域 run_options（multipath/时间线事件）——引擎逐位消费，关闭只走显式
 * 产品配置（assembly.switches / assembly.run_options 覆写）。P4.1 候选层探索
 * 预算（候选试用 + 反垄断）参数走产品保守默认（epsilon 0.03 / 窗口 8），随
 * 两位开关开合（开关开 = 经配方传引擎启用）。安全/审批姿态不在本表
 * （默认 fail-closed，autoApprove 显式才放行）。
 *
 * 其余装配（boot 引导资产 / 事件类型 / harness / ui_spec 白名单 / tool_wiring /
 * approval_levels）：engine 已具 boot 引导资产 → 直接引用不复制。boot 系统
 * 提示词经 AssemblyRecipe.boot_system_prompt 注入（llm 类结点 system 合成只读
 * 基线，见 engine core/nodes llm_system）；boot 不再作为 boot_prompt 知识条目
 * 注入（build_boot_seed_entries 保留定义供契约兼容/历史，产品 seeds 不再含
 * boot 项）。图 = 数据（引擎池种子 / 组装产物），本包不再产任何图配方；检索源
 * （vector/fts）由 createHost 装配后直注 recipe.retrieval_sources（属宿主领域
 * 层，见 retrieval/domain.ts）。P4：会话级骨架 + 回合结束自续跑按产品默认
 * 开启（PRODUCT_SESSION_DEFAULTS：thread_skeleton_enabled=true、
 * auto_continue_limit=3，口径决议 9/12），显式产品配置可关可调；apply_patch
 * 落地后的续跑意图写入见 self_tools.ts（make_product_self_executor）。
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
  operation_of,
  self_tool_specs,
} from '@ink-ts/engine';
import type { AssemblyRecipeInit, ToolWiring } from '@ink-ts/engine';
import { UI_CANONICAL_COMPONENTS } from './bridge/ui_canonical.generated.js';
import { make_product_self_executor } from './self_tools.js';

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
  // ── P4.1 候选层探索预算（产品默认开启候选试用 + 反垄断，保守参数见
  //    PRODUCT_EXPLORATION_DEFAULTS；关闭 = 候选排序回落纯证据序）──
  candidate_trial_enabled: true,
  anti_monopoly_enabled: true,
} as const;

export type ProductSwitchName = keyof typeof PRODUCT_SWITCH_DEFAULTS;

/** 产品 P4.1 候选层探索预算参数默认（保守档；显式产品配置可经开关整体关闭，
 *  参数走本默认——如需调参用引擎 AssemblyRecipe 直配）。 */
export const PRODUCT_EXPLORATION_DEFAULTS = {
  /** 无样本候选试用概率（保守 3%；<=0 = 概率通道关闭）。 */
  candidate_trial_epsilon: 0.03,
  /** 反垄断连续顶选观察窗口（最近 N 轮同指纹连续顶选 → 强试次优）。 */
  anti_monopoly_window: 8,
} as const;

/** 产品会话级骨架默认（P4 口径决议 9：正常会话也走会话级骨架；决议 12 自续
 *  链上限 3）——thread 尺度配置非机制开关位（不进 assert 全开表，显式产品
 *  配置可关可调）。 */
export const PRODUCT_SESSION_DEFAULTS = {
  /** 会话级骨架模式（引擎缺省 false = 旧回合级组装；产品默认开会话级）。 */
  thread_skeleton_enabled: true,
  /** 回合结束自续跑护栏上限（单次显式触发的自动续回合链预算；0 = 关）。 */
  auto_continue_limit: 3,
} as const;

/** 会话级骨架/自续跑护栏显式产品配置（缺省 = PRODUCT_SESSION_DEFAULTS）。 */
export interface ProductSessionOverrides {
  /** 会话级骨架模式（false = 回落回合级组装旧行为）。 */
  thread_skeleton_enabled?: boolean | null;
  /** 自续跑护栏上限（0/负 = 关闭自续；>0 = 单次显式触发可自动续回合数）。 */
  auto_continue_limit?: number | null;
}

/** 显式产品配置：开关局部覆写（false = 显式关闭；未列键 = 保持默认开）。 */
export interface ProductSwitchOverrides {
  switches?: Partial<Record<ProductSwitchName, boolean>> | null;
  /** 执行域选项（RunOptions 形态，非 None 字段覆盖配方默认——引擎唯一
   *  在执行面消费的多径/时间线开关通道）。 */
  run_options?: Partial<RunOptions> | null;
  /** 会话级骨架 + 自续跑护栏覆写（P4；缺省 = PRODUCT_SESSION_DEFAULTS）。 */
  session?: ProductSessionOverrides | null;
}

/** 配方构建选项（approval_levels/tool_gate/ui 白名单属产品配置表；无图配方位——
 *  回合 = 组装出本轮数据图，宿主不产任何静态/默认图）。 */
export interface ProductRecipeInit extends ProductSwitchOverrides {
  approval_levels?: Record<string, unknown> | null;
  /** 统一工具流水线门禁装配数据（null/缺省 = 引擎默认 DENY 兜底无 review
   *  档——现行为不变）。review_tools = 权限命中的工具仍转审批挂卡（产品
   *  声明的工具审批档；autoApprove/直过名单语义仍走宿主 interrupt_policy）。 */
  tool_gate?: ToolGateConfig | null;
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

/** 工具三路声明（engine core/self_tools 契约工具；host 只装配不复制）。 */
function product_tool_wiring(): ToolWiring {
  return {
    self_specs: () => self_tool_specs(),
    // 自指执行器包续跑意图写（P4-B-1）：apply_patch 落地成功 → 当前回合
    // state 置 _round_continuation（reason=evolved），引擎回合收尾自动续回合
    self_executor_factory: (pipeline, context_getter) =>
      make_product_self_executor(pipeline, context_getter),
    self_operation_of: (spec) => operation_of(spec),
  };
}

/** 会话级骨架模式解析（显式覆写优先；缺省 = 产品默认开会话级骨架）。 */
function sessionSkeletonEnabled(
  overrides: ProductSwitchOverrides | null | undefined,
): boolean {
  const value = overrides?.session?.thread_skeleton_enabled;
  if (typeof value === 'boolean') return value;
  return PRODUCT_SESSION_DEFAULTS.thread_skeleton_enabled;
}

/** 自续跑护栏上限解析（显式数值覆写优先；0/负 = 关闭；缺省 = 产品默认 3）。
 *  非有限/非数值覆写 = 回落产品默认（防配方误写击穿护栏配置）。 */
function sessionContinueLimit(
  overrides: ProductSwitchOverrides | null | undefined,
): number {
  const value = overrides?.session?.auto_continue_limit;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  return PRODUCT_SESSION_DEFAULTS.auto_continue_limit;
}

/** 开关取值解析（显式覆写优先；未列键 = 默认表值）。 */
function switchValue(
  overrides: ProductSwitchOverrides | null | undefined,
  name: ProductSwitchName,
): boolean {
  return overrides?.switches?.[name] ?? PRODUCT_SWITCH_DEFAULTS[name];
}

/** 开关表 → AssemblyRecipe 机制开关位（引擎 init 直配，逐位真实消费）。
 *  memory_extract/skill_crystal 自学习族开关不在产品表（引擎默认开）。会话级
 *  骨架/自续跑护栏随 init 字段直配（PRODUCT_SESSION_DEFAULTS，见上）；P4.1
 *  候选层探索预算随开关开合携带产品保守参数（PRODUCT_EXPLORATION_DEFAULTS）。 */
function assembly_flags_from(
  overrides: ProductSwitchOverrides | null | undefined,
): AssemblyRecipeInit {
  const trialOn = switchValue(overrides, 'candidate_trial_enabled');
  const monopolyOn = switchValue(overrides, 'anti_monopoly_enabled');
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
    // ── P4 会话级骨架 + 回合结束自续跑（产品默认开会话级；可显式关）──
    thread_skeleton_enabled: sessionSkeletonEnabled(overrides),
    auto_continue_limit: sessionContinueLimit(overrides),
    // ── P4.1 候选层探索预算（产品默认开；关闭 = 纯证据序零漂移）──
    candidate_trial_enabled: trialOn,
    candidate_trial_epsilon: trialOn ? PRODUCT_EXPLORATION_DEFAULTS.candidate_trial_epsilon : null,
    anti_monopoly_enabled: monopolyOn,
    anti_monopoly_window: monopolyOn ? PRODUCT_EXPLORATION_DEFAULTS.anti_monopoly_window : null,
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
 * 构建产品 AssemblyRecipe：十二位机制开关经 init 字段/run_options 逐位真实
 * 消费（见 PRODUCT_SWITCH_DEFAULTS）。图 = 数据（引擎池种子 / 组装产物），
 * 配方不产任何图；检索源由装配方（createHost）注入 recipe.retrieval_sources。
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
