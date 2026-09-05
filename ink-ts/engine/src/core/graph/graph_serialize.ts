/**
 * Graph 序列化（to_dict / from_dict）与指纹（digest）的纯辅助函数。
 *
 * 与 graph.ts 分离：图结构/校验/注册归 graph.ts，本文件承载数据形态变换
 * （节点/边/schema → dict → 图）与指纹计算——digest 的字段选择与哈希选型
 * 集中在此，方便跨实现核对。
 *
 * 指纹选型说明（FNV-1a 64 hex）：
 * - 跨语言字节等价不保证：Python 引擎已冻为参考实现（用 sha256）；
 * - TS 内部稳定即可：同一定义输入（拓扑/节点/条件/子图/schema）→ 同一指纹；
 * - name 排除（与 Python 对齐：候选图名随排名生成时不得产生不同指纹）；
 * - 函数直挂节点/条件按「<module>.<qualname>」拼接参与指纹；
 * - 选 FNV-1a 而非 node:crypto：core 禁 node:* / 第三方依赖，FNV-1a 纯实现
 *   足够本模块对撞/版本标识用途。
 */

import { NodeContract } from '../contracts/contracts.js';
import { GraphDefinitionError } from '../errors.js';
import { deepCopy, isRecord, typeName } from '../json.js';
import {
  Edge,
  type EdgeConditionRegistryLike,
  fnv1a64Hex,
  type NodeTypeRegistryLike,
  type SchemaSerializable,
} from './graph_types.js';
import type { Graph } from './graph.js';

/** JSON 序列化（稳定键序：与 Python sort_keys=True 对齐）。 */
function stableJsonString(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableJsonString(v)).join(',') + ']';
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + stableJsonString(value[k])).join(',') +
      '}'
    );
  }
  throw new TypeError(`不可 JSON 序列化: ${typeName(value)}`);
}

/** 函数限定名（无 module/qualname = lambda 占位）。 */
function fnRef(fn: unknown): string {
  const f = fn as { __module?: string; __qualname?: string };
  const mod = f.__module ?? '';
  const qn = f.__qualname ?? '<lambda>';
  return `${mod}.${qn}`;
}

function isSerializableSchema(value: unknown): value is SchemaSerializable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { to_dict?: unknown }).to_dict === 'function'
  );
}

function schemaFromData(data: unknown): unknown {
  if (!data) return null;
  if (!isRecord(data)) return data;
  return data;
}

// ── 公开辅助（Graph.to_dict / from_dict / digest 的实现）────────────────────

export function graphToDict(graph: Graph): Record<string, unknown> {
  const nodes: Record<string, Record<string, unknown>> = {};
  const allNames = new Set<string>([
    ...Object.keys(graph.nodes),
    ...Object.keys(graph.node_bindings),
  ]);
  for (const name of allNames) {
    if (graph.subgraphs[name] !== undefined) continue;
    const binding = graph.node_bindings[name];
    if (binding === undefined) {
      throw new GraphDefinitionError(
        `节点 ${name} 未注册类型名，无法序列化（请用 add_node_type 声明）`,
      );
    }
    const out: Record<string, unknown> = {
      type: binding.type_name,
      config: deepCopy(binding.config as Parameters<typeof deepCopy>[0]),
    };
    if (binding.contract !== null) out.contract = binding.contract.to_dict();
    nodes[name] = out;
  }
  const edges: Record<string, Array<{ target: string; condition?: string }>> = {};
  for (const [source, edgeList] of Object.entries(graph.edges)) {
    edges[source] = edgeList.map((e) => e.to_dict());
  }
  let schema: unknown = null;
  if (graph.schema !== null && graph.schema !== undefined) {
    if (!isSerializableSchema(graph.schema)) {
      throw new GraphDefinitionError(
        `图 ${graph.name} 的 schema 不可序列化: ${typeName(graph.schema)}`,
      );
    }
    schema = graph.schema.to_dict();
  }
  const subgraphs: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(graph.subgraphs)) subgraphs[name] = sub.to_dict();
  return {
    name: graph.name,
    entry: graph.entry,
    nodes,
    edges,
    exits: [...graph.exits].sort(),
    subgraphs,
    schema,
  };
}

/**
 * 从 dict 重建 Graph 的纯数据形态装载（不含 resolve/validate；调用方在构造后执行）。
 * Graph 构造函数由调用方注入以打破循环（graph_serialize ↔ graph）。
 */
