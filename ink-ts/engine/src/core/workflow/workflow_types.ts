/**
 * 声明式工作流规格的类型定义（镜像 core/workflow.py 的 dataclass）。
 *
 * 工作流把节点描述为「类型名 + 配置」的数据形态，建图时由注册表按类型名
 * 解析为执行函数。节点/边仅携带声明式数据，不含执行语义。
 */

// ── 节点声明 ────────────────────────────────────────────────────────────────

export interface WorkflowNodeSpecInit {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

/** 工作流节点声明（类型 + 配置，建图时实例化执行函数）。 */
export class WorkflowNodeSpec {
  readonly id: string;
  readonly type: string;
  readonly config: Record<string, unknown>;

  constructor(init: WorkflowNodeSpecInit) {
    this.id = init.id;
    this.type = init.type;
    this.config = init.config ?? {};
  }
}

// ── 边声明 ────────────────────────────────────────────────────────────────────

export interface WorkflowEdgeSpecInit {
  source: string;
  target: string;
}

/** 工作流边声明（来源节点 → 目标节点）。 */
export class WorkflowEdgeSpec {
  readonly source: string;
  readonly target: string;

  constructor(init: WorkflowEdgeSpecInit) {
    this.source = init.source;
    this.target = init.target;
  }
}

// ── 规格 ──────────────────────────────────────────────────────────────────────

export interface WorkflowSpecInit {
  name: string;
  nodes?: WorkflowNodeSpec[];
  edges?: WorkflowEdgeSpec[];
  entry?: string | null;
}

/**
 * 工作流规格：节点清单 + 边清单 + 可选显式入口。
 *
 * entry 缺省时按「唯一无入边节点」推断；多个无入边节点须显式指定入口，
 * 且入口须能到达全部节点（不可达节点建图期拒绝）。
 */
export class WorkflowSpec {
  readonly name: string;
  readonly nodes: readonly WorkflowNodeSpec[];
  readonly edges: readonly WorkflowEdgeSpec[];
  readonly entry: string | null;

  constructor(init: WorkflowSpecInit) {
    this.name = init.name;
    this.nodes = init.nodes ?? [];
    this.edges = init.edges ?? [];
    this.entry = init.entry ?? null;
  }
}
