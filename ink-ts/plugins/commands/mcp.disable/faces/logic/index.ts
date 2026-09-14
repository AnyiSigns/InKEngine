/**
 * mcp.disable 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/mcp.ts 迁入，
 * 语义零改）。注销声明式定义 + 索引摘除 + 断开会话（进程回收）→ 台账摘除。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { serviceOrThrow, stringParam } from '../../../_shared/mcp.js';

export default function createMcpDisable(deps: HostBridgeDeps): BridgeHandler {
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

  return disable;
}
