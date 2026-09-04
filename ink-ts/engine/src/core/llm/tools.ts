/**
 * 工具 schema 自写转换（ToolSpec → OpenAI 兼容 tools JSON）。
 *
 * ToolSpec 携带 name/description/parameters（parameters 为 JSON Schema dict；
 * pydantic BaseModel 类转换属宿主/适配器侧能力——Python 端可选依赖，TS 端
 * 严格零第三方，由宿主把 pydantic 形态预先 model_dump 为 dict 后再注入，
 * 与「数据 = JSON 兼容值」的核心纪律一致）。
 *
 * 业务工具元数据（门控分级/敏感性等）不属引擎，由宿主注册表维护；permissions
 * 为引擎侧声明式权限（core.permissions 判定输入，形态 domain:action:pattern，
 * 缺省空 = 由宿主默认策略判定）。
 */

import { LLMConfigError } from './errors.js';

const EMPTY_PARAMETERS: Record<string, unknown> = { type: 'object', properties: {} };

/** 引擎侧工具描述（宿主工具注册表 → 引擎 → OpenAI tools JSON）。 */
export class ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly permissions: readonly string[];

  constructor(init: {
    name: string;
    description?: string;
    parameters?: unknown;
    permissions?: readonly string[];
  }) {
    this.name = init.name;
    this.description = init.description ?? '';
    this.parameters = init.parameters;
    this.permissions = init.permissions ?? [];
  }

  /** 序列化为数据形态（工具 = 数据：可入 checkpoint/知识集/仓库）。 */
  to_dict(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      parameters: resolveParameters(this.parameters),
      permissions: [...this.permissions],
    };
  }

  /** 从数据形态还原（未知键忽略，兼容增量演进）。 */
  static from_dict(data: Record<string, unknown>): ToolSpec {
    const permissionsRaw = data['permissions'];
    const permissions = Array.isArray(permissionsRaw)
      ? (permissionsRaw as unknown[]).filter((p): p is string => typeof p === 'string')
      : [];
    return new ToolSpec({
      name: data['name'] as string,
      description: (data['description'] as string | undefined) ?? '',
      parameters: data['parameters'],
      permissions,
    });
  }
}

/**
 * 解析参数 schema：None → 空对象；dict 直通；其他形态抛 LLMConfigError。
 *
 * Python 端的 pydantic 类转换（model_json_schema）在 TS 端不实现——TS core
 * 零第三方，宿主在注册工具时先把 pydantic 形态转 dict 再注入。
 */
function resolveParameters(parameters: unknown): Record<string, unknown> {
  if (parameters === null || parameters === undefined) return EMPTY_PARAMETERS;
  if (typeof parameters === 'object' && !Array.isArray(parameters)) {
    return parameters as Record<string, unknown>;
  }
  throw new LLMConfigError(
    `parameters 需为 JSON Schema dict（pydantic 类转换在 TS 端由宿主侧完成）: ${Array.isArray(parameters) ? 'array' : typeof parameters}`,
  );
}

/** ToolSpec 列表 → OpenAI 兼容 tools 数组（type=function 形态）。 */
export function to_openai_tools(specs: readonly ToolSpec[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const spec of specs) {
    if (!spec.name) throw new LLMConfigError('工具 name 必填');
    out.push({
      type: 'function',
      function: {
        name: spec.name,
        description: spec.description,
        parameters: resolveParameters(spec.parameters),
      },
    });
  }
  return out;
}