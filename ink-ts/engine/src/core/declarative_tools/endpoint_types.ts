/**
 * 声明式工具的端点类型域（declarative_tools.py 端点语义移植的数据面）。
 *
 * 端点类型只是分发/守卫的接线依据，不限定实现：http_fetch 默认执行体
 * 由网络执行体文件提供（宿主 seam），宿主可注册自定义执行体覆盖。
 *
 * 白名单审计：端点类型 = **声明式注册表 + 引擎默认内置**——本文件承载
 * 内置 7 种端点的枚举名（EndpointType）、单条注册表条目
 * （EndpointTypeSpec：判定动作域/配置必填键/契约输出形态/判定目标提取
 * 与失败原因钩子/沙箱守卫接线）与注册表（EndpointTypeRegistry：重复
 * 登记显式拒绝，防静默覆盖引擎安全语义）。注册 = 装配期代码动作，
 * 非 agent 可写数据。
 *
 * 字符串归一说明：Python 端以 StrEnum 值成员承载内置端点，构造期把
 * 字符串形态归一为枚举（后续 is 比较恒真）。TS 端以常量字符串承载——
 * 值比较即恒等比较，JSON 反序列化的 "file_ops" 与 EndpointType.FILE_OPS
 * 恒等，归一语义天然成立；非内置字符串 = 自定义端点（经注册表校验）。
 *
 * 数据面单源：端点名集合的唯一真源 = contracts generated
 * BUILTIN_ENDPOINT_NAMES（schema/fixture）；本对象为引擎本地名常量
 * （代码各处以枚举成员引用），取值经编译期集合相等绑定 + 运行时
 * assert_endpoint_contract 双向校验，不维护第二套字面量。
 */
import { BUILTIN_ENDPOINT_NAMES, BUILTIN_ENDPOINTS, type BuiltinEndpointName } from '@ink-ts/contracts';
import { GraphDefinitionError } from '../errors.js';
import type { SchemaField } from '../schema/schemaValidator.js';
import type { SandboxSeam } from '../tool_pipeline/_types.js';
import type { DeclarativeToolSpec } from './declarative_spec.js';

/** 内置端点枚举名（常量字符串；与 Python StrEnum 值同源）。 */
export const EndpointType = {
  /** 网络抓取/调用（NetworkPolicy 网络守卫：白名单直过，白名单外按
   *  unlisted_policy 转审批或硬拒）。 */
  HTTP_FETCH: 'http_fetch',
  /** 受限子进程执行（ProcessSandbox 命令白名单守卫）。 */
  PROCESS_EXEC: 'process_exec',
  /** 文件读写删除检索（FileSandbox 根目录守卫）。 */
  FILE_OPS: 'file_ops',
  /** 外部 MCP server 工具调用（按 server_id 路由会话）。 */
  MCP: 'mcp',
  /** 联网搜索（本地聚合源/厂商降级；独立 search 动作域）。 */
  WEB_SEARCH: 'web_search',
  /** 协作者召唤（宿主执行体物化 spawn 子图；独立 collab 动作域）。 */
  COLLAB_REQUEST: 'collab_request',
  /** 待办清单管理（operation 区分动作；独立 manage 动作域）。 */
  TASK_MANAGER: 'task_manager',
} as const;

/** 内置端点值联合类型。 */
export type EndpointTypeValue = (typeof EndpointType)[keyof typeof EndpointType];

// 编译期绑定：EndpointType 值集合必须与 generated BUILTIN_ENDPOINT_NAMES
// 双向精确相等（两端任一方向新增/删除/改名 → 类型错误）。键名（大写
// 常量名）无法用 satisfies 直接覆盖小写值联合，故用集合相等条件类型校验；
// 运行时一致性由 assert_endpoint_contract 兜底（测试调用）。
type _StringSetEqual<A extends string, B extends string> = Exclude<A, B> extends never
  ? Exclude<B, A> extends never
    ? true
    : false
  : false;
const _endpointNamesCoverContract: true = true as _StringSetEqual<
  BuiltinEndpointName,
  EndpointTypeValue
>;

/**
 * 运行时断言：EndpointType 值集合 ↔ contracts BUILTIN_ENDPOINT_NAMES 一致
 * （防绕过类型层的运行时漂移，由引擎测试调用）。
 */
export function assert_endpoint_contract(): void {
  const engineValues = Object.values(EndpointType);
  const builtinNames = BUILTIN_ENDPOINT_NAMES as readonly string[];
  if (
    engineValues.length !== builtinNames.length
    || !engineValues.every((value) => builtinNames.includes(value))
  ) {
    throw new GraphDefinitionError(
      '端点类型枚举与 contracts BUILTIN_ENDPOINT_NAMES 不一致: '
        + `engine=[${engineValues.join(', ')}] vs contracts=[${builtinNames.join(', ')}]`,
    );
  }
}

/** 全部内置端点值（注册表内置登记与测试断言共用）。 */
export const ENDPOINT_TYPE_VALUES: readonly string[] = Object.values(EndpointType);

// file_ops 动作域（数据面来源 = contracts BUILTIN_ENDPOINTS 条目，本地无
// 第二套字面量；registry 数据驱动后仍供 _hooks 判定与错误文案引用）
// search = 工作区文本内容检索（grep）/ search_paths = 工作区路径检索
// （glob）——同属只读文件操作域；edit = 就地改写，一等操作域（权限
// 动作 filesystem:edit、沙箱守卫与审计可独立区分）
const _actions_by_name: ReadonlyMap<string, readonly string[]> = new Map(
  BUILTIN_ENDPOINTS.map((entry) => [entry.name, entry.actions]),
);
export const _FILE_OPS_ACTIONS: readonly string[] = _actions_by_name.get(EndpointType.FILE_OPS) ?? [];

