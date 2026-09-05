/**
 * 结点池治理（容量/淘汰/合并/预算四条规则；只判定登记不执行决策）。
 *
 * 规则判定纯函数见 pool_governance_rules.js；本文件承载登记面：
 *
 * - PoolGovernance 登记器：调用纯规则判定并把登记记录 append-only 落 log
 *   （宿主按既有评审通道裁决是否采纳；判定与登记同源，不执行任何动作）；
 * - weekly_proposal_usage：周预算的「已用」口径（登记历史窗口计数）；
 * - proposal_from_node_draft / pool_nodes_from_registry：生产接线辅助
 *   （失败点提案归一 / 注册表 → 治理快照结点清单）。
 *
 * 本模块无 I/O、无 LLM——判定输入为池快照（调用方提供），输出为登记记录。
 * 时间戳为副作用：登记器经构造注入时钟（等价 Python time.time），周预算
 * now 数值缺省确定值 0——core 零 IO 可复现（沿 ledger 时间 seam 先例）。
 */

import { isRecord } from '../json.js';
import { GovernanceVerdict, PoolNodeSnapshot } from './pool_governance_types.js';
import type {
  GovernanceContractShape,
  GovernanceRegistry,
  GovernanceVerdictInit,
  PoolGovernanceOptions,
  PoolNodeSnapshotInit,
  PoolSnapshotInput,
  ProposalKnobs,
  ProposalSnapshot,
  TimeSource,
} from './pool_governance_types.js';
import {
  DEAD_NODE_MIN_AGE_DAYS,
  GOV_INVALIDATE,
  GOV_VERDICT_ALLOW,
  GOV_VERDICT_MERGE,
  GOV_VERDICT_REJECT,
  MERGE_COSINE_THRESHOLD,
  MERGE_JACCARD_THRESHOLD,
  POOL_CAPACITY_MAX,
  PROPOSAL_WEEKLY_BUDGET,
  at_capacity,
  dead_node_eligible,
  evaluate_proposal,
  fields_jaccard,
  invalidation_record,
  near_duplicate_by_embedding,
  near_duplicate_by_fields,
  proposal_budget_remaining,
} from './pool_governance_rules.js';

export {
  DEAD_NODE_MIN_AGE_DAYS,
  GOV_INVALIDATE,
  GOV_VERDICT_ALLOW,
  GOV_VERDICT_MERGE,
  GOV_VERDICT_REJECT,
  MERGE_COSINE_THRESHOLD,
  MERGE_JACCARD_THRESHOLD,
  POOL_CAPACITY_MAX,
  PROPOSAL_WEEKLY_BUDGET,
  at_capacity,
  dead_node_eligible,
  evaluate_proposal,
  fields_jaccard,
  invalidation_record,
  near_duplicate_by_embedding,
  near_duplicate_by_fields,
  proposal_budget_remaining,
};
export { GovernanceVerdict, PoolNodeSnapshot };
export type {
  GovernanceContractShape,
  GovernanceRegistry,
  GovernanceVerdictInit,
  PoolGovernanceOptions,
  PoolNodeSnapshotInit,
  PoolSnapshotInput,
  ProposalKnobs,
  ProposalSnapshot,
  TimeSource,
};

/** 周窗口秒数（提案预算的「本周」口径）。 */
const WEEK_SECONDS = 7 * 24 * 3600;

/** 读取键值：仅键存在时取值（镜像 Python dict.get 的存在性区分）。 */
function get(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

// 族收敛：真值/str/int 近似拷贝的统一迁移点 = core/py_repr.ts 单源（已就绪）；
// pyStr 语义与其一致，pyInt/pyFloat 属数值镜像不在该单源范围。后续批次可
// 按批迁移，本文件暂不改实现。
/** Python 真值口径：null/undefined/False/0/''/空容器一律为假。 */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Python str() 的标量渲染（None 兜底、布尔大写，供 node_id 归一）。 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** Python int() 数值镜像（数字按截断收敛；整数字符串可转换）。 */
function pyInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed);
    if (/^[+-]?\d+\.\d+$/.test(trimmed)) return Math.trunc(Number(trimmed));
  }
  return fallback;
}

/** Python float() 数值镜像（数字/数字字符串可转换）。 */
function pyFloat(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  }
  return fallback;
}

