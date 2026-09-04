/**
 * 端点判定钩子集：按端点类型的判定目标提取（_extract_*）与失败原因
 * （_reason_*）——endpoint_registry 内置条目与 declarative_operation
 * 共用的纯函数（declarative_tools.py :191-368 移植）。
 *
 * 每个提取器语义 = 判定目标必须可确定：无法判定（缺参/非法）返回 null，
 * 由流水线按「无法判定目标 = 无法做权限/沙箱判定」fail-closed 拒绝；
 * 失败原因钩子给出结构化缺参/非法文案（指引模型自我纠正），与提取器
 * 同源分发，只用于拒绝文案不参与判定。
 *
 * argv 规范化（coerce_argv）：模型常把嵌套数组输出为 JSON 字符串
 * （如 "[\"pip\", \"install\"]"）——判定/执行须统一收口为真正数组，
 * 否则 fail-closed 误拒且执行体拿到字符串会拒绝。
 */
import { _FILE_OPS_ACTIONS } from './endpoint_types.js';
import type { EndpointExtractor, EndpointFailureReason } from './endpoint_types.js';
import { url_split } from './_url.js';

/**
 * argv 参数规范化：数组直通；JSON 字符串数组尝试解析。
 *
 * 模型常把嵌套数组输出为 JSON 字符串——判定/执行须统一收口为真正
 * 数组，否则 fail-closed 误拒（无法判定目标）且执行体（命令面 =
 * argv[0] 白名单）拿到字符串会拒绝。解析失败或非字符串元素 = null
 * （调用方按缺参处理）。
 */
export function coerce_argv(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string') ? (value as string[]) : null;
  }
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed as string[];
    }
  }
  return null;
}

/** 声明参数名解析：config.operation_param 声明的操作目标参数名
 *  （缺省回落 "command"；Python str() 口径：非字符串转字符串）。 */
function _operation_param(config: Record<string, unknown> | null): string {
  if (config !== null && config['operation_param'] !== undefined && config['operation_param'] !== null) {
    return String(config['operation_param']);
  }
  return 'command';
}

// ── 内置端点判定目标提取器（url_split 剥除 userinfo/端口）───────────────

export const _extract_http_fetch: EndpointExtractor = (args, _config) => {
  const url = args['url'];
  if (typeof url !== 'string' || !url) return null;
  const { scheme, hostname } = url_split(url);
  // 协议白名单 + host 形式校验：仅 http/https 可出网，凭据/非标准
  // 协议的 host 提取一律拒绝（无法判定目标 = fail-closed）
  if ((scheme !== 'http' && scheme !== 'https') || hostname === null) return null;
  return ['connect', hostname];
};

export const _extract_process_exec: EndpointExtractor = (args, config) => {
  const command_param = _operation_param(config);
  let command: unknown;
  if (command_param === 'argv') {
    // 命令面 = 参数数组首元素（shell_exec：判定目标 = argv[0] 真实
    // 命令，白名单按命令面校验）；argv 可能被模型字符串化，先规范化
    const argv = coerce_argv(args['argv']);
    command = argv !== null && argv.length > 0 ? argv[0] : null;
  } else {
    command = args[command_param];
  }
  return typeof command === 'string' && command ? ['exec', command] : null;
};

export const _extract_file_ops: EndpointExtractor = (args, config) => {
  let operation = args['operation'];
  if (!_FILE_OPS_ACTIONS.includes(String(operation))) {
    // 调用未传/传非法 operation：回落工具声明的固定操作（单操作工具
    // 如 glob→search_paths——schema 约束 operation 为固定枚举，但模型
    // 调用可能省略该「实现细节」参数；声明值仍属合法操作域则判定目标
    // 成立，不做 fail-closed 误拒）
    const declared = config !== null ? config['operation'] : undefined;
    operation = declared !== undefined && _FILE_OPS_ACTIONS.includes(String(declared)) ? declared : undefined;
    if (operation === undefined) return null;
  }
  let path = args['path'];
  // 检索操作（search/search_paths）无 path 参数 = 全域检索：判定目标
  // 回落端点配置根目录（权限模式与沙箱按根目录校验，检索域 = 整个
  // 工作区根；带 path 时目标 = 该路径，检索域 = 路径内）
  if (
    (operation === 'search' || operation === 'search_paths') &&
    (typeof path !== 'string' || !path) &&
    config !== null
  ) {
    path = config['root'];
  }
  if (typeof path !== 'string' || !path) return null;
  return [String(operation), path];
};

