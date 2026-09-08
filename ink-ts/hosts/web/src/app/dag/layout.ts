import type { DagGraph, DagLayout, DagLayoutNode, DagNode } from './types';
import { DAG_GAP_X, DAG_GAP_Y, DAG_NODE_H, DAG_NODE_W, DAG_PAD } from './types';

/**
 * 拓扑分层布局（不做力导向）：按最长路径从根（入度为 0）计算层号，
 * 同层节点纵向堆叠并整体居中。分组折叠不影响布局（位置稳定）。
 */
export function layoutGraph(graph: DagGraph): DagLayout {
  const nodes = graph.nodes;
  const byId = new Map<string, DagNode>(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  const parentsOf = new Map<string, string[]>();
  for (const n of nodes) {
    childrenOf.set(n.id, []);
    parentsOf.set(n.id, []);
  }
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    childrenOf.get(e.from)!.push(e.to);
    parentsOf.get(e.to)!.push(e.from);
  }

  const layer = new Map<string, number>();
  const visiting = new Set<string>();

  function computeLayer(id: string): number {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0; // 环：断开，回落当前层
    visiting.add(id);
    const parents = parentsOf.get(id) ?? [];
    let maxParent = -1;
    for (const p of parents) maxParent = Math.max(maxParent, computeLayer(p));
    visiting.delete(id);
    const l = maxParent + 1;
    layer.set(id, l);
    return l;
  }
  for (const n of nodes) computeLayer(n.id);

  const layers = Math.max(0, ...nodes.map((n) => layer.get(n.id) ?? 0)) + 1;
  const columns: Record<number, string[]> = {};
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    (columns[l] ??= []).push(n.id);
  }

  const columnMaxH: number[] = [];
  const positions: DagLayoutNode[] = [];
  let maxWidth = 0;
  for (let l = 0; l < layers; l++) {
    const col = columns[l] ?? [];
    const columnHeight = col.length * DAG_NODE_H + Math.max(0, col.length - 1) * DAG_GAP_Y;
    columnMaxH.push(columnHeight);
    maxWidth += DAG_NODE_W + (l > 0 ? DAG_GAP_X : 0);
  }
  const maxColumnHeight = Math.max(0, ...columnMaxH);

  for (let l = 0; l < layers; l++) {
    const col = columns[l] ?? [];
    const columnHeight = col.length * DAG_NODE_H + Math.max(0, col.length - 1) * DAG_GAP_Y;
    const yOffset = (maxColumnHeight - columnHeight) / 2;
    col.forEach((id, idx) => {
      const node = byId.get(id)!;
      const x = DAG_PAD + l * (DAG_NODE_W + DAG_GAP_X);
      const y = DAG_PAD + yOffset + idx * (DAG_NODE_H + DAG_GAP_Y);
      positions.push({ id, x, y, layer: l, column: l, node });
    });
  }

  const width = maxWidth + DAG_PAD * 2;
  const height = maxColumnHeight + DAG_PAD * 2;
  return { positions, width, height, layers };
}

/** 贝塞尔边路径（水平出/入，控制点外扩）。 */
export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  nodeW = DAG_NODE_W,
  nodeH = DAG_NODE_H,
): string {
  const x1 = from.x + nodeW;
  const y1 = from.y + nodeH / 2;
  const x2 = to.x;
  const y2 = to.y + nodeH / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
