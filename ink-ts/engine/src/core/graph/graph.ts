/**
 * 图定义 DSL（数据驱动）。core/graph.py 移植。
 *
 * Graph{nodes, edges, entry, exits, subgraphs, node_bindings, schema}：
 * - 节点可以「函数直挂」（add_node，进程内）或「声明式绑定」（add_node_type，
 *   按类型名引用、可序列化/随仓库导出）。
 * - 边可以「静态边」或「条件边」（挂函数 = 进程内形态；按条件名 = 声明式形态）。
 * - 嵌套图：子图以图实例挂为节点，执行时入路径栈（graph_path 显式记录）。
 *
 * 本文件承载图实例结构、节点/边注册、声明式解析与编译校验；序列化与指纹
 * 形态在 graph_serialize.ts，节点/边/契约/终止原因等类型形态在 graph_types.ts。
 */

import { NodeContract } from '../contracts/contracts.js';
import { EngineError, GraphDefinitionError, NodeNotFoundError } from '../errors.js';
import { deepCopy } from '../json.js';
import {
  Edge,
  type EdgeCondition,
  type EdgeConditionRegistryLike,
  NodeBinding,
  type NodeFn,
  type NodeTypeRegistryLike,
} from './graph_types.js';
import { graphDigest, graphToDict, loadGraphFromDict } from './graph_serialize.js';

// ── 编译产物 ────────────────────────────────────────────────────────────────

export class CompiledGraph {
  constructor(public readonly graph: Graph) {
    Object.freeze(this);
  }
}

// ── Graph 主类 ──────────────────────────────────────────────────────────────

export interface GraphInit {
  name: string;
  entry: string;
  nodes?: Record<string, NodeFn>;
  edges?: Record<string, Edge[]>;
  exits?: string[] | Set<string>;
  subgraphs?: Record<string, Graph>;
  schema?: unknown;
  node_bindings?: Record<string, NodeBinding>;
}

export class Graph {
  readonly name: string;
  entry: string;
  readonly nodes: Record<string, NodeFn>;
  readonly edges: Record<string, Edge[]>;
  readonly exits: Set<string>;
  readonly subgraphs: Record<string, Graph>;
  schema: unknown;
  readonly node_bindings: Record<string, NodeBinding>;

  constructor(init: GraphInit) {
    this.name = init.name;
    this.entry = init.entry;
    this.nodes = init.nodes ? { ...init.nodes } : {};
    this.edges = init.edges ? { ...init.edges } : {};
    this.exits = init.exits ? new Set<string>(init.exits) : new Set<string>();
    this.subgraphs = init.subgraphs ? { ...init.subgraphs } : {};
    this.schema = init.schema ?? null;
    this.node_bindings = init.node_bindings ? { ...init.node_bindings } : {};
  }

  // ── 节点 / 边 / 出口 / 子图 注册 ────────────────────────────────────────

  add_node(name: string, fn: NodeFn): void {
    if (
      this.nodes[name] !== undefined ||
      this.node_bindings[name] !== undefined ||
      this.subgraphs[name] !== undefined
    ) {
      throw new GraphDefinitionError(`节点名冲突: ${name}`);
    }
    this.nodes[name] = fn;
  }

  add_node_type(
    name: string,
    type_name: string,
    config: Record<string, unknown> | null = null,
    contract: NodeContract | null = null,
  ): void {
    if (this.nodes[name] !== undefined || this.subgraphs[name] !== undefined) {
      throw new GraphDefinitionError(`节点名冲突: ${name}`);
    }
    if (!type_name) {
      throw new GraphDefinitionError(`节点 ${name} 的类型名不能为空`);
    }
    this.node_bindings[name] = new NodeBinding({
      type_name,
      config: deepCopy((config ?? {}) as Parameters<typeof deepCopy>[0]) as Record<string, unknown>,
      contract,
    });
  }

  add_edge(source: string, target: string): void {
    if (!this.edges[source]) this.edges[source] = [];
    this.edges[source].push(new Edge({ target }));
  }

  add_conditional_edge(source: string, target: string, condition: EdgeCondition): void {
    if (!this.edges[source]) this.edges[source] = [];
    this.edges[source].push(new Edge({ target, condition }));
  }

  add_conditional_edge_by_name(source: string, target: string, condition_name: string): void {
    if (!condition_name) {
      throw new GraphDefinitionError(`条件边 ${source}->${target} 的条件名不能为空`);
    }
    if (!this.edges[source]) this.edges[source] = [];
    this.edges[source].push(new Edge({ target, condition_name }));
  }

  add_exit(name: string): void {
    this.exits.add(name);
  }

