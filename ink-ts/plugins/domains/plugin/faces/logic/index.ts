/**
 * plugin 域插件（agent 侧插件管理面工具族）。
 *
 * 域逻辑唯一实现位（S4 域组3 自 hosts/lib/src/plugin_command.ts 迁入，语义零改）：
 * plugin_command 端点族 = B6 agent 插件管理工具（plugin.* 7 工具）执行接线。
 * 宿主 agent 工具声明真源 = plugins/tools/<id>/spec.json（kind='tool'，
 * endpoint='plugin_command'）；本插件 = 执行接线：plugin.catalog 走宿主注入的
 * 目录只读快照面，其余按工具名分发到既有 bridge 命令实现（plugin.mcp.enable →
 * mcp.enable 等）；自定义端点 plugin_command 幂等登记进引擎 EndpointTypeRegistry。
 *
 * 装配边界：createHost（composition root）经跨树 import 本插件包取
 * buildPluginCommandTools 构造工具族（call = bridge 调用闭包，snapshot = 目录
 * 快照面），@ink-ts/host 不再导出 plugin_command 值/类型。
 */

import {
  PLUGIN_COMMAND_ENDPOINT,
  PLUGIN_COMMAND_TOOLS,
  buildPluginCommandTools,
  ensurePluginCommandEndpointRegistered,
  pluginCommandDefinitions,
  pluginCommandEndpointSpec,
  pluginCommandExecutor,
} from './plugin_command.js';
import type {
  PluginCommandCall,
  PluginCommandSnapshot,
  PluginCommandTools,
} from './plugin_command.js';

export {
  PLUGIN_COMMAND_ENDPOINT,
  PLUGIN_COMMAND_TOOLS,
  buildPluginCommandTools,
  ensurePluginCommandEndpointRegistered,
  pluginCommandDefinitions,
  pluginCommandEndpointSpec,
  pluginCommandExecutor,
};
export type {
  PluginCommandCall,
  PluginCommandSnapshot,
  PluginCommandTools,
} from './plugin_command.js';

/** S4 域服务工厂（S0 装载契约）：plugin 域服务面 = 工具族装配接线
 *  （buildPluginCommandTools 由 createHost 注入 call/snapshot 构造并登记）。 */
export default function createPluginDomain(): {
  PLUGIN_COMMAND_ENDPOINT: string;
  PLUGIN_COMMAND_TOOLS: Readonly<Record<string, string>>;
  buildPluginCommandTools: typeof buildPluginCommandTools;
} {
  return {
    PLUGIN_COMMAND_ENDPOINT,
    PLUGIN_COMMAND_TOOLS,
    buildPluginCommandTools,
  };
}