export const _extract_mcp: EndpointExtractor = (args, config) => {
  const server_id = config !== null ? config['server_id'] : undefined;
  return typeof server_id === 'string' && server_id ? ['call', server_id] : null;
};

export const _extract_web_search: EndpointExtractor = (args, _config) => {
  const query = args['query'];
  return typeof query === 'string' && query ? ['search', query] : null;
};

export const _extract_collab_request: EndpointExtractor = (args, _config) => {
  const entity_id = args['entity_id'];
  return typeof entity_id === 'string' && entity_id ? ['request', entity_id] : null;
};

export const _extract_task_manager: EndpointExtractor = (args, _config) => {
  const operation = args['operation'];
  return typeof operation === 'string' && operation ? ['manage', operation] : null;
};

// ── 内置端点判定失败原因钩子（文案指引模型自我纠正）─────────────────────

export const _reason_http_fetch: EndpointFailureReason = (args) => {
  const url = args['url'];
  if (typeof url !== 'string' || !url) return 'url 参数缺失或非法';
  const { scheme, hostname } = url_split(url);
  if ((scheme !== 'http' && scheme !== 'https') || hostname === null) {
    return 'url 协议/主机非法（仅 http/https 且须含主机名）';
  }
  return null;
};

export const _reason_process_exec: EndpointFailureReason = (args, config) => {
  const command_param = _operation_param(config);
  if (command_param === 'argv') {
    const argv = coerce_argv(args['argv']);
    if (!(argv !== null && argv.length > 0 && typeof argv[0] === 'string')) {
      return 'argv 参数缺失或非法（应为字符串数组，如 ["python", "--version"]）';
    }
    return null;
  }
  const command = args[command_param];
  if (typeof command !== 'string' || !command) {
    return `${command_param} 参数缺失或非字符串`;
  }
  return null;
};

export const _reason_file_ops: EndpointFailureReason = (args, config) => {
  let operation = args['operation'];
  if (!_FILE_OPS_ACTIONS.includes(String(operation))) {
    const declared = config !== null ? config['operation'] : undefined;
    if (declared !== undefined && _FILE_OPS_ACTIONS.includes(String(declared))) {
      operation = declared;
    } else {
      return `operation 字段缺失或非法（合法值：${_FILE_OPS_ACTIONS.join('/')}）`;
    }
  }
  const path = args['path'];
  if (typeof path !== 'string' || !path) return 'path 参数缺失或非字符串';
  return null;
};

export const _reason_mcp: EndpointFailureReason = (args, config) => {
  const server_id = config !== null ? config['server_id'] : undefined;
  if (!(typeof server_id === 'string' && server_id)) return 'server_id 未配置（无法路由）';
  return null;
};

export const _reason_web_search: EndpointFailureReason = (args) => {
  const query = args['query'];
  if (typeof query !== 'string' || !query) return 'query 参数缺失';
  return null;
};

export const _reason_collab_request: EndpointFailureReason = (args) => {
  const entity_id = args['entity_id'];
  if (typeof entity_id !== 'string' || !entity_id) {
    return 'entity_id 参数缺失或非法（须为已注册实体 id）';
  }
  return null;
};

export const _reason_task_manager: EndpointFailureReason = (args) => {
  const operation = args['operation'];
  if (typeof operation !== 'string' || !operation) {
    return 'operation 参数缺失或非法（须为 create/update/complete/list/clear/delete 之一）';
  }
  return null;
};