export function loadGraphFromDict(
  graphCtor: new (init: { name: string; entry: string }) => Graph,
  data: unknown,
  ctx: {
    registry: NodeTypeRegistryLike | null;
    edge_registry: EdgeConditionRegistryLike | null;
    validate: boolean;
  },
): Graph {
  if (!isRecord(data)) {
    throw new GraphDefinitionError(`图定义数据非法: 期望 dict，收到 ${typeName(data)}`);
  }
  const name = data['name'];
  const entry = data['entry'];
  if (typeof name !== 'string' || !name || typeof entry !== 'string' || !entry) {
    throw new GraphDefinitionError('图定义数据缺 name/entry 字段');
  }
  const g = new graphCtor({ name, entry });

  const nodesData = data['nodes'];
  if (nodesData !== null && nodesData !== undefined && !isRecord(nodesData)) {
    throw new GraphDefinitionError(`图定义数据 nodes 字段非法: 期望 dict，收到 ${typeName(nodesData)}`);
  }
  for (const [nodeName, spec] of Object.entries((nodesData ?? {}) as Record<string, unknown>)) {
    if (!isRecord(spec) || !spec['type']) {
      throw new GraphDefinitionError(`节点 ${nodeName} 的类型声明非法`);
    }
    const config = spec['config'] ?? {};
    if (!isRecord(config)) {
      throw new GraphDefinitionError(
        `节点 ${nodeName} 的 config 声明非法: 期望 dict，收到 ${typeName(config)}`,
      );
    }
    const contractData = spec['contract'];
    if (contractData !== null && contractData !== undefined && !isRecord(contractData)) {
      throw new GraphDefinitionError(
        `节点 ${nodeName} 的 contract 声明非法: 期望 dict，收到 ${typeName(contractData)}`,
      );
    }
    const contract =
      contractData !== null && contractData !== undefined ? NodeContract.from_dict(contractData) : null;
    g.add_node_type(
      nodeName,
      spec['type'] as string,
      deepCopy(config as Parameters<typeof deepCopy>[0]) as Record<string, unknown>,
      contract,
    );
  }

  const subgraphsData = data['subgraphs'];
  if (subgraphsData !== null && subgraphsData !== undefined && !isRecord(subgraphsData)) {
    throw new GraphDefinitionError(
      `图定义数据 subgraphs 字段非法: 期望 dict，收到 ${typeName(subgraphsData)}`,
    );
  }
  for (const [subName, subData] of Object.entries((subgraphsData ?? {}) as Record<string, unknown>)) {
    if (!isRecord(subData)) {
      throw new GraphDefinitionError(`子图 ${subName} 定义非法: 期望 dict，收到 ${typeName(subData)}`);
    }
    g.add_subgraph(subName, loadGraphFromDict(graphCtor, subData, ctx));
  }

  const edgesData = data['edges'];
  if (edgesData !== null && edgesData !== undefined && !isRecord(edgesData)) {
    throw new GraphDefinitionError(`图定义数据 edges 字段非法: 期望 dict，收到 ${typeName(edgesData)}`);
  }
  for (const [source, edgeList] of Object.entries((edgesData ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(edgeList)) {
      throw new GraphDefinitionError(`节点 ${source} 的边声明非法: 期望 list，收到 ${typeName(edgeList)}`);
    }
    for (const edgeData of edgeList) {
      if (!isRecord(edgeData)) {
        throw new GraphDefinitionError(
          `节点 ${source} 的边声明非法: 期望 dict，收到 ${typeName(edgeData)}`,
        );
      }
      const target = edgeData['target'];
      if (typeof target !== 'string') {
        throw new GraphDefinitionError(`节点 ${source} 的边声明非法（缺 target）`);
      }
      const conditionName = edgeData['condition'];
      if (conditionName === null || conditionName === undefined) {
        g.add_edge(source, target);
      } else if (typeof conditionName === 'string') {
        if (ctx.edge_registry === null || !ctx.edge_registry.has(conditionName)) {
          throw new GraphDefinitionError(
            `条件边 ${source}->${target} 的条件未注册: ${conditionName}`,
          );
        }
        g.add_conditional_edge_by_name(source, target, conditionName);
      } else {
        throw new GraphDefinitionError(
          `节点 ${source} 的边 condition 字段类型非法: 期望 str`,
        );
      }
    }
  }

  const exitsData = data['exits'];
  if (exitsData !== null && exitsData !== undefined && !Array.isArray(exitsData)) {
    throw new GraphDefinitionError(`图定义数据 exits 字段非法: 期望 list，收到 ${typeName(exitsData)}`);
  }
  for (const e of (exitsData ?? []) as string[]) g.exits.add(e);

  g.schema = schemaFromData(data['schema']);
  return g;
}

/** 计算图指纹（name 排除；递归子图；FNV-1a 64 hex）。 */
export function graphDigest(graph: Graph): string {
  const nodeRef = (name: string): string => {
    const binding = graph.node_bindings[name];
    if (binding !== undefined) {
      try {
        const payload: Record<string, unknown> = {
          type: binding.type_name,
          config: binding.config,
        };
        if (binding.contract !== null) payload.contract = binding.contract.to_dict();
        return stableJsonString(payload);
      } catch (e) {
        throw new GraphDefinitionError(`节点 ${name} 的 config 不可 JSON 序列化: ${String(e)}`);
      }
    }
    return fnRef(graph.nodes[name]);
  };

  const edgeRef = (edge: Edge): string => {
    if (edge.condition !== null || edge.condition_name !== null) {
      const key = edge.condition_name !== null ? edge.condition_name : fnRef(edge.condition);
      return stableJsonString({ target: edge.target, condition: key });
    }
    return stableJsonString({ target: edge.target });
  };

  const nodeKeys = new Set<string>([
    ...Object.keys(graph.nodes),
    ...Object.keys(graph.node_bindings),
  ]);
  const nodesPayload: Record<string, string> = {};
  for (const name of nodeKeys) {
    if (graph.subgraphs[name] !== undefined) continue;
    nodesPayload[name] = nodeRef(name);
  }

  const edgesPayload: Record<string, string[]> = {};
  for (const [source, edgeList] of Object.entries(graph.edges)) {
    edgesPayload[source] = edgeList.map(edgeRef);
  }

  const subgraphsPayload: Record<string, string> = {};
  for (const [name, sub] of Object.entries(graph.subgraphs)) subgraphsPayload[name] = sub.digest();

  const schemaPayload =
    graph.schema !== null && graph.schema !== undefined
      ? isSerializableSchema(graph.schema)
        ? graph.schema.to_dict()
        : String(graph.schema)
      : null;

  const payload = {
    entry: graph.entry,
    nodes: nodesPayload,
    edges: edgesPayload,
    exits: [...graph.exits].sort(),
    subgraphs: subgraphsPayload,
    schema: schemaPayload,
  };
  return fnv1a64Hex(stableJsonString(payload));
}