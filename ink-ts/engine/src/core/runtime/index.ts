/**
 * 运行时机壳公开面（runtime.py ``__all__`` 镜像）。
 *
 * 引擎 = 库之上、宿主之下的中间层：Runtime 把「怎么装配引擎」从宿主装配
 * 配方（boot 样板）升级为引擎公开机制——装配决策全部数据化
 * （AssemblyRecipe），宿主只提供五件套契约（存储工厂/模型解析/审批策略/
 * 事件传输工厂/关停钩子）。web/CLI/桌面/stdio 皆为宿主之一，换壳 = 换
 * 配方 + 换五件套，机制层不感知宿主形态。
 *
 * 文件拆分纪律：常量/数据契约落 _constants/_types；确定性身份/知识归因
 * 钩子落 _helpers/_settle；Runtime 类按机制边界分层（_runtime_*）。
 */

export {
  AssemblyRecipe,
  RuntimeState,
  RunTicket,
} from './_types.js';
export type {
  AssemblyRecipeInit,
  AssemblySourceProvider,
  GraphRecipeContext,
  Host,
  StaticVettingHook,
  ToolWiring,
} from './_types.js';

export { Runtime } from './runtime.js';

export { _KnowledgeUsageSettleHook } from './_settle.js';
export { _spec_identity } from './_helpers.js';
export { set_runtime_clock } from './_runtime_base.js';
export type { RunTaskHandle } from './_runtime_runs.js';
