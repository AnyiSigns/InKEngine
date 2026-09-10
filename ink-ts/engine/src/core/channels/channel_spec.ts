/**
 * 通道条件数据面（跨作用域/执行转场算子的声明模型）。
 *
 * 执行模型「通道 Channel = 跨作用域/执行间的转场算子」，本模块承载其纯数据
 * 形态 + 校验：
 *
 * - 形态 shape：委托(1→1) / fan-out(1→N) / fan-in(N→1) / 回传（return）；
 * - 提交契约 commit：全量回传(full) / 择优回传(best) / 仅回传决策(decision_only)
 *   ——对应旧稿通道名 spawn/推演/fork_trial 的契约语义（保留，不退役）；
 * - 条件 conditions：资格 eligibility / 审批档 approval / 最大并行 max_parallel /
 *   成本池上限 cost_pool_cap（跨作用域转场必须满足的渗透条件）；
 * - 观测 observable：通道事件（进入/通过/被拒）作为审计与组织档案数据源。
 *
 * 纯数据面（JSON 进 JSON 出）：只有类型 + 校验 + 序列化，不含任何执行器。
 * 运行时（作用域装载/通道执行/条件判定）由执行层后续落地；本模块的声明
 * 是那层读到的通道资产形态。
 */

import { APPROVAL_LEVELS } from '../contracts/generated/index.js';
import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';

// ── 形态 ──

/** 委托（1→1）：单目标作用域的单路转场。 */
export const CHANNEL_SHAPE_DELEGATE = 'delegate';
/** fan-out（1→N）：派 N 路并行子执行。 */
export const CHANNEL_SHAPE_FAN_OUT = 'fan_out';
/** fan-in（N→1）：多路子执行归并。 */
export const CHANNEL_SHAPE_FAN_IN = 'fan_in';
/** 回传（子执行结果返回父执行的 1→1 逆通道；fan-in 在 N=1 的退化）。 */
export const CHANNEL_SHAPE_RETURN = 'return';

export const CHANNEL_SHAPES = [
  CHANNEL_SHAPE_DELEGATE,
  CHANNEL_SHAPE_FAN_OUT,
  CHANNEL_SHAPE_FAN_IN,
  CHANNEL_SHAPE_RETURN,
] as const;

/** 通道形态（四值：委托/fan-out/fan-in/回传）。 */
export type ChannelShape = (typeof CHANNEL_SHAPES)[number];

// ── 提交契约 ──

/** 全量回传：结果（全部）回主执行。 */
export const CHANNEL_COMMIT_FULL = 'full';
/** 择优回传：只收最优，落选轨迹保留但隔离。 */
export const CHANNEL_COMMIT_BEST = 'best';
/** 仅回传决策：结果不回传，仅回传采纳/否决决策（fork_trial 语义）。 */
export const CHANNEL_COMMIT_DECISION_ONLY = 'decision_only';

export const CHANNEL_COMMITS = [
  CHANNEL_COMMIT_FULL,
  CHANNEL_COMMIT_BEST,
  CHANNEL_COMMIT_DECISION_ONLY,
] as const;

/** 提交契约（三值：全量/择优/仅决策）。 */
export type ChannelCommit = (typeof CHANNEL_COMMITS)[number];

/** 提交契约缺省（全量回传——意见全收的默认归并口径）。 */
export const CHANNEL_COMMIT_DEFAULT: ChannelCommit = CHANNEL_COMMIT_FULL;

// ── 条件 ──

/** 通道条件（跨作用域转场的渗透条件；全部可缺省 = 无额外条件）。 */
export interface ChannelConditions {
  /** 资格：允许走该通道的作用域/身份 token 清单（空 = 不设资格墙）。 */
  eligibility?: readonly string[];
  /** 审批档：转场需满足的审批（null = 不额外设审批，沿用执行/产品默认）。 */
  approval?: (typeof APPROVAL_LEVELS)[number] | null;
  /** 最大并行数（fan-out 上限护栏；null = 不设）。 */
  max_parallel?: number | null;
  /** 成本池上限（该通道关联执行的成本池；null = 不设）。 */
  cost_pool_cap?: number | null;
}

