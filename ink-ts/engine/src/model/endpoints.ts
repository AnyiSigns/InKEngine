// P6 归位（引擎重排计划 §6 P6 动作 F）：内置端点枚举常量自
// loop/tools/declarative_tools/endpoint_types.ts 下移 model；endpoint_types.ts
// 经 re-export 保链（declarative_tools/index.ts 汇总与 dock 快照不变）。
import type { BuiltinEndpointName } from './contracts/generated/index.js';

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
