/**
 * 图定义 DSL 的核心类型与 seam 形态（core/graph.py 的类型面移植）。
 *
 * - NodeFn / EdgeCondition：节点执行函数与条件边判定函数。执行器接 seam，
 *   本模块只持有不透明引用、不解释含义。
 * - Edge：静态边 / 条件边（按判定函数 / 按条件名）。条件名是声明式图定义
 *   数据里的可序列化形态，函数本身不是数据——挂函数的条件边必须带条件名
 *   才能 to_dict。
 * - NodeBinding：声明式节点绑定（节点名 → 注册类型名 + 配置 + 契约）。
 *   声明式 = 可序列化 = 随 checkpoint/harness 仓库持久化。
 * - TerminateReason：回合终止原因枚举（轨迹/审计一致语义，防魔法值）。
 *
 * digest 选择：内部纯 FNV-1a 64 hex（fnv1a64Hex）。Python 用 sha256，跨语言
 * 字节等价不保证（Python 引擎已冻为参考实现），TS 内部稳定即可：
 * 同一定义输入（拓扑/节点/条件/子图/schema）→ 同一指纹；name 排除；
 * 函数直挂节点/条件按「<module>.<qualname>」拼接形式参与指纹，缺 __qualname__
 * 退化为占位字符串（lambda 仍会因拓扑变化改变指纹，仅同拓扑实现替换不敏感）。
 */

import type { NodeContract } from '../contracts/contracts.js';

// ── seam：节点执行函数 / 条件判定函数 ───────────────────────────────────────
// 图定义数据里节点按类型名引用、条件边按条件名引用，建图/重放时由注册表
// 按名解析。直挂函数（图手绘期使用）走 add_node/add_conditional_edge，函数
// 实例不进入图定义数据。

export type NodeFn = (
  ctx: unknown,
) => Record<string, unknown> | Promise<Record<string, unknown> | null> | null;

export type EdgeCondition = (ctx: unknown) => boolean | Promise<boolean>;

/** 节点运行时上下文（执行器注入；图模块仅按不透明 seam 持有）。 */
export interface NodeContextLike {
  readonly state: Record<string, unknown>;
  readonly graph_path: readonly string[];
  readonly round_id: string | null;
  readonly trace_id: string;
  emit(etype: string, payload: Record<string, unknown>, step_id?: string): Promise<void>;
  interrupt(review_key: string, payload: Record<string, unknown>): Promise<unknown>;
  get_interrupt_payload(review_key: string): Record<string, unknown> | null;
  spawn(subgraph: unknown, state: Record<string, unknown>, index?: number | null): void;
  assemble(
    sources: unknown[],
    opts?: { total_budget?: number | null; version_snapshot?: Record<string, unknown> | null },
  ): Promise<unknown>;
  preassemble(): Promise<void>;
  account_usage(usage: Record<string, unknown> | null): void;
  terminate(reason: string, meta?: Record<string, unknown>): void;
  readonly terminated: boolean;
}

// ── 终止原因枚举 ────────────────────────────────────────────────────────────

export class TerminateReason {
  static readonly REPLY = 'reply';
  static readonly STOP = 'stop';
  static readonly BUDGET_EXCEEDED = 'budget_exceeded';
  static readonly ERROR = 'error';
  static readonly CANCELLED = 'cancelled';
  private static readonly _ALL: readonly string[] = [
    TerminateReason.REPLY,
    TerminateReason.STOP,
    TerminateReason.BUDGET_EXCEEDED,
    TerminateReason.ERROR,
    TerminateReason.CANCELLED,
  ];
  static is_valid(reason: string): boolean {
    return TerminateReason._ALL.includes(reason);
  }
  private constructor() {}
}

// ── 边：静态边 / 条件边 ──────────────────────────────────────────────────────

export class Edge {
  readonly target: string;
  readonly condition: EdgeCondition | null;
  readonly condition_name: string | null;

  constructor(init: { target: string; condition?: EdgeCondition | null; condition_name?: string | null }) {
    this.target = init.target;
    this.condition = init.condition ?? null;
    this.condition_name = init.condition_name ?? null;
    Object.freeze(this);
  }

  /** 序列化：条件边必须携带条件名（函数本身不是数据）。 */
  to_dict(): { target: string; condition?: string } {
    if (this.condition !== null && this.condition_name === null) {
      throw new Error(
        `条件边 -> ${this.target} 未注册条件名，无法序列化（请用 add_conditional_edge_by_name 声明）`,
      );
    }
    const out: { target: string; condition?: string } = { target: this.target };
    if (this.condition_name !== null) out.condition = this.condition_name;
    return out;
  }
}

// ── 节点类型注册表 / 条件注册表的 seam 类型 ──────────────────────────────────
// 图模块不直接依赖 registry（依赖反向不必要）；建图期通过参数注入。

export interface NodeTypeRegistryLike {
  create(type_name: string, config: Record<string, unknown>): NodeFn;
}

export interface EdgeConditionRegistryLike {
  has(name: string): boolean;
  create(name: string): EdgeCondition;
}

// ── 节点绑定（声明式） ──────────────────────────────────────────────────────

export class NodeBinding {
  readonly type_name: string;
  readonly config: Record<string, unknown>;
  readonly contract: NodeContract | null;

  constructor(init: { type_name: string; config: Record<string, unknown>; contract: NodeContract | null }) {
    this.type_name = init.type_name;
    this.config = init.config;
    this.contract = init.contract;
    Object.freeze(this);
  }
}

// ── 图 schema 不透明形态 ────────────────────────────────────────────────────
// schema 是 StateSchema 或其他不透明形态（建图期只读序列化结果，不实例化）。

export interface SchemaSerializable {
  to_dict(): unknown;
}

// ── 纯字符串哈希（FNV-1a 64）────────────────────────────────────────────────

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x1000000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64 位纯字符串哈希（无 node:crypto 依赖，core 零内置）。 */
export function fnv1a64Hex(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}