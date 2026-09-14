/**
 * mcp.enable 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/mcp.ts 迁入，
 * 语义零改）。会话内装载 = connect（stdio 自动监督拉起）→ import_tools → 声明式
 * 注册 + 工具索引刷新 → 台账持久化（重启自动拉起）。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { serviceOrThrow, stringParam } from '../../../_shared/mcp.js';

export default function createMcpEnable(deps: HostBridgeDeps): BridgeHandler {
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

  return enable;
}
