/**
 * 声明式工作流编译：节点类型清单 + 静态边 → 图定义（建图期校验）。
 *
 * 图 DSL（core.graph）以函数式节点为最小单元、执行模型为路径行走
 * （单条确定性路径，出口即终止）；工作流把节点描述为「类型名 + 配置」
 * 的数据形态，语义为「全节点按依赖序各执行一次」。两种语义的差异
 * （扇出分支）由编译器在表达层收敛：按拓扑序串行化，分支间以桥接边
 * 衔接——节点执行顺序与「先决节点先执行」的依赖语义不变，画布上
 * 平行的分支在顺序上前后衔接（稳定序：边插入序），状态按通道累积，
 * 与运行期可观测行为等价。需要回路的动态编排直接用图 DSL 表达，
 * 不经本编译器（静态边回路在建图期拒绝）。
 *
 * 建图期校验：节点 id 重复、节点类型未注册、边引用未知节点、静态边
 * 回路、入口歧义/缺失、入口不可达节点——全部在建图时报错，不等到
 * 运行时。返回未编译的 Graph（宿主可继续追加节点/边——如挂接收尾
 * 节点——再经 Engine 构造触发完整编译校验）。
 */

import { Graph } from '../graph/graph.js';
import { GraphDefinitionError } from '../errors.js';
import type { NodeTypeRegistryLike } from '../graph/graph_types.js';
import { WorkflowNodeSpec, WorkflowEdgeSpec, WorkflowSpec } from './workflow_types.js';

// ── 入口解析 ────────────────────────────────────────────────────────────────

/**
 * 入口解析：显式声明优先（校验存在），否则唯一无入边节点。
 *
 * 无入边节点多于一个 = 入口歧义（工作流 DSL 单入口，建图期拒绝）；
 * 一个都没有 = 边集构成回路（已在回路校验拦截，此处兜底说明）。
 */
function _infer_entry(
  node_ids: readonly string[],
  incoming: Set<string>,
  declared: string | null,
): string {
  if (declared !== null) {
    if (!node_ids.includes(declared)) {
      throw new GraphDefinitionError(`入口节点不存在: ${declared}`);
    }
    return declared;
  }
  if (node_ids.length === 0) {
    throw new GraphDefinitionError('工作流为空（无节点）');
  }
  const sources = node_ids.filter((nid) => !incoming.has(nid));
  if (sources.length === 1) {
    return sources[0]!;
  }
  if (sources.length === 0) {
    throw new GraphDefinitionError('工作流存在循环依赖，无法确定入口');
  }
  throw new GraphDefinitionError(
    '工作流存在多个无入边节点，入口歧义，请显式声明入口: ' + sources.join(', '),
  );
}

// ── 拓扑序 ───────────────────────────────────────────────────────────────────

interface TopoData {
  out_map: Map<string, string[]>;
  in_degree: Map<string, number>;
}

/**
 * 构建出边邻接表与入度表（Kahn 算法前的准备）。
 */
function _build_degree_maps(edges: readonly WorkflowEdgeSpec[]): TopoData {
  const out_map = new Map<string, string[]>();
  const in_degree = new Map<string, number>();
  for (const edge of edges) {
    if (!out_map.has(edge.source)) out_map.set(edge.source, []);
    out_map.get(edge.source)!.push(edge.target);
    in_degree.set(edge.target, (in_degree.get(edge.target) ?? 0) + 1);
    in_degree.set(edge.source, in_degree.get(edge.source) ?? 0);
  }
  return { out_map, in_degree };
}

/**
 * 稳定拓扑序（Kahn）：依赖序串行化的衔接顺序。
 *
 * 初始队列 = 入口；零入度节点按节点清单插入序入队（同输入恒同序）。
 * 显式入口时校验全节点可达（入口不可达的孤岛建图期拒绝，防止
 * 串行化后孤岛被静默跳过）。
 */
