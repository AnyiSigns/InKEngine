/**
 * host plugin_command 工具族执行接线（B6：agent 侧插件管理面）。
 *
 * 宿主 agent 工具的声明真源 = plugins/tools/<id>/spec.json（kind='tool'，
 * endpoint='plugin_command'）；本模块 = hosts/lib 侧执行接线，复用既有宿主
 * 工具通道（harness_registry.declarative 登记声明式定义 + 按端点登记执行体
 * ——W7-B 注：原通道姊妹 session_command 已随组装链路退役）——工具调用按定义名分发到既有 bridge 命令实现
 * （plugin.mcp.enable→mcp.enable 等），plugin.catalog 由宿主注入快照读取面
 * （plugin 目录/组件/常驻集只读快照），不复制机制语义、不新造第二通道。
 *
 * 管理动作（enable/disable/install/remove/组件启停/常驻必带）默认 review 档，
 * 经统一流水线 pose 三档决后由宿主执行体真写（连接/注册表/台账）；只读
 * catalog = allow。端点提取器无会话目标（插件注册表为对象），按 server/参数
 * 归一判定目标。
 */

import {
  DeclarativeToolSpec,
  EndpointTypeSpec,
  endpoint_registry,
  type DeclarativeExecutor,
  type DeclarativeToolSpecInit,
} from '@ink-ts/engine';
import type { DeclarativeToolExecutors } from '@ink-ts/engine';

/** plugin_command 端点族名（plugin 工具行 endpoint 引用 + 本族注册键）。 */
export const PLUGIN_COMMAND_ENDPOINT = 'plugin_command';

/** 目录快照读取面（createHost 注入；plugin.catalog 执行体数据源）。 */
export interface PluginCommandSnapshot {
  (): Promise<Record<string, unknown>>;
}

/** 工具名 → 既有 bridge 命令实现（执行接线单一映射表；新增工具在此登记）。
 *  plugin.catalog 为宿主快照面，不入表（执行体特判）。 */
export const PLUGIN_COMMAND_TOOLS: Readonly<Record<string, string>> = {
  'plugin.mcp.enable': 'mcp.enable',
  'plugin.mcp.disable': 'mcp.disable',
  'plugin.mcp.install': 'mcp.install',
  'plugin.mcp.remove': 'mcp.remove',
  'plugin.components.set': 'ui_components.set_disabled',
  'plugin.baseline.set': 'capability.baseline.set',
} as const;

