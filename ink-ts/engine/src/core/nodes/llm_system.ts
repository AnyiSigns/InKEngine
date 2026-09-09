/**
 * llm 类结点 system 消息合成（boot 只读基线 + 自定义 system_prompt 拼一份）。
 *
 * 定稿语义（口径决议 16）：llm 类结点执行时的 system = boot（恒在前、只读
 * 基线、装配端注入）+ 自定义（config.system_prompt，用户/agent 可改）拼接成
 * 一条 system 消息。boot 由 seams.boot_system_prompt 注入（缺省 '' = 未装配
 * 宿主时零漂移回落旧行为）；纯函数，无 import 依赖，core 不持有 boot 文本。
 */

/** boot 与自定义系统提示词合成：双非空 = `boot + '\n\n' + custom`；
 *  仅一侧非空 = 该侧原样；双空 = ''。boot 恒在自定义之前（只读基线）。 */
export function compose_llm_system(boot: string, custom: string): string {
  if (boot === '') return custom;
  if (custom === '') return boot;
  return `${boot}\n\n${custom}`;
}
