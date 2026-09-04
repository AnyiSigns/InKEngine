/**
 * MCP 工具转换纯函数（无协议/IO 依赖，可独立测试）——镜像 Python
 * mcp_client.py 的 convert_mcp_tool/build_mcp_manifest/probe 参数派生。
 *
 * - convert_mcp_tool：MCP 工具 → 声明式定义。字段映射 name/description/
 *   input_schema → 同名；端点固定 MCP，路由密钥 server_id 写入
 *   endpoint_config（定义期必填校验）；权限统一为 ``mcp:call:<server_id>``
 *   （按 server 粒度管控，约定优于配置）；
 * - build_mcp_manifest：vetting 清单（身份声明，供可信度闸门审查）——签名
 *   取挂载提供的显式签名，缺省退化为 server 身份派生值；
 * - probe 参数派生只取带默认值的可选参数（观察探针绝不臆造必填字段，
 *   宁可在远端诚实失败也不产生不可控副作用）。
 */
import { GraphDefinitionError } from '../../core/errors.js';
import {
  DeclarativeToolSpec,
} from '../../core/declarative_tools/declarative_spec.js';
import { EndpointType } from '../../core/declarative_tools/endpoint_types.js';
import {
  ToolManifest,
  ToolSource,
} from '../../core/tool_vetting/tool_vetting.js';
import type { ToolSourceValue } from '../../core/tool_vetting/_types.js';
import type { McpToolRecord } from './_types.js';

/**
 * MCP 工具输入 schema → 引擎参数 JSON Schema（最小规范化：保证
 * type=object、properties 为 dict，不重写语义；非法形态兜底空对象）。
 */
export function normalize_input_schema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  const normalized = schema as Record<string, unknown>;
  const type = normalized['type'];
  if (type !== 'object' && type !== null && type !== undefined) {
    normalized['type'] = 'object';
  }
  if (typeof normalized['properties'] !== 'object' || normalized['properties'] === null) {
    normalized['properties'] = {};
  }
  return normalized;
}

/** 从工具条目读取名称（dict/对象两形态；空 = null）。 */
function _tool_name(tool: McpToolRecord): unknown {
  return tool['name'];
}

/** 从工具条目读取描述（缺省空串）。 */
function _tool_description(tool: McpToolRecord): string {
  const description = tool['description'];
  return typeof description === 'string' ? description : '';
}

/**
 * 读取参数 schema：SDK 2.x 字段形态是 input_schema（1.x 的 inputSchema
 * 仅作遗留序列化数据回退）——两形态等价读取，同载时以 2.x 为准。
 */
function _tool_schema(tool: McpToolRecord): unknown {
  const snake = tool['input_schema'];
  if (snake !== null && snake !== undefined) return snake;
  return tool['inputSchema'];
}

/** MCP 工具 → 声明式工具定义（纯函数；缺 name = 协议违规拒绝）。 */
export function convert_mcp_tool(
  server_id: string,
  tool: McpToolRecord | Record<string, unknown>,
): DeclarativeToolSpec {
  const record = tool as McpToolRecord;
  const name = _tool_name(record);
  if (typeof name !== 'string' || name === '') {
    throw new GraphDefinitionError('MCP 工具缺 name（协议违规）');
  }
  return new DeclarativeToolSpec({
    name,
    description: _tool_description(record),
    parameters: normalize_input_schema(_tool_schema(record)),
    permissions: [`mcp:call:${server_id}`],
    endpoint: EndpointType.MCP,
    endpoint_config: { server_id },
    meta: { mcp_server: server_id },
  });
}

/** 为导入的 MCP 工具生成 vetting 清单（身份声明，供可信度闸门审查）。 */
export function build_mcp_manifest(
  server_id: string,
  tool: McpToolRecord | Record<string, unknown>,
  opts: { source: string; signature?: string | null },
): ToolManifest {
  const record = tool as McpToolRecord;
  const rawName = _tool_name(record);
  const name =
    typeof rawName === 'string' && rawName !== '' ? rawName : `${server_id}:tool`;
  const signature =
    opts.signature !== null && opts.signature !== undefined && opts.signature !== ''
      ? opts.signature
      : `mcp:${server_id}:${name}`;
  const source = ToolSource.is_valid(opts.source)
    ? (opts.source as ToolSourceValue)
    : ToolSource.UNKNOWN;
  return new ToolManifest({
    name,
    source,
    signature,
    permissions: [`mcp:call:${server_id}`],
    meta: { mcp_server: server_id },
  });
}

/** 观察探针的调用参数派生（只取带默认值的可选参数，不猜必填字段）。 */
export function probe_args_from_schema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return {};
  }
  const props = (schema as Record<string, unknown>)['properties'];
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(props as Record<string, unknown>)) {
    if (typeof prop === 'object' && prop !== null && !Array.isArray(prop)) {
      const record = prop as Record<string, unknown>;
      if ('default' in record) out[name] = record['default'];
    }
  }
  return out;
}
