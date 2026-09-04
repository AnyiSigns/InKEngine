/**
 * 算法自动修复算子集 + 修复驱动（path_assembler.py「自动修复」段移植）。
 *
 * 有名字的图编辑算子：replace_node（替换）/ add_branch（补链）/ remove_node
 * （剪枝）/ reroute_edge（改接）——每算子执行后重跑前缀可达性校验；修复不可达
 * → None（调用方走全量算法重组装兜底）。修复驱动按固定算子序逐轮修复，
 * 轮数上限 = max_rounds（防算子组合全枚举）。契约视图全驱动共享一次预解析
 * （ENG9a-15）；beam 宽度/深度透传给补链搜索（ENG9a-25）。
 */

import type { NodeContract } from '../contracts/contracts.js';
import type { StateSchema } from '../state/schema.js';
import {
  DEFAULT_BEAM_WIDTH,
  DEFAULT_MAX_PATH_LENGTH,
  DEFAULT_MAX_SAFETY_TIER,
  MAX_REPAIR_ROUNDS,
} from './constants.js';
import { _forward_search } from './search.js';
import {
  _build_contract_views,
  _chain_available,
  _ContractView,
  _validate_chain_views,
} from './validate.js';

/** 修复算子统一选项（pool 池子 + 校验规则 + 搜索参数透传）。 */
export interface _RepairOptions {
  pool: Record<string, NodeContract>;
  goal_fields: readonly string[];
  entry_fields?: readonly string[];
  max_safety_tier?: number;
  state_schema?: StateSchema | null;
  views?: Record<string, _ContractView> | null;
  beam_width?: number;
  max_depth?: number;
}

function resolveViews(opts: _RepairOptions): Record<string, _ContractView> {
  return opts.views ?? _build_contract_views(opts.pool);
}

function validateWithViews(
  chain: readonly string[],
  opts: _RepairOptions,
  views: Record<string, _ContractView>,
): readonly [boolean, string[]] {
  return _validate_chain_views(
    chain,
    views,
    opts.goal_fields,
    opts.entry_fields ?? [],
    opts.max_safety_tier ?? DEFAULT_MAX_SAFETY_TIER,
    opts.state_schema ?? null,
  );
}

/** 替换算子：结点 → 可达等价结点（输出覆盖不缩水、输入可达）。 */
export function replace_node(
  chain: readonly string[],
  opts: _RepairOptions,
): readonly string[] | null {
  const views = resolveViews(opts);
  const base = [...chain];
  for (let i = 0; i < base.length; i++) {
    for (const alt of Object.keys(opts.pool)) {
      if (alt === base[i] || base.includes(alt)) continue;
      const candidate = [...base.slice(0, i), alt, ...base.slice(i + 1)];
      const [ok] = validateWithViews(candidate, opts, views);
      if (ok) return candidate;
    }
  }
  return null;
}

/** 补链算子：缺口字段 → 补一条前置生产链（多源汇聚合法）。
 *  ENG9a-25：单个缺口无生产者不整体放弃——继续尝试下一缺口/目标缺口。 */