/** 通道条件缺省（资格空 / 无额外审批 / 无并行与成本上限）。 */
export function default_channel_conditions(): Required<ChannelConditions> {
  return {
    eligibility: [],
    approval: null,
    max_parallel: null,
    cost_pool_cap: null,
  };
}

// ── 通道资产 ──

/** 通道 id 命名上限（与实体 id 同档；防目录资产无限膨胀）。 */
export const CHANNEL_ID_MAX_LENGTH = 48;

/** 构造通道资产选项。 */
export interface ChannelSpecInit {
  id: string;
  label?: string;
  shape: ChannelShape;
  commit?: ChannelCommit;
  conditions?: ChannelConditions | null;
  /** 观测开关：通道事件（进入/通过/被拒）是否入审计/组织档案（缺省 = 开）。 */
  observable?: boolean;
  /** 封禁标记（缺省 = false 启用）：下架（封）的通道资产声明面——执行层
   *  装配时跳过封禁通道；封 = 声明置位，不删除记录（可审计/可回退）。 */
  disabled?: boolean;
}

/**
 * 通道资产声明（形态 + 提交契约 + 条件 + 观测）。
 * 纯数据：id 命名约束 + 枚举/数值校验，构造即冻结防别名改写。
 */
export class ChannelSpec {
  readonly id: string;
  readonly label: string;
  readonly shape: ChannelShape;
  readonly commit: ChannelCommit;
  readonly conditions: Required<ChannelConditions>;
  readonly observable: boolean;
  /** 封禁标记：true = 通道已封（下架）；false = 启用。 */
  readonly disabled: boolean;

  constructor(init: ChannelSpecInit) {
    validate_channel_id(init.id);
    if (!(CHANNEL_SHAPES as readonly string[]).includes(init.shape)) {
      throw new GraphDefinitionError(
        `通道 ${init.id} 形态非法: ${String(init.shape)}（须为 ${CHANNEL_SHAPES.join('/')}）`,
      );
    }
    const commit = init.commit ?? CHANNEL_COMMIT_DEFAULT;
    if (!(CHANNEL_COMMITS as readonly string[]).includes(commit)) {
      throw new GraphDefinitionError(
        `通道 ${init.id} 提交契约非法: ${String(commit)}（须为 ${CHANNEL_COMMITS.join('/')}）`,
      );
    }
    this.id = init.id;
    this.label = init.label ?? '';
    this.shape = init.shape;
    this.commit = commit;
    this.conditions = normalize_conditions(init.id, init.conditions);
    this.observable = init.observable ?? true;
    this.disabled = init.disabled ?? false;
    Object.freeze(this);
  }

  to_dict(): Record<string, unknown> {
    const out: Record<string, unknown> = { id: this.id, shape: this.shape };
    if (this.label) out['label'] = this.label;
    if (this.commit !== CHANNEL_COMMIT_DEFAULT) out['commit'] = this.commit;
    const cond: Record<string, unknown> = {};
    if (this.conditions.eligibility.length > 0) {
      cond['eligibility'] = [...this.conditions.eligibility];
    }
    if (this.conditions.approval !== null) cond['approval'] = this.conditions.approval;
    if (this.conditions.max_parallel !== null) {
      cond['max_parallel'] = this.conditions.max_parallel;
    }
    if (this.conditions.cost_pool_cap !== null) {
      cond['cost_pool_cap'] = this.conditions.cost_pool_cap;
    }
    if (Object.keys(cond).length > 0) out['conditions'] = cond;
    if (this.observable !== true) out['observable'] = false;
    if (this.disabled) out['disabled'] = true;
    return out;
  }

