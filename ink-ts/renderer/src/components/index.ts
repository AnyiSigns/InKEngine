/**
 * 机制通用组件注册表装配（模块加载即注册）：渲染器组件白名单基线。
 *
 * 注册即白名单放行；本层只保留跨视图机制件（组装候选留痕、执行树卡等
 * 运行时装配名）。
 * 产品 canonical 组件（file_tree / session_list / message_list / agent_input /
 * top_bar / settings_floater / evolution_feed 等）为真 ui 面插件（faces/ui
 * 同住实现），由 pluginFaces.generated.ts 装配期注册——spec 主壳直渲的
 * 映射面，不再放在通用组件层（避免通用层 import 产品视图）。
 *
 * 旧布局组件（summary_bar / view_header / incubator / evolution 族 /
 * simulation_tree / source_trace / architecture_view / path_dag /
 * message_list 旧实现等）已删除：消息渲染唯一归 MessageStream（K5），
 * 机制深看面统一收进产品页与设置节。
 */

import { registerPathAssemblyRenderers } from '@/renderer/pathAssembly';
import { registerExecutionTreeRenderers } from '@/renderer/executionTree';

/** 装配机制通用组件（幂等：注册表同名覆盖语义天然幂等）。
 *  保持函数签名供产品壳装配与渲染器白名单测试复用。 */
export function registerBuiltinComponents(): void {
  registerPathAssemblyRenderers();
  registerExecutionTreeRenderers();
}