  add_subgraph(name: string, graph: Graph): void {
    if (this.nodes[name] !== undefined || this.node_bindings[name] !== undefined) {
      throw new GraphDefinitionError(`节点名冲突: ${name}`);
    }
    this.subgraphs[name] = graph;
    // 嵌套图 runner 由执行器接管：本模块不在 nodes 登记占位函数（执行语义归执行器）。
  }

  // ── 解析：声明式绑定 / 按名条件边 → 函数实例 ──────────────────────────────

  resolve_types(registry: NodeTypeRegistryLike | null = null): void {
    for (const sub of Object.values(this.subgraphs)) sub.resolve_types(registry);
    if (Object.keys(this.node_bindings).length === 0) return;
    if (registry === null) {
      throw new GraphDefinitionError(`图 ${this.name} 含未解析的声明式节点，需注入节点注册表`);
    }
    for (const [name, binding] of Object.entries(this.node_bindings)) {
      if (this.nodes[name] === undefined) {
        this.nodes[name] = registry.create(binding.type_name, binding.config);
      }
    }
  }

  resolve_conditions(edge_registry: EdgeConditionRegistryLike | null = null): void {
    for (const sub of Object.values(this.subgraphs)) sub.resolve_conditions(edge_registry);
    const pending: Array<{ source: string; edge: Edge }> = [];
    for (const [source, edgeList] of Object.entries(this.edges)) {
      for (const edge of edgeList) {
        if (edge.condition_name !== null && edge.condition === null) pending.push({ source, edge });
      }
    }
    if (pending.length === 0) return;
    if (edge_registry === null) {
      const list = pending
        .map(({ source, edge }) => `${source}->${edge!.target}`)
        .join(', ');
      throw new GraphDefinitionError(
        `图 ${this.name} 含未解析的条件边，需注入条件注册表: ${list}`,
      );
    }
    // 按位置直接替换（不依赖 dataclass 相等比较）：同源多条件边不会首条错替。
    for (const edgeList of Object.values(this.edges)) {
      for (let i = 0; i < edgeList.length; i++) {
        const edge = edgeList[i]!;
        if (edge.condition_name === null || edge.condition !== null) continue;
        edgeList[i] = new Edge({
          target: edge.target,
          condition: edge_registry.create(edge.condition_name),
          condition_name: edge.condition_name,
        });
      }
    }
  }

  // ── 序列化 / 反序列化 / 指纹 ──────────────────────────────────────────────

  to_dict(): Record<string, unknown> {
    return graphToDict(this);
  }

  static from_dict(
    data: unknown,
    opts: {
      registry?: NodeTypeRegistryLike | null;
      edge_registry?: EdgeConditionRegistryLike | null;
      validate?: boolean;
    } = {},
  ): Graph {
    const { registry = null, edge_registry = null, validate = false } = opts;
    const g = loadGraphFromDict(Graph, data, { registry, edge_registry, validate });
    g.resolve_conditions(edge_registry);
    g.resolve_types(registry);
    if (validate) g.compile();
    return g;
  }

  digest(): string {
    return graphDigest(this);
  }

  // ── 编译校验 ─────────────────────────────────────────────────────────────

  compile(): CompiledGraph {
    if (this.nodes[this.entry] === undefined && this.subgraphs[this.entry] === undefined) {
      throw new GraphDefinitionError(`入口节点不存在: ${this.entry}`);
    }
    for (const [source, edgeList] of Object.entries(this.edges)) {
      if (this.nodes[source] === undefined) {
        throw new NodeNotFoundError(source);
      }
      for (const edge of edgeList) {
        if (edge.condition_name !== null && edge.condition === null) {
          throw new GraphDefinitionError(
            `条件边 ${source}->${edge.target} 未解析（按名声明需注入条件注册表并调用 resolve_conditions）`,
          );
        }
      }
      const hasStatic = edgeList.some((e) => e.condition === null);
      const hasConditional = edgeList.some((e) => e.condition !== null);
      if (hasStatic && hasConditional) {
        throw new GraphDefinitionError(
          `节点 ${source} 静态边与条件边混用：静态边优先会闷杀条件边，请拆分节点或统一为条件边`,
        );
      }
      for (const edge of edgeList) {
        if (this.nodes[edge.target] === undefined) {
          throw new NodeNotFoundError(edge.target);
        }
      }
    }
    for (const name of this.exits) {
      if (this.nodes[name] === undefined) {
        throw new NodeNotFoundError(name);
      }
    }
    for (const [name, sub] of Object.entries(this.subgraphs)) {
      try {
        sub.compile();
      } catch (e) {
        if (e instanceof EngineError) {
          throw new GraphDefinitionError(`子图 ${name} 校验失败: ${e.message}`);
        }
        throw e;
      }
    }
    return new CompiledGraph(this);
  }
}