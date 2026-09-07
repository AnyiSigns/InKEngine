/**
 * mcp 命令面（market/mount/unmount）——市场浏览 + 会话生命周期接线。
 *
 * 数据源：market = seed_data/mcp_market.json（seed_dir 或按包位置探测），
 * 每 server 附 mounted 状态（连接态 = manager.list_servers() 命中）；mount/
 * unmount 经 H1 装配段 McpClientManager connect/disconnect（manager 已注册
 * 引擎声明式执行器），失败 fail-closed 显式报错。preview/add/remove 无真源
 * （引擎无市场摄入管线）→ 不提供（web 侧删除入口）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClientManager, McpServerConfig } from '@ink-ts/engine';

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 市场条目（seed_data/mcp_market.json 结构透传；mounted 为本方法补充）。 */
export interface McpMarketServerView {
  id: string;
  name: string;
  source: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  risk?: string;
  risk_note?: string;
  category?: string;
  mounted: boolean;
}

/** mcp.market 结果。 */
export interface McpMarketView {
  source: string;
  premounted: boolean;
  mount_policy: Record<string, unknown>;
  servers: McpMarketServerView[];
}

const MARKET_FILE = 'mcp_market.json';
/** 市场文件探测深度（seed_dir 未给时沿包位置向上找 seed_data/）。 */
const PROBE_DEPTH = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 市场文件定位（seed_dir 优先；缺省 = 沿模块目录上探 seed_data/）。 */
function resolveMarketFile(deps: HostBridgeDeps): string {
  if (deps.seed_dir !== undefined && deps.seed_dir !== '') {
    return join(deps.seed_dir, MARKET_FILE);
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < PROBE_DEPTH; depth += 1) {
    const candidate = join(dir, 'seed_data', MARKET_FILE);
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      dir = resolve(dir, '..');
    }
  }
  throw new BridgeError(
    'mcp 市场数据不可用（seed_data/mcp_market.json 未找到；serve 需 --seed-dir）',
    'runtime_unavailable',
  );
}

function managerOrThrow(deps: HostBridgeDeps): McpClientManager {
  if (deps.mcpManager === null || deps.mcpManager === undefined) {
    throw new BridgeError('MCP 管理器未装配', 'runtime_unavailable');
  }
  return deps.mcpManager;
}

/** mcp.mount 参数（config = McpServerConfig 数据形态；server_id 必填）。 */
function parseMountConfig(raw: unknown): { config: McpServerConfig; source: string } {
  const params = raw as { config?: unknown; source?: unknown } | null;
  const configRaw =
    params !== null && typeof params === 'object' ? (params.config ?? params) : raw;
  let config: McpServerConfig;
  try {
    config = McpServerConfig.from_dict(configRaw);
  } catch (error) {
    throw new BridgeError(
      `mcp.mount config 非法: ${error instanceof Error ? error.message : String(error)}`,
      'invalid_params',
    );
  }
  const source =
    params !== null && typeof params.source === 'string' && params.source !== ''
      ? params.source
      : config.source;
  return { config, source };
}

/** mcp 命令声明（方法名唯一真源；装配由 index 聚合此表）。 */
export const MCP_COMMANDS = [
  'mcp.market',
  'mcp.mount',
  'mcp.unmount',
] as const;

export type McpCommand = (typeof MCP_COMMANDS)[number];

export function buildMcpCommands(deps: HostBridgeDeps): Readonly<Record<McpCommand, BridgeHandler>> {
  const market: BridgeHandler = (): McpMarketView => {
    const manager = managerOrThrow(deps);
    const file = resolveMarketFile(deps);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch (error) {
      throw new BridgeError(
        `mcp 市场数据解析失败: ${error instanceof Error ? error.message : String(error)}`,
        'runtime_unavailable',
      );
    }
    if (!isRecord(data) || !Array.isArray(data['servers'])) {
      throw new BridgeError('mcp 市场数据缺 servers 清单', 'runtime_unavailable');
    }
    const connected = new Set(manager.list_servers());
    const servers: McpMarketServerView[] = [];
    for (const entry of data['servers'] as unknown[]) {
      if (!isRecord(entry) || typeof entry['id'] !== 'string') continue;
      const url = typeof entry['url'] === 'string' ? entry['url'] : null;
      const command = typeof entry['command'] === 'string' ? entry['command'] : null;
      servers.push({
        id: entry['id'],
        name: typeof entry['name'] === 'string' ? entry['name'] : entry['id'],
        source: typeof entry['source'] === 'string' ? entry['source'] : '',
        transport: typeof entry['transport'] === 'string' ? entry['transport'] : '',
        url,
        command,
        args: Array.isArray(entry['args'])
          ? (entry['args'] as unknown[]).filter((arg): arg is string => typeof arg === 'string')
          : [],
        ...(typeof entry['risk'] === 'string' ? { risk: entry['risk'] } : {}),
        ...(typeof entry['risk_note'] === 'string' ? { risk_note: entry['risk_note'] } : {}),
        ...(typeof entry['category'] === 'string' ? { category: entry['category'] } : {}),
        mounted: connected.has(entry['id']),
      });
    }
    return {
      source: file,
      premounted: data['premounted'] === true,
      mount_policy: isRecord(data['mount_policy']) ? data['mount_policy'] : {},
      servers,
    };
  };

  /** 挂载：config 连接 + 工具导入（vetting 闸门在场即挂；失败 fail-closed）。 */
  const mount: BridgeHandler = async (raw): Promise<unknown> => {
    const manager = managerOrThrow(deps);
    const { config, source } = parseMountConfig(raw);
    try {
      await manager.connect(config);
    } catch (error) {
      throw new BridgeError(
        `MCP 连接失败: ${error instanceof Error ? error.message : String(error)}`,
        'mcp_connect_failed',
      );
    }
    let tool_count = 0;
    try {
      const vetting = deps.runtime.vetting as never;
      const specs = await manager.import_tools(config.id, {
        source: source as never,
        vetting: (vetting ?? null) as never,
      });
      tool_count = specs.length;
    } catch {
      // 工具导入失败不阻断连接（已连接会话可查；工具表下次挂载再导）
    }
    return { ok: true, server_id: config.id, connected: true, tool_count };
  };

  /** 卸载：断开会话（未挂载显式拒绝；幂等断开后返回已断开）。 */
  const unmount: BridgeHandler = async (raw): Promise<unknown> => {
    const manager = managerOrThrow(deps);
    const params = raw as { name?: unknown; server_id?: unknown } | null;
    const name =
      params !== null
        ? typeof params.name === 'string'
          ? params.name
          : typeof params.server_id === 'string'
            ? params.server_id
            : null
        : null;
    if (name === null || name === '') {
      throw new BridgeError('mcp.unmount 需 params.name（server_id）', 'invalid_params');
    }
    const closed = await manager.disconnect(name);
    if (!closed) {
      throw new BridgeError(`MCP server 未挂载: ${name}`, 'mcp_not_connected');
    }
    return { ok: true, server_id: name, connected: false };
  };

  return {
    'mcp.market': market,
    'mcp.mount': mount,
    'mcp.unmount': unmount,
  };
}