function _topological_order(
  node_ids: readonly string[],
  edges: readonly WorkflowEdgeSpec[],
  entry: string,
): string[] {
  const { out_map, in_degree } = _build_degree_maps(edges);

  // 可达性：从入口沿出边 DFS，孤岛建图期拒绝
  const reachable = new Set<string>();
  const stack: string[] = [entry];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    const targets = out_map.get(current);
    if (targets !== undefined) stack.push(...targets);
  }
  const isolated = node_ids.filter((nid) => !reachable.has(nid));
  if (isolated.length > 0) {
    throw new GraphDefinitionError(
      '存在从入口不可达的节点，工作流不完整: ' + isolated.join(', '),
    );
  }

  // Kahn 算法：零入度节点按清单序入队，入口始作为首个
  const order: string[] = [];
  let queue = node_ids.filter((nid) => (in_degree.get(nid) ?? 0) === 0);
  queue = [entry, ...queue.filter((nid) => nid !== entry)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    const targets = out_map.get(current);
    if (targets !== undefined) {
      for (const target of targets) {
        const deg = (in_degree.get(target) ?? 0) - 1;
        in_degree.set(target, deg);
        if (deg === 0) queue.push(target);
      }
    }
  }
  if (order.length !== node_ids.length) {
    throw new GraphDefinitionError('工作流存在循环依赖');
  }
  return order;
}

// ── 编译 ─────────────────────────────────────────────────────────────────────

/**
 * 把工作流规格编译为图定义（类型解析 + 边校验 + 串行化 + 入口/出口）。
 *
 * 扇出串行化：全节点按稳定拓扑序衔接，画布平行分支在顺序上前后
 * 衔接（桥接边只在缺少直接边时补插）——执行模型从路径行走收敛到
 * 工作流语义（全节点各执行一次，先决节点先执行）。
 *
 * Args:
 *   spec: 工作流规格（节点/边/可选入口）。
 *   registry: 节点类型注册表（按类型解析工厂，配置透传实例化）。
 *
 * Returns:
 *   未编译的 Graph（宿主可继续追加节点/边后交给 Engine 构造）。
 *
 * Raises:
 *   GraphDefinitionError: 规格非法（重复 id/未知类型/悬空边/回路/
 *     入口问题/入口不可达节点）。
 */
export function build_workflow_graph(
  spec: WorkflowSpec,
  registry: NodeTypeRegistryLike,
): Graph {
  const node_ids: string[] = [];
  const seen = new Set<string>();
  for (const node of spec.nodes) {
    if (seen.has(node.id)) {
      throw new GraphDefinitionError(`节点 id 重复: ${node.id}`);
    }
    seen.add(node.id);
    node_ids.push(node.id);
  }

  const edge_list = [...spec.edges];
  for (const edge of edge_list) {
    if (!seen.has(edge.source)) {
      throw new GraphDefinitionError(`边引用未知节点: ${edge.source} -> ${edge.target}`);
    }
    if (!seen.has(edge.target)) {
      throw new GraphDefinitionError(`边引用未知节点: ${edge.source} -> ${edge.target}`);
    }
  }

  const incoming = new Set(edge_list.map((e) => e.target));
  const entry = _infer_entry(node_ids, incoming, spec.entry);
  const order = _topological_order(node_ids, edge_list, entry);

  const graph = new Graph({ name: spec.name, entry: order[0]! });
  for (const node of spec.nodes) {
    // 声明式绑定：类型名 + 配置记录在图上（图定义数据化——序列化/重建
    // 按类型名引用），函数实例化经 resolve_types 统一解析
    graph.add_node_type(node.id, node.type, node.config);
  }
  graph.resolve_types(registry);
  // 串行化衔接：相邻拓扑序节点的连接边（规格边或桥接边）一律先于
  // 该节点的其余规格边加入——执行器沿首个静态边行走，链边必须占据
  // 边列表首位，否则扇出分支会抢先拐走、后续节点被跳过。
  const chain_edges = new Set<string>();
  for (let i = 0; i < order.length - 1; i++) {
    const prev = order[i]!;
    const nxt = order[i + 1]!;
    chain_edges.add(`${prev}\0${nxt}`);
    graph.add_edge(prev, nxt);
  }
  for (const edge of edge_list) {
    if (!chain_edges.has(`${edge.source}\0${edge.target}`)) {
      graph.add_edge(edge.source, edge.target);
    }
  }
  graph.add_exit(order[order.length - 1]!);
  return graph;
}
