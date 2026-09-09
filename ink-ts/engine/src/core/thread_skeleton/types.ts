/**
 * 会话级骨架数据形态（thread 级执行结构；P4 §4.0/§4.1 数据面）。
 *
 * 骨架 = 会话尺度数据（非资产）：thread 级图（节点实例/边实例引用池内已登记
 * 类型名）+ 入口/出口/当前目标（active_target）+ 状态，随该 thread checkpoint
 * state 落库恢复——与资产层分离：本形态只携带对池内类型的**引用**（type 名），
 * 不携带任何类型定义/实体/技能/边先验（那些只能经受控通道持久入资产层，见
 * P4 §4.2「进化即留存」）。执行体解析仍走既有注册表（骨架只是数据，执行沿
 * 骨架推进时由 runtime 按图数据重建引擎）。
 *
 * 序列化纪律与图数据对齐：节点实例 = {type, config?, contract?}（引用池类型）；
 * 边实例 = {target, condition?, kind?}，其中 standard/conditional 由 condition
 * 存在性推导，仅 loop 显式输出 kind——与 Graph 序列化口径一致，防 digest 漂移。
 */

import { isRecord } from '../json.js';

/** 会话级骨架状态（active=沿骨架推进可用；evolving=回合内被自修改工具改写，
 *  下一回合起点须经校验后归一回 active 才能沿骨架执行）。 */
export type ThreadSkeletonStatus = 'active' | 'evolving';

/** 会话级骨架数据形态版本（未来字段演进只增键；解析按版本回落当前语义）。 */
export const THREAD_SKELETON_VERSION = 1;

/** 会话级骨架随回合 checkpoint state 落库的保留键（线程尺度会话数据；不属
 *  任何受守卫演化资产集合——资产只经补丁链/GuardedStorage/EvolutionWriter）。 */
export const THREAD_SKELETON_STATE_KEY = '_thread_skeleton';

/** 结点实例声明（节点实例引用池内已登记类型；config/contract 为可选数据）。 */
export interface SkeletonNodeSpec {
  type: string;
  config?: Record<string, unknown>;
  contract?: Record<string, unknown>;
}

/** 边实例声明（target 必须、condition 引用已注册条件名；kind=loop 显式）。 */
export interface SkeletonEdgeSpec {
  target: string;
  condition?: string;
  kind?: 'loop';
}

/** 会话级骨架（thread 级图数据 + 会话元信息）。实例可变（updated_at/status 由
 *  runtime 回合边界归一），节点/边/出口只读语义经封装访问。 */
export class ThreadSkeleton {
  readonly version: number;
  readonly thread_id: string;
  status: ThreadSkeletonStatus;
  readonly entry: string;
  readonly nodes: Record<string, SkeletonNodeSpec>;
  readonly edges: Record<string, SkeletonEdgeSpec[]>;
  readonly exits: string[];
  /** 当前目标/游标（本会话正在推进的目标节点 id；null = 沿骨架自由推进到出口）。 */
  readonly active_target: string | null;
  readonly created_at: number;
  updated_at: number;

  constructor(init: {
    thread_id: string;
    entry: string;
    nodes: Record<string, SkeletonNodeSpec>;
    status?: ThreadSkeletonStatus;
    edges?: Record<string, SkeletonEdgeSpec[]>;
    exits?: readonly string[];
    active_target?: string | null;
    created_at?: number;
    updated_at?: number;
    version?: number;
  }) {
    this.version = init.version ?? THREAD_SKELETON_VERSION;
    this.thread_id = init.thread_id;
    this.entry = init.entry;
    this.nodes = { ...init.nodes };
    this.edges = {};
    for (const [from, list] of Object.entries(init.edges ?? {})) {
      this.edges[from] = list.map((e) => ({ ...e }));
    }
    this.exits = [...(init.exits ?? [])];
    this.status = init.status ?? 'active';
    this.active_target = init.active_target ?? null;
    this.created_at = init.created_at ?? 0;
    this.updated_at = init.updated_at ?? this.created_at;
  }

  /** 骨架引用的池内类型名（去重、插入序；执行体解析沿注册表走）。 */
  node_types(): readonly string[] {
    const seen: string[] = [];
    for (const spec of Object.values(this.nodes)) {
      if (!seen.includes(spec.type)) seen.push(spec.type);
    }
    return seen;
  }

  /** 序列化为数据形态（只含 JSON 数据；经 checkpoint state 落库/恢复）。 */
  to_dict(): Record<string, unknown> {
    const nodes: Record<string, Record<string, unknown>> = {};
    for (const [id, spec] of Object.entries(this.nodes)) {
      const out: Record<string, unknown> = { type: spec.type };
      if (spec.config !== undefined && spec.config !== null) out['config'] = { ...spec.config };
      if (spec.contract !== undefined && spec.contract !== null) out['contract'] = { ...spec.contract };
      nodes[id] = out;
    }
    const edges: Record<string, Array<Record<string, unknown>>> = {};
    for (const [from, list] of Object.entries(this.edges)) {
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
      version: this.version,
      thread_id: this.thread_id,
      status: this.status,
      entry: this.entry,
      nodes,
      edges,
      exits: [...this.exits],
      active_target: this.active_target,
      created_at: this.created_at,
      updated_at: this.updated_at,
    };
  }