/** 宽松取字段清单：非清单形态一律按空处理（Python tuple(x or ())）。 */
function fieldList(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

/** 快照结点归一：对象原样返回，dict 形态按已知键构造（缺省取默认）。 */
function toSnapshotNode(node: PoolNodeSnapshot | PoolNodeSnapshotInit): PoolNodeSnapshot {
  if (node instanceof PoolNodeSnapshot) return node;
  return new PoolNodeSnapshot({
    node_id: String(node.node_id),
    usage_count: node.usage_count ?? 0,
    promoted: node.promoted ?? false,
    age_days: node.age_days ?? 0,
    fields: node.fields ?? [],
    domain: node.domain ?? 'default',
  });
}

/** 契约产出 schema 的字段名集（唯一 + 排序；schema 缺省/形态不符 = 空）。 */
function schemaFieldNames(schema: unknown): string[] {
  if (!isRecord(schema)) return [];
  const rawFields = schema['fields'];
  if (!Array.isArray(rawFields)) return [];
  const names: string[] = [];
  for (const field of rawFields) {
    if (isRecord(field) && typeof field['name'] === 'string') names.push(field['name'] as string);
  }
  return [...new Set(names)].sort();
}

/**
 * 池治理登记器：调用纯规则判定并登记记录（append-only）。
 *
 * 判定本身不执行任何决策——登记记录供宿主走既有评审通道时参考与审计追溯。
 * 时间戳经构造注入的时钟取值（缺省确定值 0）。
 */
export class PoolGovernance {
  readonly log: Array<Record<string, unknown>> = [];
  readonly #now: TimeSource;

  constructor(options: PoolGovernanceOptions = {}) {
    this.#now = options.now ?? (() => 0);
  }

  /**
   * 判定一次新结点提案并登记（输入 = 提案数据 + 池快照）。
   *
   * 快照形态：pool_count/used_this_week/duplicate_cosine + pool_nodes
   * （池内结点可为快照对象或 dict，登记器归一化处理）。
   */
  evaluate(proposal: Record<string, unknown>, snapshot: PoolSnapshotInput): GovernanceVerdict {
    const fields = fieldList(get(proposal, 'fields'));
    const poolNodes = (snapshot.pool_nodes ?? []).map(toSnapshotNode);
    const nodeIdRaw = get(proposal, 'node_id');
    const verdict = evaluate_proposal(
      nodeIdRaw === undefined ? '' : pyStr(nodeIdRaw),
      fields,
      {
        pool_count: pyInt(snapshot.pool_count, 0),
        used_this_week: pyInt(snapshot.used_this_week, 0),
        pool_nodes: poolNodes,
        duplicate_cosine: pyFloat(snapshot.duplicate_cosine, 0.0),
      },
    );
    this.log.push({
      node_id: nodeIdRaw === undefined ? '' : nodeIdRaw,
      ts: this.#now(),
      ...verdict.to_dict(),
    });
    return verdict;
  }

  /**
   * 本登记器历史中全部死结点失效登记（标记失效不物理删）。
   *
   * 失效登记由判定记录的 eviction_candidates 派生——判定与登记同源
   * （候选清单即淘汰登记依据），不重复落 log：log 保持纯判定记录，
   * 周预算统计（weekly_proposal_usage）不被失效登记污染。
   */
  dead_node_records(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const record of this.log) {
      const candidates = record['eviction_candidates'];
      if (!Array.isArray(candidates)) continue;
      for (const nodeId of candidates) {
        out.push(
          invalidation_record(String(nodeId), '死结点淘汰（零调用且超龄）', {
            ts: record['ts'] as number | undefined,
          }),
        );
      }
    }
    return out;
  }
}

/**
 * 治理登记历史 → 本周提案已用数（时间窗口内条数；无 ts = 按当前计）。
 *
 * 提案预算规则（3/周/域）的「已用」口径：以登记记录时间戳计窗口内提案
 * 条数（含预算耗尽拒绝前的放行登记——预算扣减发生在登记时点）。无时间戳
 * 记录按当前窗口计；now 由注入供给（缺省确定值 0）。
 */
export function weekly_proposal_usage(
  records: readonly Record<string, unknown>[],
  options: { now?: number; week_seconds?: number } = {},
): number {
  const now = options.now ?? 0;
  const cutoff = now - (options.week_seconds ?? WEEK_SECONDS);
  let total = 0;
  for (const record of records) {
    const ts = record['ts'];
    if (ts === undefined || ts === null) {
      total += 1;
      continue;
    }
    if (Number(ts) >= cutoff) total += 1;
  }
  return total;
}

/**
 * 失败点结点提案记录 → 治理提案形态（node_id/fields 归一）。
 *
 * 记录形态（沉淀钩子产出）：node_type + 契约草案（output_schema 的
 * SchemaSpec dict 形态）；治理判定的字段集 = 产出字段名（Jaccard 近重复
 * 判定的语义面）。未知形态的键缺省空——判定按缺省走（不因归一失败抛错）。
 */
export function proposal_from_node_draft(
  record: Record<string, unknown>,
): { node_id: string; fields: string[] } {
  const schemaRaw = get(record, 'output_schema');
  const schema: Record<string, unknown> = isRecord(schemaRaw) ? schemaRaw : {};
  const fields: string[] = [];
  const rawFields = schema['fields'];
  if (Array.isArray(rawFields)) {
    for (const field of rawFields) {
      if (isRecord(field)) {
        const name = field['name'];
        if (isTruthy(name)) fields.push(pyStr(name));
      }
    }
  }
  const rawType = get(record, 'node_type');
  const rawNodeId = get(record, 'node_id');
  const chosen = isTruthy(rawType) ? rawType : isTruthy(rawNodeId) ? rawNodeId : '';
  return { node_id: pyStr(chosen), fields };
}

/**
 * 结点类型注册表 → 治理快照结点清单（契约字段名集 = Jaccard 判定输入）。
 *
 * 只取带契约的类型（与组装池同源：无契约结点不参与组装，也不参与治理的
 * 合并/淘汰判定）；字段集 = 产出字段名（结点对下游的语义面），唯一排序。
 */
export function pool_nodes_from_registry(registry: GovernanceRegistry): PoolNodeSnapshot[] {
  const nodes: PoolNodeSnapshot[] = [];
  for (const typeName of registry.types()) {
    const contract = registry.contract_for(typeName);
    if (contract === null || contract === undefined) continue;
    nodes.push(
      new PoolNodeSnapshot({
        node_id: String(typeName),
        fields: schemaFieldNames(contract.output_schema),
      }),
    );
  }
  return nodes;
}
