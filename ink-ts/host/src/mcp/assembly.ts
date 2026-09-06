/**
 * MCP 宿主装配（薄接线：管理器 → 引擎声明式执行器注册 + runtime seam +
 * 内置 server 二进制接线）。
 *
 * 只做三件事：
 * - 构造 McpClientManager 并注入引擎（register_mcp_executor 挂 MCP 端点
 *   分发；runtime.mcp_manager = 管理器——Runtime.stop 经 close_all 收口、
 *   _runtime_contexts 端点探活经 list_servers 判定）；
 * - 按宿主配置逐 server connect_builtin；内置 server（inkling_exec /
 *   inkling_shell）由 ink-ts 产物内的原生 MCP server 二进制承载
 *   （`ink_ts_mcp <profile>`）——装配期经 [`resolveBuiltinOverrides`]
 *   补 command= 定位 ink_ts_mcp + profile 参数 + Content-Length 分帧；
 * - 二进制未定位 / 连接失败一律 fail-closed：只记诊断不击穿 boot，装配
 *   结果状态可查（mcp 工具端点探活随 connected=false 标注）。
 */

import {
  BUILTIN_MCP_SERVERS,
  McpClientManager,
  register_mcp_executor,
} from '@ink-ts/engine';
import type { Runtime } from '@ink-ts/engine';

import { locateNativeBinary } from '../exec/binary.js';

/** 宿主 MCP 装配配置（环境连接位注入；不配置 = 装配管理器但不连接）。 */
export interface HostMcpConfig {
  /** 显式连接的内置 server（连接位随配置注入）。 */
  connect?: ReadonlyArray<{
    server_id: string;
    /** stdio 命令路径（内置 server 必需；缺省 = 装配期定位 ink_ts_mcp）。 */
    command?: string | null;
  }> | null;
}

/** 单个 server 连接结果（失败只记诊断，fail-closed 不击穿 boot）。 */
export interface McpConnectStatus {
  server_id: string;
  connected: boolean;
  error: string | null;
}

/** 内置 server → ink_ts_mcp profile（装配接线真源；未列出 = 无二进制接线）。 */
export const BUILTIN_MCP_PROFILES: Readonly<Record<string, string>> = {
  inkling_exec: 'exec',
  inkling_shell: 'shell',
};

/** 连接位覆盖解析产物（无二进制时 error 非空，调用方记 fail-closed 状态）。 */
export interface BuiltinOverridesResult {
  overrides: Record<string, unknown>;
  error: string | null;
}

/**
 * 内置 server 连接位解析：给 ink_ts_mcp 承载的内置 server 补 command=
 * （复用 exec/infer 同款二进制定位）+ profile 参数 + Content-Length 分帧。
 * 未列 profile 的 server_id 原样返回（不做二进制接线）；命令显式提供时仍
 * 注入 profile 参数与分帧（内置 server 的 profile 契约固定，见
 * engine adapters/mcp/registry.ts）。
 */
export function resolveBuiltinOverrides(
  server_id: string,
  command: string | null,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): BuiltinOverridesResult {
  const profile = BUILTIN_MCP_PROFILES[server_id];
  if (profile === undefined) {
    return { overrides: {}, error: null };
  }
  const binary =
    (command !== null && command !== undefined && command !== '' ? command : null) ??
    locateNativeBinary('mcp', opts);
  if (binary === null) {
    return {
      overrides: {},
      error: `内置 MCP server ${server_id}（profile ${profile}）的二进制未定位：` +
        '未找到 ink_ts_mcp（须先 cargo build -p ink_ts_mcp 或设 INK_MCP_BINARY/INK_NATIVE_DIR）——fail-closed',
    };
  }
  const overrides: Record<string, unknown> = {
    command: binary,
    args: [profile],
    // ink_ts_mcp 为 MCP stdio 标准分帧（宿主客户端写侧按此启用）
    stdio_framing: 'content_length',
  };
  return { overrides, error: null };
}

/** 装配 MCP 管理器（引擎注入 + 配置连接）；返回管理器供宿主域使用。 */
export async function assembleHostMcp(
  runtime: Runtime,
  config: HostMcpConfig | null,
): Promise<{ manager: McpClientManager; status: McpConnectStatus[] }> {
  const manager = new McpClientManager();
  const declarative = runtime.harness_registry?.declarative;
  if (declarative !== null && declarative !== undefined) {
    register_mcp_executor(declarative as never, manager);
  }
  runtime.mcp_manager = manager;
  const status: McpConnectStatus[] = [];
  for (const entry of config?.connect ?? []) {
    if (BUILTIN_MCP_SERVERS[entry.server_id] === undefined) {
      status.push({
        server_id: entry.server_id,
        connected: false,
        error: `未定义的内置 server: ${entry.server_id}`,
      });
      continue;
    }
    const resolved = resolveBuiltinOverrides(entry.server_id, entry.command ?? null);
    if (resolved.error !== null) {
      // 内置 server 无二进制：fail-closed 只记诊断（不击穿 boot）
      status.push({
        server_id: entry.server_id,
        connected: false,
        error: resolved.error,
      });
      continue;
    }
    const overrides: Record<string, unknown> = resolved.overrides;
    if (entry.command !== null && entry.command !== undefined) {
      overrides['command'] = entry.command;
    }
    try {
      await manager.connect_builtin(entry.server_id, overrides);
      status.push({ server_id: entry.server_id, connected: true, error: null });
    } catch (error) {
      // 连接失败 fail-closed：工具端点探活 connected=false，装配不击穿。
      status.push({
        server_id: entry.server_id,
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { manager, status };
}
