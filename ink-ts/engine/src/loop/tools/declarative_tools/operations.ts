/**
 * 声明式工具的判定目标推导接线（declarative_tools.py :676-758 移植）。
 *
 * endpoint_operation / endpoint_operation_failure_reason：按端点类型从
 * 调用参数推导 (operation, target) 判定目标——语义经端点类型注册表
 * （endpoint_registry）分发：内置端点取注册表条目声明的提取/失败原因
 * 钩子，自定义端点取其注册时声明的钩子；端点未注册 = 无法判定目标
 * （None，由流水线 fail-closed 拒绝）。供 ToolPipeline 的 extractor
 * 接线：判定目标与执行参数一致，防二次拼接逃逸。
 *
 * RETRIEVAL_CONTROLLED_FETCH + controlled_fetch_call / declarative_operation
 * / declarative_failure_reason：collect_material url 档受控取回的单工具
 * 内拆语义——声明 meta.retrieval=controlled_fetch 的工具在入参含 url 时
 * 判定目标挂网络语义（connect/域名，走网络审批网关），file/text 档回落
 * 声明端点原路径；分发按声明标记查受控执行体注册键。端点注册表零新增。
 */
import { endpoint_registry } from './endpoint_registry.js';
import { DeclarativeToolSpec } from './declarative_spec.js';
import {
  _extract_http_fetch,
  _reason_http_fetch,
} from './_hooks.js';

/** 声明式工具的单工具内拆语义（url 档走受控取回）的分发注册键。 */
export const RETRIEVAL_CONTROLLED_FETCH = 'controlled_fetch';

/**
 * 按端点类型从调用参数推导 (operation, target) 判定目标。
 *
 * @param endpoint 端点类型（内置端点值或自定义注册表名）。
 * @param args 调用参数。
 * @param options.config 端点配置（operation_param/root 等推导上下文）。
 * @returns (operation, target) 或 None（无法判定目标 = fail-closed）。
 */
export function endpoint_operation(
  endpoint: string,
  args: Record<string, unknown>,
  options: { config?: Record<string, unknown> | null } = {},
): [string, string] | null {
  const spec = endpoint_registry.get(String(endpoint));
  if (spec === undefined || spec.extractor === null) return null;
  return spec.extractor(args, options.config ?? null);
}

/**
 * 判定目标推导失败的结构化原因（供流水线 fail-closed 文案指引模型）。
 *
 * 与 endpoint_operation 同源分发：推导成功或端点未注册返回 None；推导
 * 失败返回具体缺参/非法原因（如 file_ops 缺 operation 时列出合法值）。
 */
export function endpoint_operation_failure_reason(
  endpoint: string,
  args: Record<string, unknown>,
  options: { config?: Record<string, unknown> | null } = {},
): string | null {
  const spec = endpoint_registry.get(String(endpoint));
  if (spec === undefined || spec.failure_reason === null) return null;
  return spec.failure_reason(args, options.config ?? null);
}

/**
 * 受控取回 url 档判定：声明 retrieval 标记且本次调用携带 url 参数。
 *
 * 与端点类型正交：声明了 meta.retrieval == "controlled_fetch" 的工具
 * （单声明内拆语义）在入参含 url 时判定目标挂网络语义（connect/域名，
 * 走网络审批网关），file/text 档回落声明端点原路径。
 */
export function controlled_fetch_call(
  definition: DeclarativeToolSpec | null,
  args: Record<string, unknown>,
): boolean {
  return Boolean(
    definition !== null &&
      definition.meta['retrieval'] === RETRIEVAL_CONTROLLED_FETCH &&
      typeof args['url'] === 'string' &&
      Boolean(args['url']),
  );
}

/** 声明式工具判定目标推导（extractor 接线共用入口）。
 *
 * 受控取回 url 档 → 网络语义（connect，http_fetch 同源推导：仅
 * http/https 且须含主机名）；否则按声明端点类型推导。
 */
export function declarative_operation(
  definition: DeclarativeToolSpec,
  args: Record<string, unknown>,
): [string, string] | null {
  if (controlled_fetch_call(definition, args)) {
    return _extract_http_fetch(args, null);
  }
  return endpoint_operation(definition.endpoint, args, {
    config: definition.endpoint_config,
  });
}

/** 声明式工具判定失败的结构化原因（failure_reason 接线共用入口）。
 *
 * 与 declarative_operation 同源分发：受控取回 url 档的失败原因挂
 * http_fetch 语义（协议/主机非法等，指引模型纠正）。
 */
export function declarative_failure_reason(
  definition: DeclarativeToolSpec,
  args: Record<string, unknown>,
): string | null {
  if (controlled_fetch_call(definition, args)) {
    return _reason_http_fetch(args, null);
  }
  return endpoint_operation_failure_reason(definition.endpoint, args, {
    config: definition.endpoint_config,
  });
}
