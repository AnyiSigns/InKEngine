/**
 * B3 数据图回合执行 helper（引擎无常驻静态 Engine 后的测试装配面）。
 *
 * 存量测试原经配方静态图重建的常驻引擎跑任意图断言（静态图通道已删）；
 * 回合引擎 = 组装数据图/恢复/分支按图构建——本 helper 用
 * 运行时装配单源（_build_graph_engine：seams/沉淀/观察传输同源）从数据图
 * dict 构造本轮引擎执行，语义与 assemble_round 产出的回合引擎一致。
 *
 * 自定义节点类型：注册进 runtime.graph_registries.nodes（工厂 + 类型名），
 * 数据图按类型名引用即可装载执行——不落声明式登记（测试用临时执行体不进
 * node_registry_store，治理/契约池视图零影响）。
 */

import type { Engine } from '../../../src/core/executor/index.js';
import type { Runtime } from '../../../src/core/runtime/index.js';
import { ROUND_GRAPH_STATE_KEY } from '../../../src/core/runtime/_runtime_rounds.js';
import type { RunResult } from '../../../src/core/run_result/run_result.js';
import type { NodeFactory } from '../../../src/core/registry/registry_types.js';

/** 数据图节点声明（类型名须已在 runtime.graph_registries.nodes 注册）。 */
export interface DataGraphNodeSpec {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

/** 数据图边声明（缺省 = 静态边；condition 引用注册的条件边名）。 */
export interface DataGraphEdgeSpec {
  from: string;
  to: string;
  condition?: string;
}

/** 数据图 dict 构造（与组装候选图/池种子同形态：nodes[].type + edges[]）。 */
export function dataGraph(opts: {
  name: string;
  entry: string;
  nodes: readonly DataGraphNodeSpec[];
  edges?: readonly DataGraphEdgeSpec[] | null;
  exits: readonly string[];
}): Record<string, unknown> {
  const nodes: Record<string, Record<string, unknown>> = {};
  for (const node of opts.nodes) {
    nodes[node.id] = { type: node.type, ...(node.config ? { config: node.config } : {}) };
  }
  const edges: Record<string, Array<Record<string, unknown>>> = {};
  for (const edge of opts.edges ?? []) {
    const list = edges[edge.from] ?? [];
    list.push(
      edge.condition === undefined || edge.condition === null
        ? { target: edge.to }
        : { target: edge.to, condition: edge.condition },
    );
    edges[edge.from] = list;
  }
  return {
    name: opts.name,
    entry: opts.entry,
    nodes,
    edges,
    exits: [...opts.exits],
    subgraphs: {},
    schema: null,
  };
}

/** 测试临时节点类型注册（不进声明式登记 store；重复注册按注册表语义报错）。 */
export function registerNodeType(runtime: Runtime, typeName: string, factory: NodeFactory): void {
  const registry = runtime.graph_registries?.nodes;
  if (registry === null || registry === undefined) {
    throw new Error('运行时注册表未装配（registerNodeType 须在 boot 之后）');
  }
  registry.register(typeName, factory);
}

/** 按数据图 dict 构建本轮引擎（运行时装配单源：seams/沉淀/观察传输同源）。 */
export async function buildRoundEngine(
  runtime: Runtime,
  graphData: Record<string, unknown>,
  opts: { llm?: unknown | null; domain?: string | null } = {},
): Promise<Engine> {
  const anyRt = runtime as unknown as {
    _build_graph_engine(
      data: Record<string, unknown>,
      o: { llm?: unknown | null; domain?: string | null },
    ): Promise<Engine>;
  };
  return await anyRt._build_graph_engine(graphData, opts);
}

/** 数据图引擎执行一次回合（state 自动带本轮图定义 → 恢复/分支可重建）。 */
export interface RoundRunOptions {
  thread_id: string;
  round_id?: string | null;
  llm?: unknown | null;
  continue_chain?: boolean;
  transports?: unknown[] | null;
}

export async function runRoundEngine(
  runtime: Runtime,
  graphData: Record<string, unknown>,
  state: Record<string, unknown>,
  opts: RoundRunOptions,
): Promise<RunResult> {
  const engine = await buildRoundEngine(runtime, graphData, { llm: opts.llm ?? null });
  const runState: Record<string, unknown> = { ...state };
  if (runState[ROUND_GRAPH_STATE_KEY] === undefined) {
    runState[ROUND_GRAPH_STATE_KEY] = graphData;
  }
  return await engine.ainvoke(runState, {
    thread_id: opts.thread_id,
    round_id: opts.round_id ?? null,
    continue_chain: opts.continue_chain ?? false,
    transports: (opts.transports ?? null) as never,
  });
}
