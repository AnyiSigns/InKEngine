/**
 * mcp.install 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/mcp.ts 迁入，
 * 语义零改）。指定安装（B6）：登记额外连接配置（url/command）并立即启用
 * （review/pose 决）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { serviceOrThrow, stringParam } from '../../../_shared/mcp.js';

export default function createMcpInstall(deps: HostBridgeDeps): BridgeHandler {
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

  return install;
}