export function add_branch(
  chain: readonly string[],
  opts: _RepairOptions,
): readonly string[] | null {
  const views = resolveViews(opts);
  const base = [...chain];
  const beam_width = opts.beam_width ?? DEFAULT_BEAM_WIDTH;
  const max_depth = opts.max_depth ?? DEFAULT_MAX_PATH_LENGTH;
  const max_safety_tier = opts.max_safety_tier ?? DEFAULT_MAX_SAFETY_TIER;
  for (let i = 0; i < base.length; i++) {
    const name = base[i]!;
    const view = views[name];
    if (view === undefined) continue; // 未知结点由替换算子处理
    const prefix = new Set<string>(opts.entry_fields ?? []);
    for (let p = 0; p < i; p++) {
      const prevView = views[base[p]!];
      if (prevView === undefined) continue;
      for (const produced of prevView.produced) prefix.add(produced);
    }
    const missing: string[] = [];
    for (const req of view.required) {
      if (!prefix.has(req)) missing.push(req);
    }
    if (missing.length === 0) continue;
    const producers = _forward_search(
      missing.sort(),
      [...prefix].sort(),
      opts.pool,
      {
        beam_width,
        max_depth,
        max_safety_tier,
        exclude: base,
        views,
      },
    );
    if (producers.length === 0) continue; // 本缺口补不上：尝试下一缺口
    const candidate = [...base.slice(0, i), ...producers[0]!, ...base.slice(i)];
    const [ok] = validateWithViews(candidate, opts, views);
    if (ok) return candidate;
  }
  const missing_goal = [...new Set(opts.goal_fields)]
    .filter((field) => !_chain_available(base, views, opts.entry_fields ?? []).has(field))
    .sort();
  if (missing_goal.length === 0) return null;
  const producers = _forward_search(
    missing_goal,
    [..._chain_available(base, views, opts.entry_fields ?? [])].sort(),
    opts.pool,
    {
      beam_width,
      max_depth,
      max_safety_tier,
      exclude: base,
      views,
    },
  );
  if (producers.length === 0) return null;
  const candidate = [...base, ...producers[0]!];
  const [ok] = validateWithViews(candidate, opts, views);
  return ok ? candidate : null;
}

/** 剪枝算子：冗余/不可达结点剪除（产出不被任何后继需求也不补目标）。 */
export function remove_node(
  chain: readonly string[],
  opts: _RepairOptions,
): readonly string[] | null {
  const views = resolveViews(opts);
  const base = [...chain];
  for (let i = base.length - 1; i >= 0; i--) {
    const candidate = [...base.slice(0, i), ...base.slice(i + 1)];
    const [ok] = validateWithViews(candidate, opts, views);
    if (ok) return candidate;
  }
  return null;
}

/** 改接算子：结点重新落位（生产者前置 / 消费者后移，补齐覆盖顺序）。 */
export function reroute_edge(
  chain: readonly string[],
  opts: _RepairOptions,
): readonly string[] | null {
  const views = resolveViews(opts);
  const base = [...chain];
  for (let i = 0; i < base.length; i++) {
    for (let j = 0; j < base.length; j++) {
      if (j === i) continue;
      const node = base[i]!;
      const rest = [...base.slice(0, i), ...base.slice(i + 1)];
      const candidate = [...rest.slice(0, j), node, ...rest.slice(j)];
      if (candidate.length === base.length && candidate.every((v, idx) => v === base[idx])) continue;
      const [ok] = validateWithViews(candidate, opts, views);
      if (ok) return candidate;
    }
  }
  return null;
}

/** 自动修复算子序（固定顺序：替换 → 补链 → 剪枝 → 改接）。 */
export const _REPAIR_OPERATORS: ReadonlyArray<
  (chain: readonly string[], opts: _RepairOptions) => readonly string[] | null
> = [replace_node, add_branch, remove_node, reroute_edge];

/** 自动修复驱动：按固定算子集逐轮修复，每算子后重跑可达性校验。 */
export function repair_chain(
  chain: readonly string[],
  opts: _RepairOptions & { max_rounds?: number },
): readonly string[] | null {
  if (chain.length === 0) return null;
  const views = resolveViews(opts);
  let current = [...chain];
  const max_rounds = Math.max(1, opts.max_rounds ?? MAX_REPAIR_ROUNDS);
  for (let round = 0; round < max_rounds; round++) {
    const [ok] = validateWithViews(current, opts, views);
    if (ok) return current;
    let progressed = false;
    for (const op of _REPAIR_OPERATORS) {
      const repaired = op(current, opts);
      if (repaired === null || repaired.length === 0) continue;
      if (repaired.length === current.length && repaired.every((v, idx) => v === current[idx])) {
        continue;
      }
      const [okRepaired] = validateWithViews(repaired, opts, views);
      if (okRepaired) {
        current = [...repaired];
        progressed = true;
        break;
      }
    }
    if (!progressed) return null;
  }
  const [okFinal] = validateWithViews(current, opts, views);
  return okFinal ? current : null;
}
