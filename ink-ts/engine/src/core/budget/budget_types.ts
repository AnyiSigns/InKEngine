/**
 * 预算域数据形态与策略接口（budget.py 移植）。
 * - 值域 JSON 兼容（policy 名 + number + boolean）；
 * - BudgetRemaining 只读（frozen 语义由 readonly 表达）。
 */

/** 预算策略接口：业务实现并注册，引擎在节点边界调用。 */
export interface BudgetPolicy {
  /** 终止式硬检查：超限抛 BudgetExceededError。 */
  check(ctx: unknown): Promise<void>;
}

/** 预算余量只读查询接口（策略可选的第二协议；不要求实现）。 */
export interface BudgetQuery {
  /** 只读预检（不抛异常、不影响执行）；未启用余量语义返回 null。 */
  remaining(ctx: unknown): Promise<BudgetRemaining | null>;
}

/**
 * 单个预算维度的余量只读结果（预检输入；查询故障 = 不可用）。
 * policy: 预算维度名（策略身份，审计可读）；
 * limit: 预算上限（0 = 不可用维度）；
 * used: 已用量；
 * remaining: 余量（limit - used；不可用 = 0）；
 * unavailable: 查询故障/维度无余量概念（fail-closed：余量视为 0）。
 */
export class BudgetRemaining {
  readonly policy: string;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly unavailable: boolean;

  constructor(
    policy: string,
    limit: number,
    used: number,
    remaining: number,
    unavailable = false,
  ) {
    this.policy = policy;
    this.limit = limit;
    this.used = used;
    this.remaining = remaining;
    this.unavailable = unavailable;
  }
}
