/**
 * mcp 命令面（status/enable/disable）——MCP 工具型插件启停（B5）。
 *
 * 语义（permission_plugin_convergence B5）：MCP 服务端 = 工具型插件（对用户
 * 不呈现 kind）；命令面只做 plugin 启停三件事：
 * - mcp.status：候选清单 + 启用/连接/工具数状态（plugins/mcp/<id>/spec.json
 *   真源目录扫描；同一注册表的人类视图）；
 * - mcp.enable：会话内装载 = connect（stdio 自动监督拉起）→ import_tools →
 *   声明式注册 + 工具索引刷新 → 台账持久化（重启自动拉起）；
 * - mcp.disable：注销声明式定义 + 索引摘除 + 断开会话（进程回收）→ 台账摘除。
 *
 * 市场浏览/「添加市场条目」已退役（preview/add/remove 无真源本就不提供）。
 * 实现 = 薄接线：真逻辑在 McpPluginService（boot 装配 + 台账 + 生命周期），
 * 本文件只做参数/错误收敛；未装配（plugins 源缺 = 不可用）显式报错。
 */

import type { McpCommand } from './commands.generated.js';
export { MCP_COMMANDS, type McpCommand } from './commands.generated.js';

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 服务缺省（plugins 源不可用 = mcp.* 域不可用）。 */
function serviceOrThrow(deps: HostBridgeDeps) {
  if (deps.mcpPlugins === null || deps.mcpPlugins === undefined) {
    throw new BridgeError(
      'MCP 插件服务未装配（plugins 源不可用；serve 需 --seed-dir）',
      'runtime_unavailable',
    );
  }
  return deps.mcpPlugins;
}

function stringParam(raw: unknown, keys: readonly string[]): string | null {
  const params = raw as Record<string, unknown> | null;
  if (params === null || typeof params !== 'object') return null;
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

export function buildMcpCommands(deps: HostBridgeDeps): Readonly<Record<McpCommand, BridgeHandler>> {
  const status: BridgeHandler = (): unknown => {
    const service = serviceOrThrow(deps);
    const source =
      typeof deps.seed_dir === 'string' && deps.seed_dir !== ''
        ? deps.seed_dir
        : service.pluginsRoot;
    return { source, servers: service.list() };
  };

  const enable: BridgeHandler = async (raw): Promise<unknown> => {
    const service = serviceOrThrow(deps);
    const id = stringParam(raw, ['id', 'server_id', 'name']);
    if (id === null) {
      throw new BridgeError('mcp.enable 需 params.id（插件/server id）', 'invalid_params');
    }
    const outcome = await service.enable(id);
    if (!outcome.ok) {
      throw new BridgeError(
        outcome.error ?? `MCP 插件启用失败: ${id}`,
        'mcp_enable_failed',
      );
    }
    return outcome;
  };

  const disable: BridgeHandler = async (raw): Promise<unknown> => {
    const service = serviceOrThrow(deps);
    const id = stringParam(raw, ['id', 'server_id', 'name']);
    if (id === null) {
      throw new BridgeError('mcp.disable 需 params.id（插件/server id）', 'invalid_params');
    }
    const outcome = await service.disable(id);
    if (!outcome.ok) {
      throw new BridgeError(
        outcome.error ?? `MCP 插件停用失败: ${id}`,
        'mcp_disable_failed',
      );
    }
    return outcome;
  };

  /** 指定安装（B6）：登记额外连接配置（url/command）并立即启用（review/pose 决）。 */
  const install: BridgeHandler = async (raw): Promise<unknown> => {
    const service = serviceOrThrow(deps);
    const params =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const id = stringParam(params, ['id', 'server_id']);
    if (id === null) {
      throw new BridgeError('mcp.install 需 params.id（新 server id）', 'invalid_params');
    }
    const transport = params['transport'] === 'stdio' ? 'stdio' : 'http';
    const command = typeof params['command'] === 'string' ? params['command'] : null;
    const url = typeof params['url'] === 'string' ? params['url'] : null;
    const rawArgs = params['args'];
    const args = Array.isArray(rawArgs)
      ? rawArgs.filter((a): a is string => typeof a === 'string')
      : [];
    const name = typeof params['name'] === 'string' ? params['name'] : undefined;
    const outcome = await service.install(id, {
      transport,
      ...(name !== undefined && name !== '' ? { name } : {}),
      url,
      command,
      args,
    });
    if (!outcome.ok) {
      throw new BridgeError(outcome.error ?? `MCP 指定安装失败: ${id}`, 'mcp_install_failed');
    }
    return outcome;
  };

  /** 移除指定安装（B6）：停用 + 摘除额外连接配置。 */
  const remove: BridgeHandler = async (raw): Promise<unknown> => {
    const service = serviceOrThrow(deps);
    const id = stringParam(raw, ['id', 'server_id', 'name']);
    if (id === null) {
      throw new BridgeError('mcp.remove 需 params.id（插件/server id）', 'invalid_params');
    }
    const outcome = await service.remove(id);
    if (!outcome.ok) {
      throw new BridgeError(outcome.error ?? `MCP 指定安装移除失败: ${id}`, 'mcp_remove_failed');
    }
    return outcome;
  };

  return {
    'mcp.status': status,
    'mcp.enable': enable,
    'mcp.disable': disable,
    'mcp.install': install,
    'mcp.remove': remove,
  };
}
