/**
 * 候选链校验 + 契约预解析视图（path_assembler.py「候选链校验」段移植）。
 *
 * validate_chain = 池成员 + 唯一性 + 前缀可达性（弱校验，多源汇聚合法）+
 * 目标覆盖；``_ContractView`` = 契约字段名集缓存（ENG9a-15：热路径一次建好，
 * 校验/修复/搜索复用，免重复解析）；``_chain_available`` = 链上产出并集。
 * 理由序稳定可断言（逐项中文消息与 Python 同文）。
 */

import { required_field_names, produced_field_names, validate_prefix_reachability } from '../link_validator/link_validator.js';
import type { NodeContract } from '../contracts/contracts.js';
import type { StateSchema } from '../state/schema.js';
import { DEFAULT_MAX_SAFETY_TIER } from './constants.js';

/** 契约预解析视图（字段名集缓存；避免大规模池重复计算）。 */
export class _ContractView {
  readonly required: ReadonlySet<string>;
  readonly produced: ReadonlySet<string>;
  readonly contract: NodeContract;

  constructor(required: ReadonlySet<string>, produced: ReadonlySet<string>, contract: NodeContract) {
    this.required = required;
    this.produced = produced;
    this.contract = contract;
  }
}

/** 池 → 预解析契约视图（ENG9a-15：字段名解析一次，全链校验/搜索复用）。 */
export function _build_contract_views(
  pool: Record<string, NodeContract>,
): Record<string, _ContractView> {
  const views: Record<string, _ContractView> = {};
  for (const type_name of Object.keys(pool)) {
    const contract = pool[type_name]!;
    views[type_name] = new _ContractView(
      required_field_names(contract.input_schema),
      produced_field_names(contract.output_schema),
      contract,
    );
  }
  return views;
}

/** 集合包含判定（required ⊆ covered；ReadonlySet 无内建子集运算）。 */
function is_subset(required: ReadonlySet<string>, covered: ReadonlySet<string>): boolean {
  for (const name of required) {
    if (!covered.has(name)) return false;
  }
  return true;
}

/** 前缀并集 + 视图校验核（字段名集取自预解析视图）。 */
export function _validate_chain_views(
  chain: readonly string[],
  views: Record<string, _ContractView>,
  goal_fields: readonly string[],
  entry_fields: readonly string[],
  max_safety_tier: number,
  state_schema: StateSchema | null,
): readonly [boolean, string[]] {
  if (chain.length === 0) return [false, ['候选链为空']];
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const name of chain) {
    if (!(name in views)) {
      reasons.push(`结点未知: ${name}`);
    } else if (seen.has(name)) {
      reasons.push(`结点重复: ${name}`);
    }
    seen.add(name);
  }
  if (reasons.length > 0) return [false, reasons];
  const contracts = chain.map((name) => views[name]!.contract);
  const [, prefix_reasons] = validate_prefix_reachability(contracts, {
    entry_fields,
    max_safety_tier,
    state_schema,
  });
  reasons.push(...prefix_reasons);
  const available = new Set<string>(entry_fields);
  for (const name of chain) {
    for (const produced of views[name]!.produced) available.add(produced);
  }
  const missing_goal = [...new Set(goal_fields)].filter((field) => !available.has(field)).sort();
  if (missing_goal.length > 0) {
    reasons.push(`未覆盖目标字段: ${missing_goal.join('、')}`);
  }
  return [reasons.length === 0, reasons];
}

/** 候选链校验：池成员 + 唯一性 + 前缀可达性（弱校验）+ 目标覆盖。
 *  ``views`` = 预解析契约视图（ENG9a-15）；未注入时按 ``pool`` 现建。 */
export function validate_chain(
  chain: readonly string[],
  opts: {
    pool: Record<string, NodeContract>;
    goal_fields: readonly string[];
    entry_fields?: readonly string[];
    max_safety_tier?: number;
    state_schema?: StateSchema | null;
    views?: Record<string, _ContractView> | null;
  },
): readonly [boolean, string[]] {
  const views = opts.views ?? _build_contract_views(opts.pool);
  return _validate_chain_views(
    chain,
    views,
    opts.goal_fields,
    opts.entry_fields ?? [],
    opts.max_safety_tier ?? DEFAULT_MAX_SAFETY_TIER,
    opts.state_schema ?? null,
  );
}

/** 链上可用字段并集（入口 ∪ 链上各结点产出；未知结点无产出信息跳过）。 */
export function _chain_available(
  chain: readonly string[],
  views: Record<string, _ContractView>,
  entry_fields: readonly string[],
): ReadonlySet<string> {
  const available = new Set<string>(entry_fields);
  for (const name of chain) {
    const view = views[name];
    if (view === undefined) continue;
    for (const produced of view.produced) available.add(produced);
  }
  return available;
}

/** 目标字段子集 / 前缀可用判定（search/repair 共用）。 */
export function _covered_by(covered: ReadonlySet<string>, required: ReadonlySet<string>): boolean {
  return is_subset(required, covered);
}
