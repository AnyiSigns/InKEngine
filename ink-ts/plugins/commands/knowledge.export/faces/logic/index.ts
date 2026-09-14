/**
 * knowledge.export 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/knowledge.ts
 * 迁入，语义零改）。JSON 导出串（全量补丁链可移植；kind 过滤 = 该类条目 to_dict
 * 子集）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { knowledgeSetOrThrow, unwrapArgs } from '../../../_shared/knowledge.js';
import { toJsonSafe } from '../../../_shared/records.js';

export default function createKnowledgeExport(deps: HostBridgeDeps): BridgeHandler {
  /** JSON 导出串（全量补丁链可移植；kind 过滤 = 该类条目 to_dict 子集）。 */
  const exportJson: BridgeHandler = (raw): string => {
    const knowledgeSet = knowledgeSetOrThrow(deps);
    const params = unwrapArgs(raw);
    const kind = typeof params['kind'] === 'string' && params['kind'] !== ''
      ? params['kind']
      : null;
    if (kind === null) {
      return JSON.stringify(toJsonSafe(knowledgeSet.export()), null, 2);
    }
    const entries = knowledgeSet.entries(null, { include_archived: true })
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.to_dict());
    return JSON.stringify({ kind, exported_at: Math.floor(Date.now() / 1000), entries }, null, 2);
  };

  return exportJson;
}
