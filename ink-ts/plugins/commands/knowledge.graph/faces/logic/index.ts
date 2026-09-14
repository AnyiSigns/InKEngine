/**
 * knowledge.graph 命令逻辑面 —— S3 命令逻辑下沉（hosts/lib/src/bridge/knowledge.ts
 * 迁入，语义零改）。层级概览：层级计数 + 组件支持 kind 的节点/边
 * （tag/source/reference）。
 */

import type { BridgeHandler, HostBridgeDeps } from '@ink-ts/host';
import { GRAPH_KINDS, knowledgeSetOrThrow } from '../../../_shared/knowledge.js';

export default function createKnowledgeGraph(deps: HostBridgeDeps): BridgeHandler {
  /** 层级概览：层级计数 + 组件支持 kind 的节点/边（tag/source/reference）。 */
  const graph: BridgeHandler = (): unknown => {
    const knowledgeSet = knowledgeSetOrThrow(deps);
    const entries = knowledgeSet.entries();
    const levelCounts = new Map<string, number>();
    for (const entry of entries) {
      levelCounts.set(entry.level, (levelCounts.get(entry.level) ?? 0) + 1);
    }
    const nodes: Array<{ id: string; label: string; kind: string; level: string }> = [];
    for (const entry of entries) {
      if (!(GRAPH_KINDS as readonly string[]).includes(entry.kind)) continue;
      nodes.push({
        id: entry.id,
        label: entry.title || entry.id,
        kind: entry.kind,
        level: entry.level,
      });
    }
    const rendered = new Map<string, string>();
    for (const entry of entries) {
      try {
        rendered.set(entry.id, entry.render_content());
      } catch {
        rendered.set(entry.id, '');
      }
    }
    const edges: Array<{ source: string; target: string; relation: string }> = [];
    const tagPeers = new Map<string, string[]>();
    for (const entry of entries) {
      for (const tag of entry.tags) {
        const peers = tagPeers.get(tag) ?? [];
        peers.push(entry.id);
        tagPeers.set(tag, peers);
      }
    }
    for (const peers of tagPeers.values()) {
      for (let i = 0; i < peers.length; i += 1) {
        for (let j = i + 1; j < peers.length; j += 1) {
          edges.push({ source: peers[i]!, target: peers[j]!, relation: 'tag' });
        }
      }
    }
    const sourcePeers = new Map<string, string[]>();
    for (const entry of entries) {
      if (entry.source === '' || entry.source === 'model') continue;
      const peers = sourcePeers.get(entry.source) ?? [];
      peers.push(entry.id);
      sourcePeers.set(entry.source, peers);
    }
    for (const peers of sourcePeers.values()) {
      for (let i = 0; i < peers.length; i += 1) {
        for (let j = i + 1; j < peers.length; j += 1) {
          edges.push({ source: peers[i]!, target: peers[j]!, relation: 'source' });
        }
      }
    }
    for (const entry of entries) {
      const content = rendered.get(entry.id) ?? '';
      if (content === '') continue;
      for (const other of entries) {
        if (other.id === entry.id) continue;
        if (
          content.includes(other.id)
          || (other.title !== '' && content.includes(other.title))
        ) {
          edges.push({ source: entry.id, target: other.id, relation: 'reference' });
        }
      }
    }
    if (edges.length > 1000) edges.length = 1000;
    return {
      degraded: entries.length === 0,
      total: entries.length,
      levels: [...levelCounts.entries()]
        .map(([level, count]) => ({ level, count }))
        .sort((a, b) => a.level.localeCompare(b.level)),
      nodes,
      edges,
    };
  };

  return graph;
}
