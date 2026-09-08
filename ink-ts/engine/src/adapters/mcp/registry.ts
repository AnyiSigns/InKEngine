/**
 * 内置 MCP server 注册表（plugins 源 mcp 工具声明的 server_id 定义）——
 * 镜像 Python mcp_client.py 的 BUILTIN_MCP_SERVERS/builtin_mcp_server_config。
 *
 * plugins 中 endpoint=mcp 工具的 server_id 归并后仅两个：inkling_exec
 * 与 inkling_shell。两个内置 server 都由 ink-ts 产物内的原生 MCP server
 * 二进制承载（`ink_ts_mcp <profile>`：exec = file/process/doc 工具集、
 * shell = exec 工具集 + embed；stdio Content-Length 分帧，INK_MCP_ROOT
 * 沙箱 fail-closed）——本表 = TS 侧权威定义（server_id → 传输形态/来源/
 * 签名）；环境相关连接位（stdio 命令路径、profile 参数等）由宿主装配期经
 * builtin_mcp_server_config 填充（hosts/lib/src/mcp/assembly.ts 定位二进制后
 * 以 command/args 覆盖注入）。
 *
 * overrides 只允许覆盖环境相关连接参数；传输形态/来源/签名以注册表为准
 * （宿主不得改写——防改头换面挂载）。未知 server_id 返回 null（fail-closed：
 * 未定义即不可连接）。
 */
import { GraphDefinitionError } from '../../core/errors.js';
import { ToolSource } from '../../kernel/tool_vetting/tool_vetting.js';
import { CONTENT_LENGTH_FRAMING } from './_framing.js';
import type { ServerFactory } from './_types.js';
import { McpServerConfig, McpTransport, StdioRestartPolicy } from './config.js';

/** 内置 server 注册表（server_id → 定义；权威字段不可被宿主覆盖）。 */
export const BUILTIN_MCP_SERVERS: Readonly<Record<string, McpServerConfig>> = {
  inkling_exec: new McpServerConfig({
    id: 'inkling_exec',
    transport: McpTransport.STDIO,
    source: ToolSource.GITHUB,
    signature: 'builtin:inkling_exec',
    // 由 ink_ts_mcp exec profile 承载（装配期注入 command/args）。
    stdio_framing: CONTENT_LENGTH_FRAMING,
  }),
  inkling_shell: new McpServerConfig({
    id: 'inkling_shell',
    transport: McpTransport.STDIO,
    source: ToolSource.GITHUB,
    signature: 'builtin:inkling_shell',
    // 由 ink_ts_mcp shell profile 承载（exec 工具集 + embed）。
    stdio_framing: CONTENT_LENGTH_FRAMING,
  }),
};

/** 内置 server 的权威字段（不可被 overrides 改写）。 */
const _LOCKED_FIELDS = ['id', 'transport', 'source', 'signature'] as const;

/** 环境相关连接参数（overrides 允许覆盖的键）。 */
const _CONNECTION_FIELDS = [
  'url',
  'headers',
  'command',
  'args',
  'env',
  'server_factory',
  'restart_policy',
  'stdio_framing',
] as const;

type ConnectionOverrides = Record<string, unknown>;

/** 内置 server 定义（注册表权威 + 宿主填充连接位）；未知 server_id = null。 */
export function builtin_mcp_server_config(
  server_id: string,
  overrides: ConnectionOverrides = {},
): McpServerConfig | null {
  const base = BUILTIN_MCP_SERVERS[server_id];
  if (base === undefined) return null;
  for (const key of _LOCKED_FIELDS) {
    if (overrides[key] !== undefined) {
      throw new GraphDefinitionError(`内置 server 注册表字段不可覆盖: ${server_id}`);
    }
  }
  const unknown = Object.keys(overrides).filter(
    (key) => !(_CONNECTION_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new GraphDefinitionError(
      `内置 server 连接参数未知字段: ${unknown.sort().join(', ')}`,
    );
  }
  return new McpServerConfig({
    id: base.id,
    transport: base.transport,
    url: (overrides['url'] as string | null | undefined) ?? base.url,
    headers: (overrides['headers'] as Record<string, string> | null | undefined) ?? base.headers,
    command: (overrides['command'] as string | null | undefined) ?? base.command,
    args: ((overrides['args'] as readonly string[] | undefined) ?? base.args) as readonly string[],
    env: (overrides['env'] as Record<string, string> | null | undefined) ?? base.env,
    source: base.source,
    signature: base.signature,
    server_factory: (overrides['server_factory'] as ServerFactory | null | undefined) ?? base.server_factory,
    restart_policy:
      (overrides['restart_policy'] as StdioRestartPolicy | null | undefined) ??
      base.restart_policy,
    stdio_framing:
      (overrides['stdio_framing'] as string | undefined) ?? base.stdio_framing,
  });
}