/** 判定目标提取钩子：(args, config) -> (operation, target) | null。 */
export type EndpointExtractor = (
  args: Record<string, unknown>,
  config: Record<string, unknown> | null,
) => [string, string] | null;

/** 判定失败原因钩子：(args, config) -> 原因文案 | null（指引模型纠正）。 */
export type EndpointFailureReason = (
  args: Record<string, unknown>,
  config: Record<string, unknown> | null,
) => string | null;

export interface EndpointTypeSpecInit {
  name: string;
  actions?: readonly string[];
  config_requirements?: readonly string[];
  output_fields?: readonly SchemaField[];
  extractor?: EndpointExtractor | null;
  failure_reason?: EndpointFailureReason | null;
  sandbox_ops?: readonly string[];
  sandbox_builder?: ((definition: DeclarativeToolSpec) => SandboxSeam) | null;
}

/**
 * 端点类型注册表条目：分发/守卫/契约语义的数据化封装（宿主扩展位）。
 *
 * 与 rules.RuleTypeRegistry 同哲学：内置端点 = 引擎默认（机制语义），
 * 宿主可经 EndpointTypeRegistry.register 增补自定义端点——每个端点必须
 * 连带声明它的判定动作域、配置必填键、契约输出形态、判定目标提取/
 * 失败原因钩子、沙箱守卫接线。全部字段构成该端点的**完整接线语义**：
 * 自定义端点与内置端点同等走全流水线（门禁 → 沙箱 → 守卫 → 审批 →
 * 审计），不存在「跳过流水线环节」的开关。
 */
export class EndpointTypeSpec {
  /** 端点类型名（注册键，工具声明 endpoint 字段引用）。 */
  readonly name: string;
  /** 判定动作域（operation 集合；file_ops 定义期校验 operation 枚举
   *  不得超出此域）。 */
  readonly actions: readonly string[];
  /** 定义期必填配置键（缺失即拒绝，fail-closed）。 */
  readonly config_requirements: readonly string[];
  /** 契约输出形态（tool_contract_from_declaration 取数）。 */
  readonly output_fields: readonly SchemaField[];
  /** 判定目标提取钩子——null = 无法判定目标（fail-closed）。 */
  readonly extractor: EndpointExtractor | null;
  /** 判定失败原因钩子。 */
  readonly failure_reason: EndpointFailureReason | null;
  /** 需沙箱守卫的操作集合（空 = 无本地沙箱，门禁+审批为边界）。 */
  readonly sandbox_ops: readonly string[];
  /** 守卫构造器（按定义强制声明的配置键构造守卫）。sandbox_ops 非空而
   *  构造器缺失 = 注册即拒绝（一致性校验，fail-closed）。 */
  readonly sandbox_builder: ((definition: DeclarativeToolSpec) => SandboxSeam) | null;

  constructor(init: EndpointTypeSpecInit) {
    this.name = init.name;
    this.actions = init.actions ?? [];
    this.config_requirements = init.config_requirements ?? [];
    this.output_fields = init.output_fields ?? [];
    this.extractor = init.extractor ?? null;
    this.failure_reason = init.failure_reason ?? null;
    this.sandbox_ops = init.sandbox_ops ?? [];
    this.sandbox_builder = init.sandbox_builder ?? null;
    if (!this.name) {
      throw new GraphDefinitionError('端点类型名不能为空');
    }
    if (this.sandbox_ops.length > 0 && this.sandbox_builder === null) {
      throw new GraphDefinitionError(
        `端点类型 ${this.name} 声明了沙箱守卫域 ${this.sandbox_ops.join(', ')} ` +
          '但未提供守卫构造器（sandbox_builder）',
      );
    }
  }
}

/**
 * 端点类型注册表：内置默认 + 宿主注册扩展位（谓词注册表同哲学）。
 *
 * 引擎内置 7 种端点类型在模块加载时登记（机制语义，见 endpoint_registry）；
 * 宿主自定义端点经 register 增补。重复注册（含覆盖内置）= 编程错误，
 * 显式拒绝——防静默覆盖引擎安全语义。注册是**装配期代码动作**，不是
 * agent 可写数据：agent 只能引用已注册端点创建工具，不能注册端点。
 *
 * _specs 按 Python 惯例开放（下划线前缀 = 内部），测试清理自定义端点用；
 * 外部只读经 get/has/names。
 */
export class EndpointTypeRegistry {
  readonly _specs: Map<string, EndpointTypeSpec> = new Map();

  /** 登记端点类型（重复登记抛错，防静默覆盖语义）。 */
  register(spec: EndpointTypeSpec): void {
    if (this._specs.has(spec.name)) {
      throw new GraphDefinitionError(`端点类型重复注册: ${spec.name}`);
    }
    this._specs.set(spec.name, spec);
  }

  /** 按名取条目（未登记 = undefined）。 */
  get(name: string): EndpointTypeSpec | undefined {
    return this._specs.get(String(name));
  }

  /** 是否已登记。 */
  has(name: string): boolean {
    return this._specs.has(String(name));
  }

  /** 已登记端点名清单。 */
  get names(): string[] {
    return [...this._specs.keys()];
  }
}
