/**
 * mcp.remove 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/mcp.ts 迁入，
 * 语义零改）。移除指定安装（B6）：停用 + 摘除额外连接配置。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { serviceOrThrow, stringParam } from '../../../_shared/mcp.js';

export default function createMcpRemove(deps: HostBridgeDeps): BridgeHandler {
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

  return remove;
}
