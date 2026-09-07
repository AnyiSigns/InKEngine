/**
 * graph 命令面（instance）——最近回合组装图结构与执行态只读投影。
 *
 * 数据源（无第二份台账）：instance = 最近回合组装图投影（introspection
 * snapshot_graph；引擎 _build_graph_engine 随每轮回合把本轮组装图刷新为
 * 内省图源）+ 该线程执行事件日志（storage.events_after：按事件 node/round_id
 * 推导最近一回合节点执行态；error 事件标记 failed，其余执行过节点 =
 * success）。无任何回合（纯冷启，宿主不产静态/默认图）= 空图 degraded 空态，
 * 不报错不回归。host 只接线投影，图结构与执行语义全在引擎。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 图节点行（id = 节点名；type = 声明类型名或函数直挂标记）。 */
export interface GraphNodeView {
  id: string;
  type: string;
  label: string;
}

/** 图边行（from/to 投影；声明式条件边 condition_name 附上）。 */
export interface GraphEdgeView {
  from: string;
  to: string;
  condition?: string;
}

/** 图实例结果（执行态仅覆盖最近一回合访问过的节点）。 */
export interface GraphInstanceView {
  thread_id: string;
  round_id: string | null;
  graph: { nodes: GraphNodeView[]; edges: GraphEdgeView[] };
  node_status: Record<string, string>;
  /** 无回合图或无条件边降级等不可得态 = true（结构化空态，不报错）。 */
  degraded: boolean;
  degraded_reason: string | null;
}

/** 引擎图快照结构（introspection.snapshot_graph 信封：{graph, digest}）。 */
interface GraphSnapshotEnvelope {
  graph: Record<string, unknown> | null;
  digest: string | null;
}

interface EventLike {
  type: string;
  node: string | null;
  round_id: string | null;
}

function requireThread(raw: unknown): string {
  const params = raw as { thread_id?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError('graph 方法需 params.thread_id', 'invalid_params');
  }
  return params.thread_id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 引擎图结构 → 节点/边行（to_dict 与降级视图同形：nodes[name].type +
 *  edges[source][].target；子图不递归展平）。 */
function projectGraph(data: Record<string, unknown> | null): {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
} {
  if (data === null) return { nodes: [], edges: [] };
  const nodes: GraphNodeView[] = [];
  const rawNodes = data['nodes'];
  if (isRecord(rawNodes)) {
    for (const [name, info] of Object.entries(rawNodes)) {
      const type = isRecord(info) && typeof info['type'] === 'string'
        ? info['type']
        : 'unknown';
      nodes.push({ id: name, type, label: name });
    }
  }
  const edges: GraphEdgeView[] = [];
  const rawEdges = data['edges'];
  if (isRecord(rawEdges)) {
    for (const [source, edgeList] of Object.entries(rawEdges)) {
      if (!Array.isArray(edgeList)) continue;
      for (const rawEdge of edgeList) {
        if (!isRecord(rawEdge)) continue;
        const target = rawEdge['target'];
        if (typeof target !== 'string' || target === '') continue;
        const edge: GraphEdgeView = { from: source, to: target };
        const condition = rawEdge['condition'];
        if (typeof condition === 'string' && condition !== '' && condition !== 'function') {
          edge['condition'] = condition;
        }
        edges.push(edge);
      }
    }
  }
  return { nodes, edges };
}

/** 取当前引擎回合图（introspection 单源；不可得 = null + 原因）。 */
function engineGraphSnapshot(
  deps: HostBridgeDeps,
): { envelope: GraphSnapshotEnvelope; reason: string | null } {
  const introspection = deps.runtime.introspection_service;
  if (introspection === null) {
    return { envelope: { graph: null, digest: null }, reason: 'graph_unavailable' };
  }
  const raw = introspection.snapshot_graph() as Record<string, unknown>;
  const graph = isRecord(raw['graph']) ? (raw['graph'] as Record<string, unknown>) : null;
  const digest = typeof raw['digest'] === 'string' ? raw['digest'] : null;
  if (graph === null) {
    return { envelope: { graph: null, digest: null }, reason: 'graph_unavailable' };
  }
  const degraded = graph['degraded'] === true;
  return {
    envelope: { graph, digest },
    reason: degraded ? 'graph_degraded' : null,
  };
}

export function buildGraphHandlers(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  /** graph.instance：最近回合组装图投影 + 最近一回合节点执行态摘要。 */
  const instance: BridgeHandler = async (raw): Promise<GraphInstanceView> => {
    const thread_id = requireThread(raw);
    const storage = deps.runtime.storage;
    const { envelope, reason } = engineGraphSnapshot(deps);
    const graph = projectGraph(envelope.graph);
    let events: EventLike[] = [];
    if (storage !== null) {
      events = (await storage.events_after(thread_id, 0).catch(() => [])) as unknown as EventLike[];
    }
    let roundId: string | null = null;
    for (const event of events) {
      if (event.round_id !== null && event.round_id !== '') roundId = event.round_id;
    }
    const nodeStatus: Record<string, string> = {};
    if (roundId !== null) {
      const visited = new Set<string>();
      const failed = new Set<string>();
      for (const event of events) {
        if (event.round_id !== roundId) continue;
        if (event.node === null || event.node === '') continue;
        visited.add(event.node);
        if (event.type === 'error') failed.add(event.node);
      }
      for (const node of visited) {
        nodeStatus[node] = failed.has(node) ? 'failed' : 'success';
      }
    }
    const degraded = reason !== null || events.length === 0;
    return {
      thread_id,
      round_id: roundId,
      graph,
      node_status: nodeStatus,
      degraded,
      degraded_reason: roundId === null ? 'no_events' : reason,
    };
  };

  return new Map<string, BridgeHandler>([
    ['graph.instance', instance],
  ]);
}