  static from_dict(data: unknown): ChannelSpec {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`通道声明非法: 期望 dict，收到 ${typeof data}`);
    }
    const id = data['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      throw new GraphDefinitionError('通道声明缺 id（字符串）');
    }
    const shape = data['shape'];
    if (typeof shape !== 'string') {
      throw new GraphDefinitionError(`通道 ${id} 缺 shape`);
    }
    const label = data['label'];
    if (label !== undefined && typeof label !== 'string') {
      throw new GraphDefinitionError(`通道 ${id} 的 label 须为字符串`);
    }
    const commit = data['commit'];
    const rawConditions = data['conditions'];
    if (rawConditions !== undefined && rawConditions !== null && !isRecord(rawConditions)) {
      throw new GraphDefinitionError(`通道 ${id} 的 conditions 须为 dict`);
    }
    const observable = data['observable'];
    if (observable !== undefined && typeof observable !== 'boolean') {
      throw new GraphDefinitionError(`通道 ${id} 的 observable 须为 boolean`);
    }
    const disabled = data['disabled'];
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      throw new GraphDefinitionError(`通道 ${id} 的 disabled 须为 boolean`);
    }
    return new ChannelSpec({
      id,
      label: label as string | undefined,
      shape: shape as ChannelShape,
      commit: commit as ChannelCommit | undefined,
      conditions:
        rawConditions === undefined || rawConditions === null
          ? null
          : (rawConditions as ChannelConditions),
      observable: observable as boolean | undefined,
      disabled: disabled as boolean | undefined,
    });
  }
}

/** 封/解封切换的纯构造（保留其余字段只改 disabled；缺失即按原样冻结构造）。 */
export function channel_with_disabled(spec: ChannelSpec, disabled: boolean): ChannelSpec {
  return new ChannelSpec({
    id: spec.id,
    label: spec.label,
    shape: spec.shape,
    commit: spec.commit,
    conditions: spec.conditions,
    observable: spec.observable,
    disabled,
  });
}

/** id 命名校验（与实体 id 同约束：长度 + 无空白/控制字符）。 */
export function validate_channel_id(id: string): void {
  if (id.length > CHANNEL_ID_MAX_LENGTH) {
    throw new GraphDefinitionError(`通道 id 超长（>${CHANNEL_ID_MAX_LENGTH} 字符）`);
  }
  for (const ch of id) {
    if (ch.charCodeAt(0) < 32 || /\s/.test(ch)) {
      throw new GraphDefinitionError('通道 id 不得含空白或控制字符');
    }
  }
}

/** 归一通道条件（缺省补齐；数值与取值校验 fail-closed）。 */
export function normalize_conditions(
  id: string,
  raw: ChannelConditions | null | undefined,
): Required<ChannelConditions> {
  const out = default_channel_conditions();
  if (raw === null || raw === undefined) return out;
  const eligibility = raw.eligibility ?? [];
  if (!Array.isArray(eligibility) || eligibility.some((e) => typeof e !== 'string' || e.trim() === '')) {
    throw new GraphDefinitionError(`通道 ${id} 条件 eligibility 须为非空字符串清单`);
  }
  const approval = raw.approval ?? null;
  if (approval !== null && !(APPROVAL_LEVELS as readonly string[]).includes(String(approval))) {
    throw new GraphDefinitionError(`通道 ${id} 条件 approval 非法: ${String(approval)}`);
  }
  const maxParallel = raw.max_parallel ?? null;
  if (maxParallel !== null && (!Number.isInteger(maxParallel) || maxParallel < 1)) {
    throw new GraphDefinitionError(`通道 ${id} 条件 max_parallel 须为正整数`);
  }
  const costPoolCap = raw.cost_pool_cap ?? null;
  if (costPoolCap !== null && (!Number.isFinite(costPoolCap) || costPoolCap < 0)) {
    throw new GraphDefinitionError(`通道 ${id} 条件 cost_pool_cap 须为非负数`);
  }
  out.eligibility = [...eligibility];
  out.approval = approval;
  out.max_parallel = maxParallel;
  out.cost_pool_cap = costPoolCap;
  return out;
}
