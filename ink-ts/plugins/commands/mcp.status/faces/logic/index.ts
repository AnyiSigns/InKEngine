/**
 * mcp.status 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/mcp.ts 迁入，
 * 语义零改）。候选清单 + 启用/连接/工具数状态（plugins/mcp/<id>/spec.json 真源
 * 目录扫描；同一注册表的人类视图）。
 */

import { serviceOrThrow } from '../../../_shared/mcp.js';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';

export default function createMcpStatus(deps: HostBridgeDeps): BridgeHandler {
  const status: BridgeHandler = (): unknown => {
    const service = serviceOrThrow(deps);
    const source =
      typeof deps.seed_dir === 'string' && deps.seed_dir !== ''
        ? deps.seed_dir
        : service.pluginsRoot;
    return { source, servers: service.list() };
  };

  return status;
}