/** bridge 调用面（createHost 注入：params 透传 + host 审批上下文）。 */
export interface PluginCommandCall {
  (method: string, params: Record<string, unknown>): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** plugin_command 端点类型规格（宿主自定义端点；插件注册表为判定对象）。 */
export function pluginCommandEndpointSpec(): EndpointTypeSpec {
  return new EndpointTypeSpec({
    name: PLUGIN_COMMAND_ENDPOINT,
    actions: ['plugin_command'],
    config_requirements: [],
    output_fields: [],
    extractor: (args) => {
      const params = isRecord(args) ? args : {};
      const id =
        typeof params['server_id'] === 'string' && params['server_id'] !== ''
          ? params['server_id']
          : typeof params['id'] === 'string'
            ? params['id']
            : null;
      if (id !== null) return ['plugin_command', `plugin:${id}`] as [string, string];
      return ['plugin_command', 'plugin:*'] as [string, string];
    },
    failure_reason: () => 'plugin_command 工具参数须为对象',
    sandbox_ops: [],
  });
}

/** 幂等登记 plugin_command 自定义端点（引擎 EndpointTypeRegistry 增补位）。 */
export function ensurePluginCommandEndpointRegistered(): void {
  if (!endpoint_registry.has(PLUGIN_COMMAND_ENDPOINT)) {
    endpoint_registry.register(pluginCommandEndpointSpec());
  }
}

/** 声明式定义公共字段（与 plugins/tools/plugin.* spec 声明对齐）。 */
const DEFINITION_COMMON: Omit<DeclarativeToolSpecInit, 'name' | 'description'> = {
  parameters: {},
  permissions: [],
  endpoint: PLUGIN_COMMAND_ENDPOINT,
  endpoint_config: {},
  meta: { domain: 'plugin', executor: 'host:plugin_command' },
};

function pluginCommandDefinition(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  permissions: readonly string[],
  approval: string,
): DeclarativeToolSpec {
  return new DeclarativeToolSpec({
    ...DEFINITION_COMMON,
    name,
    description,
    parameters,
    permissions,
    meta: { ...DEFINITION_COMMON.meta, approval },
  });
}

/** 七个 agent 工具的运行时声明式定义（与 plugins/tools spec 声明对齐）。 */
export function pluginCommandDefinitions(): DeclarativeToolSpec[] {
  ensurePluginCommandEndpointRegistered();
  const idParam = (label = 'MCP 工具型插件/server id'): Record<string, unknown> => ({
    type: 'object',
    properties: { server_id: { type: 'string', minLength: 1, description: label } },
    required: ['server_id'],
  });
  return [
    pluginCommandDefinition(
      'plugin.catalog',
      '检索插件目录（只读快照）：MCP 工具型插件候选/已装态（含指定安装）、出厂界面组件（factory/protected/disabled/active）、常驻必带集。返回 JSON。',
      { type: 'object', properties: {}, required: [] },
      ['plugin:read:*'],
      'allow',
    ),
    pluginCommandDefinition(
      'plugin.mcp.enable',
      '启用 MCP 工具型插件（内置候选或已安装额外连接）：连接 + 工具导入注册 + 索引刷新；已启用已连接幂等短路。server_id 必填。管理动作 review 档。',
      idParam(),
      ['plugin:mcp:enable'],
      'review',
    ),
    pluginCommandDefinition(
      'plugin.mcp.disable',
      '停用 MCP 工具型插件：注销声明式定义 + 索引摘除 + 断开会话 + 台账摘除（只摘本 server 归属）。server_id 必填。管理动作 review 档。',
      idParam(),
      ['plugin:mcp:disable'],
      'review',
    ),
    pluginCommandDefinition(
      'plugin.mcp.install',
      '指定安装外部 MCP 服务端（登记额外连接台账并立即装载启用）：server_id 新 id（不与内置候选冲突）、transport=stdio|http；stdio 需 command（args 可选）、http 需 url。管理动作 review 档。',
      {
        type: 'object',
        properties: {
          server_id: { type: 'string', minLength: 1 },
          transport: { type: 'string', enum: ['stdio', 'http'] },
          url: { type: 'string' },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          name: { type: 'string' },
        },
        required: ['server_id', 'transport'],
      },
      ['plugin:mcp:install'],
      'review',
    ),
    pluginCommandDefinition(
      'plugin.mcp.remove',
      '移除指定安装的外部 MCP 服务端：停用（注销/断连/台账摘除）并删除额外连接配置。server_id 必填；内置候选用 disable 不用 remove。管理动作 review 档。',
      idParam(),
      ['plugin:mcp:remove'],
      'review',
    ),
    pluginCommandDefinition(
      'plugin.components.set',
      '整集替换出厂界面组件停用集；禁停集（agent_input/review_card/settings_floater/message_list）不可停（整批拒绝），空数组 = 全部恢复。disabled 必填数组。管理动作 review 档。',
      {
        type: 'object',
        properties: {
          disabled: { type: 'array', items: { type: 'string' }, description: '停用组件名清单' },
        },
        required: ['disabled'],
      },
      ['plugin:components:set'],
      'review',
    ),
    pluginCommandDefinition(
      'plugin.baseline.set',
      '整集替换常驻必带工具集（机制检索工具恒在不可摘除；未注册名白名单拒绝）。tools 必填数组。管理动作 review 档。',
      {
        type: 'object',
        properties: {
          tools: { type: 'array', items: { type: 'string' }, description: '常驻工具名清单' },
        },
        required: ['tools'],
      },
      ['plugin:baseline:set'],
      'review',
    ),
  ];
}

/** 族执行体：catalog 走快照面，其余按工具名分发到既有 bridge 命令。 */
export function pluginCommandExecutor(
  call: PluginCommandCall,
  snapshot: PluginCommandSnapshot,
): DeclarativeExecutor {
  return async (_ctx, definition, args): Promise<string> => {
    if (definition.name === 'plugin.catalog') {
      return JSON.stringify(await snapshot());
    }
    const method = PLUGIN_COMMAND_TOOLS[definition.name];
    if (method === undefined) {
      throw new Error(`plugin_command 工具族未知工具: ${definition.name}`);
    }
    const params = isRecord(args) ? args : {};
    const output = await call(method, params);
    return JSON.stringify(output);
  };
}

/** plugin_command 工具族装配产物（boot/createHost 登记一次）。 */
export interface PluginCommandTools {
  register(declarative: DeclarativeToolExecutors): void;
}

/** 构建工具族接线（call = bridge 调用闭包；snapshot = 目录只读快照面）。 */
export function buildPluginCommandTools(
  call: PluginCommandCall,
  snapshot: PluginCommandSnapshot,
): PluginCommandTools {
  ensurePluginCommandEndpointRegistered();
  const executor = pluginCommandExecutor(call, snapshot);
  const definitions = pluginCommandDefinitions();
  return {
    register(declarative: DeclarativeToolExecutors): void {
      if (!declarative.has(PLUGIN_COMMAND_ENDPOINT)) {
        declarative.register(PLUGIN_COMMAND_ENDPOINT, executor);
      }
      for (const definition of definitions) {
        declarative.register_definition(definition);
      }
    },
  };
}
