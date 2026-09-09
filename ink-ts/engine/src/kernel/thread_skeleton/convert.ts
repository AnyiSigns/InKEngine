/**
 * 会话级骨架 ↔ 回合图定义数据互转（P4 回合模型升级的纯数据面）。
 *
 * - derive_skeleton_from_graph：组装选出的本轮图定义 → 会话骨架（只保留池
 *   内类型的节点/边引用 + 会话元信息；含子图/无名节点/缺出口的图不可派生 =
 *   null → 该回合回落回合级组装，骨架保持缺失由后续组装再建立）；
 * - skeleton_to_graph_data：骨架 → 本轮图定义数据（补全图容器字段；node 引
 *   用/边/出口原样携带，引擎按当前注册表解析执行体）。
 *
 * 图数据字段口径与 core/graph graph_serialize 对齐（nodes 以实例 id 为键的
 * spec dict、edges 以 from 为键的边 dict 数组、exits 数组）。
 */

import { isRecord } from '../../core/json.js';
import type { SkeletonEdgeSpec } from '../../core/thread_skeleton/index.js';
import { ThreadSkeleton } from '../../core/thread_skeleton/index.js';

/** 骨架 → 本轮图定义数据（name 补全——图 digest 不含 name，回合内稳定）。 */
export function skeleton_to_graph_data(skeleton: ThreadSkeleton): Record<string, unknown> {
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const [id, spec] of Object.entries(skeleton.nodes)) {
    const out: Record<string, unknown> = { type: spec.type };
    if (spec.config !== undefined && spec.config !== null) out['config'] = { ...spec.config };
    if (spec.contract !== undefined && spec.contract !== null) out['contract'] = { ...spec.contract };
    nodes[id] = out;
  }
  const edges: Record<string, Array<Record<string, unknown>>> = {};
  for (const [from, list] of Object.entries(skeleton.edges)) {
    edges[from] = list.map((e) => {
      const out: Record<string, unknown> = { target: e.target };
      if (e.condition !== undefined && e.condition !== null && e.condition !== '') {
        out['condition'] = e.condition;
      }
      if (e.kind === 'loop') out['kind'] = 'loop';
      return out;
    });
  }
  return {
    name: `thread.skeleton.${skeleton.thread_id}`,
    entry: skeleton.entry,
    nodes,
    edges,
    exits: [...skeleton.exits],
    subgraphs: {},
    schema: null,
  };
}

/** 组装图定义数据 → 会话骨架（不可派生 = null：含子图 / 无名节点 / 缺出口 /
 *  入口非法——骨架只承载池内类型引用，非池结构不得伪装成会话结构）。 */
export function derive_skeleton_from_graph(
  graphData: Record<string, unknown>,
  opts: { thread_id: string; created_at?: number },
): ThreadSkeleton | null {
  if (!isRecord(graphData)) return null;
  const entry = graphData['entry'];
  const nodesRaw = graphData['nodes'];
  const exitsRaw = graphData['exits'];
  if (typeof entry !== 'string' || entry === '') return null;
  if (!isRecord(nodesRaw) || Object.keys(nodesRaw).length === 0) return null;
  if (!Array.isArray(exitsRaw) || exitsRaw.length === 0) return null;
  const subgraphsRaw = graphData['subgraphs'];
  if (subgraphsRaw !== undefined && subgraphsRaw !== null && isRecord(subgraphsRaw)) {
    if (Object.keys(subgraphsRaw).length > 0) return null;
  }
  const nodes: Record<string, { type: string; config?: Record<string, unknown>; contract?: Record<string, unknown> }> = {};
  for (const [id, spec] of Object.entries(nodesRaw)) {
    if (!isRecord(spec)) return null;
    const type = spec['type'];
    if (typeof type !== 'string' || type === '') return null;
    const config = spec['config'];
    if (config !== undefined && config !== null && !isRecord(config)) return null;
    const contract = spec['contract'];
    if (contract !== undefined && contract !== null && !isRecord(contract)) return null;
    nodes[id] = {
      type,
      ...(config === undefined || config === null ? {} : { config: { ...(config as Record<string, unknown>) } }),
      ...(contract === undefined || contract === null ? {} : { contract: { ...(contract as Record<string, unknown>) } }),
    };
  }
  if (nodes[entry] === undefined) return null;
  const edges: Record<string, SkeletonEdgeSpec[]> = {};
  const edgesRaw = graphData['edges'];
  if (edgesRaw !== undefined && edgesRaw !== null) {
    if (!isRecord(edgesRaw)) return null;
    for (const [from, list] of Object.entries(edgesRaw)) {
      if (!Array.isArray(list)) return null;
      const out: SkeletonEdgeSpec[] = [];
      for (const raw of list) {
        if (!isRecord(raw)) return null;
        const target = raw['target'];
        if (typeof target !== 'string' || target === '') return null;
        const kind = raw['kind'];
        if (kind !== undefined && kind !== null && kind !== 'loop') return null;
        const condition = raw['condition'];
        if (condition !== undefined && condition !== null && typeof condition !== 'string') return null;
        if (nodes[target] === undefined) return null;
        out.push({
          target,
          ...(condition === undefined || condition === null ? {} : { condition }),
          ...(kind === 'loop' ? { kind: 'loop' as const } : {}),
        });
      }
      edges[from] = out;
    }
  }
  const exits: string[] = [];
  for (const exit of exitsRaw) {
    if (typeof exit !== 'string' || nodes[exit] === undefined) return null;
    exits.push(exit as string);
  }
  const now = opts.created_at ?? 0;
  return new ThreadSkeleton({
    thread_id: opts.thread_id,
    entry,
    nodes,
    edges,
    exits,
    status: 'active',
    active_target: null,
    created_at: now,
    updated_at: now,
  });
}
