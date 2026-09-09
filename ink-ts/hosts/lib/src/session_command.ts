/**
 * host session_command 工具族执行接线（P4-B-2 遗留「agent 工具包面」落地面）。
 *
 * 宿主 agent 工具的声明真源 = plugins/tools/<id>/spec.json（kind='tool'，
 * endpoint='session_command'）；本模块 = hosts/lib 侧的执行接线，复用既有
 * 宿主工具通道（web_search 同款：harness_registry.declarative 登记声明式
 * 定义 + 按端点登记执行体）——工具调用按定义名分发到既有 bridge 命令实现
 * （skeleton.inspect→skeleton.get / skeleton.update→skeleton.edit /
 * rounds.trial→rounds.fork_trial），不复制机制语义、不新造第二通道。
 *
 * 端点注册：session_command 为宿主注册的引擎自定义端点（EndpointTypeRegistry
 * 增补位，装配期幂等登记）——提取器按 thread_id 出判定目标，过既有统一
 * 流水线（门禁/审批/审计）后执行体按工具名转 bridge handler。
 */

import {
  DeclarativeToolSpec,
  EndpointTypeSpec,
  endpoint_registry,
  type DeclarativeExecutor,
  type DeclarativeToolSpecInit,
} from '@ink-ts/engine';
import type { DeclarativeToolExecutors } from '@ink-ts/engine';

/** session_command 端点族名（plugin 工具行 endpoint 引用 + 本族注册键）。 */
export const SESSION_COMMAND_ENDPOINT = 'session_command';

/** 工具名 → 既有 bridge 命令实现（执行接线单一映射表；新增工具在此登记）。 */
export const SESSION_COMMAND_TOOLS: Readonly<Record<string, string>> = {
  'skeleton.inspect': 'skeleton.get',
  'skeleton.update': 'skeleton.edit',
  'rounds.trial': 'rounds.fork_trial',
} as const;

/** bridge 调用面（createHost 注入：params 透传 + host 审批上下文）。 */
export interface SessionCommandCall {
  (method: string, params: Record<string, unknown>): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** session_command 端点类型规格（自定义端点，与内置端点同走完整流水线；
 *  提取器把 thread_id 归一为判定目标——门禁/审批以会话为目标对象）。 */
export function sessionCommandEndpointSpec(): EndpointTypeSpec {
  return new EndpointTypeSpec({
    name: SESSION_COMMAND_ENDPOINT,
    actions: ['session_command'],
    config_requirements: [],
    output_fields: [],
    extractor: (args, config) => {
      const threadId = isRecord(args) ? args['thread_id'] : undefined;
      if (typeof threadId !== 'string' || threadId === '') return null;
      return ['session_command', `session:${threadId}`];
    },
    failure_reason: (args) =>
      args !== null && args !== undefined && typeof args === 'object' && !Array.isArray(args)
        ? (Object.prototype.hasOwnProperty.call(args, 'thread_id')
          ? 'thread_id 须为非空字符串（会话骨架操作目标线程）'
          : 'session_command 工具须带 thread_id（目标会话线程）')
        : 'session_command 工具参数须为对象',
    sandbox_ops: [],
  });
}

/** 幂等登记 session_command 自定义端点（引擎 EndpointTypeRegistry 增补位；
 *  宿主装配期执行，重复登记静默跳过——注册表重复登记显式拒绝，故先判有）。 */
export function ensureSessionCommandEndpointRegistered(): void {
  if (!endpoint_registry.has(SESSION_COMMAND_ENDPOINT)) {
    endpoint_registry.register(sessionCommandEndpointSpec());
  }
}

/** 声明式定义公共字段（name/desc/参数/权限来自 plugin 工具声明行逐字对齐）。 */
const DEFINITION_COMMON: Omit<DeclarativeToolSpecInit, 'name' | 'description'> = {
  parameters: {},
  permissions: [],
  endpoint: SESSION_COMMAND_ENDPOINT,
  endpoint_config: {},
  meta: { domain: 'session', executor: 'host:session_command' },
};

function sessionCommandDefinition(
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

/** 三个 agent 工具的运行时声明式定义（与 plugins/tools spec 声明对齐）。 */
export function sessionCommandDefinitions(): DeclarativeToolSpec[] {
  ensureSessionCommandEndpointRegistered();
  return [
    sessionCommandDefinition(
      'skeleton.inspect',
      '读取目标会话当前骨架（checkpoint _thread_skeleton 投影）+ 当前池校验态；只读。thread_id = 目标会话线程。',
      {
        type: 'object',
        properties: { thread_id: { type: 'string' } },
        required: ['thread_id'],
      },
      ['session:read:*'],
      'allow',
    ),
    sessionCommandDefinition(
      'skeleton.update',
      '声明式修改目标会话骨架（actions 增量或 sketch 整份替换，dry=预览）；经 validate→mount 唯一写口，下一轮生效。thread_id = 目标会话线程。',
      {
        type: 'object',
        properties: {
          thread_id: { type: 'string' },
          actions: { type: 'array', items: { type: 'object' } },
          sketch: { type: 'object' },
          dry: { type: 'boolean' },
        },
        required: ['thread_id'],
      },
      ['session:update:*'],
      'review',
    ),
    sessionCommandDefinition(
      'rounds.trial',
      '以源会话骨架为蓝图 fork 新线程试跑 1 轮返回结果摘要（主线不动）。thread_id = 源会话；input/trial_thread_id 可选。',
      {
        type: 'object',
        properties: {
          thread_id: { type: 'string' },
          input: { type: 'string' },
          trial_thread_id: { type: 'string' },
        },
        required: ['thread_id'],
      },
      ['session:trial:*'],
      'allow',
    ),
  ];
}

/** 族执行体：按工具名分发到既有 bridge 命令实现（结果 JSON 回模型）。 */
export function sessionCommandExecutor(call: SessionCommandCall): DeclarativeExecutor {
  return async (
    _ctx: unknown,
    definition,
    args,
    _approval,
  ): Promise<string> => {
    const method = SESSION_COMMAND_TOOLS[definition.name];
    if (method === undefined) {
      throw new Error(`session_command 工具族未知工具: ${definition.name}`);
    }
    const params = isRecord(args) ? args : {};
    const output = await call(method, params);
    return JSON.stringify(output);
  };
}

/** session_command 工具族装配产物（boot/createHost 登记一次）。 */
export interface SessionCommandTools {
  register(declarative: DeclarativeToolExecutors): void;
}

/** 构建工具族接线（call = createHost 注入的 bridge 调用闭包）。 */
export function buildSessionCommandTools(call: SessionCommandCall): SessionCommandTools {
  ensureSessionCommandEndpointRegistered();
  const executor = sessionCommandExecutor(call);
  const definitions = sessionCommandDefinitions();
  return {
    register(declarative: DeclarativeToolExecutors): void {
      if (!declarative.has(SESSION_COMMAND_ENDPOINT)) {
        declarative.register(SESSION_COMMAND_ENDPOINT, executor);
      }
      for (const definition of definitions) {
        declarative.register_definition(definition);
      }
    },
  };
}
