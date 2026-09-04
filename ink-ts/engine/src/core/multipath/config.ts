/**
 * 多径机制装配配置与预算预检（multipath.py 配置段 + 成本核算段移植，1:1）。
 *
 * MultiPathConfig = 多径机制装配开关（默认全关；读取形态与既有装配配置
 * 一致）；multipath_config_from_flags = 装配入口接线（壳侧透传键 →
 * PathAssemblyFlags.multipath_enabled）；multipath_budget_required /
 * check_multipath_budget = 多径预算需求核算与 fail-closed 预检（够付才
 * 放行多径触发；任一维度余量不可确定按 0 处理拒绝）。
 */

import type { PathAssemblyFlags } from '../contracts/contracts.js';
import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import type { BudgetRemaining } from '../budget/budget_types.js';
import {
  DEFAULT_MULTIPATH_CONCURRENCY,
  DEFAULT_MULTIPATH_K,
  DEFAULT_SHARED_RHO,
  MAX_MULTIPATH_K,
  MAX_MULTIPATH_NESTING,
  RHO_MAX,
  RHO_MIN,
} from './constants.js';

/** Python 语义的 repr（错误消息对齐：字符串带单引号，布尔按字面）。 */
function pyRepr(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

/** 多径机制装配配置（默认全关；构造期校验同 Python __post_init__）。 */
export class MultiPathConfig {
  /** 机制入口开关（False = 不触发/不执行/零生效）。 */
  readonly enabled: boolean;
  /** 默认径数。 */
  readonly default_k: number;
  /** 径数上界（k=3 仅高风险任务放行）。 */
  readonly max_k: number;
  /** 共享折扣（多径成本核算的边际成本系数）。 */
  readonly shared_rho: number;
  /** 支流并发上限。 */
  readonly concurrency: number;
  /** 多径嵌套上限（嵌套超限降级单径 + 审计注明，默认 1 = 仅一级图）。 */
  readonly max_nesting: number;

  constructor(init: {
    enabled?: boolean;
    default_k?: number;
    max_k?: number;
    shared_rho?: number;
    concurrency?: number;
    max_nesting?: number;
  } = {}) {
    const enabled = init.enabled ?? false;
    const default_k = init.default_k ?? DEFAULT_MULTIPATH_K;
    const max_k = init.max_k ?? MAX_MULTIPATH_K;
    const shared_rho = init.shared_rho ?? DEFAULT_SHARED_RHO;
    const concurrency = init.concurrency ?? DEFAULT_MULTIPATH_CONCURRENCY;
    const max_nesting = init.max_nesting ?? MAX_MULTIPATH_NESTING;

    if (typeof default_k === 'boolean' || !Number.isInteger(default_k)) {
      throw new GraphDefinitionError(`径数须为整数: ${pyRepr(default_k)}`);
    }
    if (typeof max_k === 'boolean' || !Number.isInteger(max_k)) {
      throw new GraphDefinitionError(`径数上界须为整数: ${pyRepr(max_k)}`);
    }
    if (default_k < 1 || max_k < 1 || default_k > max_k) {
      throw new GraphDefinitionError(
        `径数配置非法: default_k=${default_k} max_k=${max_k}`,
      );
    }
    if (!(RHO_MIN <= shared_rho && shared_rho <= RHO_MAX)) {
      throw new GraphDefinitionError(
        `共享折扣越界: ${shared_rho}（须在 [${RHO_MIN}, ${RHO_MAX}]）`,
      );
    }
    if (typeof concurrency === 'boolean' || concurrency < 1) {
      throw new GraphDefinitionError(
        `支流并发上限须为正整数: ${pyRepr(concurrency)}`,
      );
    }
    if (typeof max_nesting === 'boolean' || max_nesting < 0) {
      throw new GraphDefinitionError(
        `多径嵌套上限须为非负整数: ${pyRepr(max_nesting)}`,
      );
    }

    this.enabled = enabled;
    this.default_k = default_k;
    this.max_k = max_k;
    this.shared_rho = shared_rho;
    this.concurrency = concurrency;
    this.max_nesting = max_nesting;
  }

  to_dict(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      default_k: this.default_k,
      max_k: this.max_k,
      shared_rho: this.shared_rho,
      concurrency: this.concurrency,
      max_nesting: this.max_nesting,
    };
  }

  /** 从数据形态重建（int()/float()/bool() 宽松读入口径同 Python）。 */
  static from_dict(data: Record<string, unknown>): MultiPathConfig {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `多径配置声明非法: 期望 dict，收到 ${data === null ? 'None' : typeof data}`,
      );
    }
    return new MultiPathConfig({
      enabled: Boolean(data['enabled'] ?? false),
      default_k: Number(data['default_k'] ?? DEFAULT_MULTIPATH_K),
      max_k: Number(data['max_k'] ?? MAX_MULTIPATH_K),
      shared_rho: Number(data['shared_rho'] ?? DEFAULT_SHARED_RHO),
      concurrency: Number(data['concurrency'] ?? DEFAULT_MULTIPATH_CONCURRENCY),
      max_nesting: Number(data['max_nesting'] ?? MAX_MULTIPATH_NESTING),
    });
  }
}

/** 装配入口接线：壳侧透传键 → 多径机制开关（缺省全关）。 */
export function multipath_config_from_flags(
  flags: PathAssemblyFlags,
): MultiPathConfig {
  return new MultiPathConfig({ enabled: flags.multipath_enabled });
}

// ── 成本核算与预算预检（fail-closed 引擎强制）─────────────────────

/**
 * 多径预算需求核算：``B × (1 + (k-1) × ρ)``。
 *
 * B = 单径成本基准（主候选链的证据成本核算），ρ = 共享折扣（共同前缀
 * 命中时边际成本趋低；无缓存 ρ=1.0 = 全边际成本）。
 */
export function multipath_budget_required(
  base_cost: number,
  k: number,
  opts: { rho?: number } = {},
): number {
  const rho = opts.rho ?? DEFAULT_SHARED_RHO;
  if (base_cost < 0 || k < 1) return 0.0;
  return base_cost * (1.0 + (k - 1) * rho);
}

/**
 * 预算预检（fail-closed）：够付才放行多径触发。
 *
 * - 未启用预算语义（无维度）→ 放行（无预算约束可言）；
 * - 任一维度余量不可确定（查询故障，fail-closed 视为 0）→ 拒绝；
 * - 否则需求 ≤ 各维度最小余量才放行；不足 → 拒绝（调用方降级单径）。
 */
export function check_multipath_budget(
  remaining: readonly BudgetRemaining[],
  base_cost: number,
  k: number,
  opts: { rho?: number } = {},
): [boolean, string] {
  const rho = opts.rho ?? DEFAULT_SHARED_RHO;
  const required = multipath_budget_required(base_cost, k, { rho });
  if (remaining.length === 0) {
    return [true, '未启用预算语义（无预算维度），按可执行放行'];
  }
  if (remaining.some((r) => r.unavailable)) {
    return [false, '预算余量不可确定（查询故障），预检拒绝'];
  }
  let minimal = Number.POSITIVE_INFINITY;
  for (const r of remaining) {
    if (r.remaining < minimal) minimal = r.remaining;
  }
  if (required <= minimal) {
    return [
      true,
      `预算预检通过（需 ${required.toFixed(2)} ≤ 余量 ${minimal.toFixed(2)}）`,
    ];
  }
  return [
    false,
    `预算预检拒绝：需求 ${required.toFixed(2)} > 余量 ${minimal.toFixed(2)}`,
  ];
}
