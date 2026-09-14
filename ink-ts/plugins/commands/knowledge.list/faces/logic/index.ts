/**
 * knowledge.list 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/knowledge.ts
 * 迁入，语义零改）。知识集条目窗口（query/kind 过滤 + include_archived 开关）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import {
  entryView,
  knowledgeSetOrThrow,
  matchesQuery,
  unwrapArgs,
} from '../../../_shared/knowledge.js';

export default function createKnowledgeList(deps: HostBridgeDeps): BridgeHandler {
  /** 知识集条目窗口（query/kind 过滤 + include_archived 开关）。 */
  const list: BridgeHandler = (raw): unknown => {
    const knowledgeSet = knowledgeSetOrThrow(deps);
    const params = unwrapArgs(raw);
    const kind = typeof params['kind'] === 'string' && params['kind'] !== ''
      ? params['kind']
      : null;
    const includeArchived =
      params['archived'] === true
      || params['includeArchived'] === true
      || params['include_archived'] === true;
    const query = typeof params['query'] === 'string' && params['query'] !== ''
      ? params['query']
      : null;
    const entries = knowledgeSet.entries(null, { include_archived: includeArchived });
    const filtered = entries.filter((entry) => {
      if (kind !== null && entry.kind !== kind) return false;
      if (query !== null && !matchesQuery(entry, query)) return false;
      return true;
    });
    return { entries: filtered.map((entry) => entryView(entry)) };
  };

  return list;
}
