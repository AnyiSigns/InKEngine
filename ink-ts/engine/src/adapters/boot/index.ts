/**
 * 适配层 boot 种子公开面（镜像 Python ink_engine/seeds/boot __all__）。
 *
 * boot = 引擎随带的自举引导数据资产（非领域成品），宿主装配经
 * AssemblyRecipe 直注消费：系统提示词（BOOT_SYSTEM_PROMPT）经
 * boot_system_prompt 注入为 llm 类结点 system 合成基线（boot_prompt 知识
 * 条目注入已退役，build_boot_seed_entries 保留定义）；界面描述（BOOT_UI_SPEC）
 * / 事件类型（BOOT_EVENT_TYPES）/ 自举 harness（boot_harness_definition）/
 * 元工具清单（BOOT_METATOOLS）为装配期数据供宿主直接取用。
 */
export {
  BOOT_EVENT_TYPES,
  BOOT_METATOOLS,
  BOOT_SYSTEM_PROMPT,
  BOOT_UI_SPEC,
  boot_harness_definition,
  build_boot_seed_entries,
  BOOT_PROMPT_SEED_ID,
} from './boot.js';
