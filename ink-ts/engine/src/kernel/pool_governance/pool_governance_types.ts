/**
 * 结点池治理域的数据形态（pool_governance.py 移植）。
 *
 * 治理判定以「提案 + 池快照」为纯输入，产出登记记录（只登记不执行）：
 * - PoolNodeSnapshot：池内结点快照，判定的输入数据（调用方汇总，只读）；
 * - GovernanceVerdict：一次判定的登记（verdict/reasons/eviction_required/
 *   eviction_candidates/merge_target/budget_remaining），宿主据既有评审
 *   通道裁决是否采纳；
 * - 时间 seam：登记时间戳由宿主注入时钟（等价 Python time.time），缺省
 *   确定值 0——core 零 IO 可复现（沿 ledger 的时间注入先例）。
 *
 * 另含池治理对「结点类型注册表」的最小读接口：pool_nodes_from_registry
 * 只消费 types()/contract_for() 与契约产出 schema 的字段名集合，不带入
 * 注册表实现语义。
 */

/** 池内结点快照的构造输入（判定数据；宽松键，缺省取默认值）。 */
export interface PoolNodeSnapshotInit {
  node_id: string;
  usage_count?: number;
  promoted?: boolean;
  age_days?: number;
  fields?: readonly string[];
  domain?: string;
}

/**
 * 池内结点快照（治理判定的输入；字段集 = 契约产出字段名，Jaccard 判定面）。
 * 只读数据形态，等价 Python frozen dataclass。
 */
export class PoolNodeSnapshot {
  readonly node_id: string;
  readonly usage_count: number;
  readonly promoted: boolean;
  readonly age_days: number;
  readonly fields: readonly string[];
  readonly domain: string;

  constructor(init: PoolNodeSnapshotInit) {
    this.node_id = init.node_id;
    this.usage_count = init.usage_count ?? 0;
    this.promoted = init.promoted ?? false;
    this.age_days = init.age_days ?? 0;
    this.fields = init.fields ?? [];
    this.domain = init.domain ?? 'default';
  }
}

/** 治理判定记录的构造输入（verdict 必填，其余宽松取缺省）。 */
export interface GovernanceVerdictInit {
  verdict: string;
  reasons?: readonly string[];
  eviction_required?: boolean;
  eviction_candidates?: readonly string[];
  merge_target?: string;
  budget_remaining?: number;
}

/**
 * 治理判定记录（只登记不执行；宿主据此走既有评审通道）。
 *
 * verdict：allow（放行评审）/ reject（拒绝）/ merge（转合并提案）；
 * reasons：判定原因清单（可审计可展示）；eviction_required：容量满时
 * 是否须携带淘汰候选；eviction_candidates：死结点淘汰候选清单（标记
 * 失效登记依据）；merge_target：近重复命中的池内结点 id（merge 时非空）；
 * budget_remaining：本周提案余量（0 = 预算耗尽）。
 */
export class GovernanceVerdict {
  readonly verdict: string;
  readonly reasons: readonly string[];
  readonly eviction_required: boolean;
  readonly eviction_candidates: readonly string[];
  readonly merge_target: string;
  readonly budget_remaining: number;

  constructor(init: GovernanceVerdictInit) {
    this.verdict = init.verdict;
    this.reasons = init.reasons ?? [];
    this.eviction_required = init.eviction_required ?? false;
    this.eviction_candidates = init.eviction_candidates ?? [];
    this.merge_target = init.merge_target ?? '';
    this.budget_remaining = init.budget_remaining ?? 0;
  }

  /** 序列化为登记记录形态（清单出拷贝，可审计可落 JSON）。 */
  to_dict(): Record<string, unknown> {
    return {
      verdict: this.verdict,
      reasons: [...this.reasons],
      eviction_required: this.eviction_required,
      eviction_candidates: [...this.eviction_candidates],
      merge_target: this.merge_target,
      budget_remaining: this.budget_remaining,
    };
  }
}

/** 时间 seam：宿主注入等价 time.time 的时钟（缺省确定值 0）。 */
export type TimeSource = () => number;

/** 登记器注入面：时间 seam（evaluate 逐条登记时取时）。 */
export interface PoolGovernanceOptions {
  now?: TimeSource;
}

/** 提案综合判定的池快照（pool_nodes 已归一为快照对象形态）。 */
export interface ProposalSnapshot {
  pool_count: number;
  used_this_week: number;
  pool_nodes?: readonly PoolNodeSnapshot[];
  duplicate_cosine?: number;
}

/** evaluate_proposal 的阈值旋钮（缺省取模块常量）。 */
export interface ProposalKnobs {
  capacity?: number;
  weekly_budget?: number;
}

/** 登记器 evaluate 的宽松快照形态（结点可为快照对象或 dict）。 */
export interface PoolSnapshotInput {
  pool_count?: number;
  used_this_week?: number;
  pool_nodes?: ReadonlyArray<PoolNodeSnapshot | PoolNodeSnapshotInit>;
  duplicate_cosine?: number;
}

/** 契约读形态：治理只消费产出 schema（其余字段不解释）。 */
export interface GovernanceContractShape {
  readonly output_schema?: unknown;
}

/**
 * 池治理对结点类型注册表的最小读接口：迭代类型名 + 按名取契约。
 * 注册表实现（NodeTypeRegistry 等）结构满足即可，不做类型强绑定。
 */
export interface GovernanceRegistry {
  types(): readonly string[];
  contract_for(type_name: string): GovernanceContractShape | null | undefined;
}