  /** 反序列化（缺省键回落默认；畸形行抛错由调用方按骨架失效处理）。 */
  static from_dict(data: unknown): ThreadSkeleton {
    if (!isRecord(data)) {
      throw new Error(`会话级骨架非法: 期望 dict，收到 ${typeof data}`);
    }
    const thread_id = data['thread_id'];
    if (typeof thread_id !== 'string' || thread_id === '') {
      throw new Error('会话级骨架缺 thread_id');
    }
    const entry = data['entry'];
    if (typeof entry !== 'string' || entry === '') {
      throw new Error('会话级骨架缺 entry');
    }
    const rawNodes = data['nodes'];
    if (!isRecord(rawNodes) || Object.keys(rawNodes).length === 0) {
      throw new Error('会话级骨架缺 nodes（非空 dict）');
    }
    const nodes: Record<string, SkeletonNodeSpec> = {};
    for (const [id, spec] of Object.entries(rawNodes)) {
      if (!isRecord(spec)) {
        throw new Error(`骨架节点 ${id} 非法（期望 dict）`);
      }
      const type = spec['type'];
      if (typeof type !== 'string' || type === '') {
        throw new Error(`骨架节点 ${id} 缺 type（须为池内类型名）`);
      }
      const config = spec['config'];
      if (config !== undefined && config !== null && !isRecord(config)) {
        throw new Error(`骨架节点 ${id} 的 config 非法（期望 dict）`);
      }
      const contract = spec['contract'];
      if (contract !== undefined && contract !== null && !isRecord(contract)) {
        throw new Error(`骨架节点 ${id} 的 contract 非法（期望 dict）`);
      }
      nodes[id] = {
        type: type as string,
        ...(config === undefined || config === null ? {} : { config: { ...(config as Record<string, unknown>) } }),
        ...(contract === undefined || contract === null
          ? {}
          : { contract: { ...(contract as Record<string, unknown>) } }),
      };
    }
    const edges: Record<string, SkeletonEdgeSpec[]> = {};
    const rawEdges = data['edges'];
    if (rawEdges !== undefined && rawEdges !== null) {
      if (!isRecord(rawEdges)) {
        throw new Error('会话级骨架 edges 非法（期望 dict）');
      }
      for (const [from, list] of Object.entries(rawEdges)) {
        if (!Array.isArray(list)) {
          throw new Error(`骨架节点 ${from} 的边非法（期望 list）`);
        }
        const out: SkeletonEdgeSpec[] = [];
        for (const raw of list) {
          if (!isRecord(raw)) {
            throw new Error(`骨架节点 ${from} 的边非法（期望 dict）`);
          }
          const target = raw['target'];
          if (typeof target !== 'string' || target === '') {
            throw new Error(`骨架节点 ${from} 的边缺 target`);
          }
          const kind = raw['kind'];
          if (kind !== undefined && kind !== null && kind !== 'loop') {
            throw new Error(`骨架节点 ${from}->${target} 的边 kind 非法（仅 loop 显式）`);
          }
          const condition = raw['condition'];
          if (condition !== undefined && condition !== null && typeof condition !== 'string') {
            throw new Error(`骨架节点 ${from}->${target} 的 condition 非法（期望 str）`);
          }
          out.push({
            target: target as string,
            ...(condition === undefined || condition === null
              ? {}
              : { condition: condition as string }),
            ...(kind === 'loop' ? { kind: 'loop' as const } : {}),
          });
        }
        edges[from] = out;
      }
    }
    const rawExits = data['exits'];
    const exits: string[] = [];
    if (rawExits !== undefined && rawExits !== null) {
      if (!Array.isArray(rawExits)) {
        throw new Error('会话级骨架 exits 非法（期望 list）');
      }
      for (const exit of rawExits) {
        if (typeof exit !== 'string' || exit === '') {
          throw new Error('会话级骨架 exits 含非法项（期望 str）');
        }
        exits.push(exit as string);
      }
    }
    const status = data['status'];
    if (status !== undefined && status !== null && status !== 'active' && status !== 'evolving') {
      throw new Error(`会话级骨架 status 非法: ${String(status)}（期望 active/evolving）`);
    }
    const activeTarget = data['active_target'];
    if (activeTarget !== undefined && activeTarget !== null && typeof activeTarget !== 'string') {
      throw new Error('会话级骨架 active_target 非法（期望 str/null）');
    }
    return new ThreadSkeleton({
      thread_id,
      entry,
      nodes,
      edges,
      exits,
      status: (status as ThreadSkeletonStatus | null | undefined) ?? 'active',
      active_target: (activeTarget as string | null | undefined) ?? null,
      created_at: Number(data['created_at'] ?? 0),
      updated_at: Number(data['updated_at'] ?? data['created_at'] ?? 0),
      version: Number(data['version'] ?? THREAD_SKELETON_VERSION),
    });
  }
}
