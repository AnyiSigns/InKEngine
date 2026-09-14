/**
 * recovery.checkpoints 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/recovery.ts
 * 迁入，语义零改）。可回退点查询：链行降序 + 中断锚点标注。
 */

import { BridgeError } from '@ink-ts/host';
import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { requireThread } from '../../../_shared/recovery.js';

export default function createRecoveryCheckpoints(deps: HostBridgeDeps): BridgeHandler {
  const checkpoints: BridgeHandler = async (raw): Promise<unknown> => {
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const thread_id = requireThread(raw, 'recovery.checkpoints').thread_id;
    const chain = await storage.chain_index(thread_id).catch(() => []);
    const rows = chain.map((link) => ({
      checkpoint_id: link.checkpoint_id,
      parent_id: link.parent_id,
      reason: link.reason,
      graph_path: [...link.graph_path],
    }));
    rows.sort((a, b) => b.checkpoint_id - a.checkpoint_id);
    return {
      thread_id,
      latest: rows[0]?.checkpoint_id ?? null,
      points: rows,
    };
  };

  return checkpoints;
}
