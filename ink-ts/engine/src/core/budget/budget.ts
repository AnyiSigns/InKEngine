/**
 * 执行预算检查钩子（引擎在节点边界检查并终止）——budget.py 移植。
 *
 * 机制在内核：引擎定义预算检查点（节点完成/边选择前调用已注册的策略），
 * 策略由业务注册（GROUP_STEP_CAPS/tool_round_limit/字符预算等硬编码常量
 * 改声明式配置，全局/书籍级）。策略抛 BudgetExceededError → 引擎终止本轮
 * 并记录终止原因 budget_exceeded（入轨迹与审计）。
 *
 * 预算余量只读查询（评审决议下沉）：BudgetManager.query_remaining
 * 提供只读预检口——check 为 fail-closed 终止式无查询口；预检语义
 * fail-closed（查询故障/超预算 = 不可放行，见 can_afford）。
 *
 * 注：BudgetExceededError 定义于此（Python 侧在 core.exceptions，待其模块
 * 移植后应收敛至 ../errors.js），消息形态与 Python 逐字对齐。
 */

import { BudgetRemaining } from './budget_types.js';
import type { BudgetPolicy, BudgetQuery } from './budget_types.js';

export type { BudgetPolicy, BudgetQuery };
export { BudgetRemaining };

/**
 * 执行预算超限（步骤上限/轮数上限等，触发图终止）。
 * detail 携带附加说明（如预算策略自身故障的原始异常消息）——缺省 null
 * 时信息形态与早期一致，语义向后兼容。
 */
export class BudgetExceededError extends Error {
  readonly kind: string;
  readonly limit: number;
  readonly current: number;
  readonly detail: string | null;

  constructor(
    kind: string,
    limit: number,
    current: number,
    detail: string | null = null,
    options?: ErrorOptions,
  ) {
    let message = `执行预算超限[${kind}]: ${current} >= ${limit}`;
    if (detail) {
      message = `${message}（原始异常: ${detail}）`;
    }
    super(message, options);
    this.name = 'BudgetExceededError';
    this.kind = kind;
    this.limit = limit;
    this.current = current;
    this.detail = detail;
  }
}

/** 取值对象运行时类型名（镜像 Python type(x).__name__，审计留痕可读）。 */
function runtimeTypeName(value: unknown): string {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const ctor = (value as { constructor?: { name?: string } }).constructor;
    if (ctor && typeof ctor.name === 'string' && ctor.name !== '') return ctor.name;
  }
  return typeof value;
}

/** 取原始异常消息（镜像 Python str(exc)：Error 取 message，其余字符串化）。 */
function errorDetail(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

/**
 * 预算管理器：策略注册表 + 节点边界检查入口 + 余量只读查询。
 * 注册 = 插拔 U 盘：新增预算维度 = 注册新策略类，引擎核心零改动。
 */
export class BudgetManager {
  policies: BudgetPolicy[] = [];

  register(policy: BudgetPolicy): void {
    this.policies.push(policy);
  }

  /** 执行全部已注册策略（fail-closed：策略异常包装为 BudgetExceededError 终止）。 */
  async check(ctx: unknown): Promise<void> {
    for (const policy of this.policies) {
      try {
        await policy.check(ctx);
      } catch (exc) {
        if (exc instanceof BudgetExceededError) throw exc;
        // 预算策略自身故障不能拖垮主流程：按超限终止并保留原始异常
        // 类型信息到 kind（区分「策略执行故障」与「预算超限」），
        // 原始异常消息并入 reason 便于宿主直接定位故障策略，仍 fail-closed；
        // 异常链经 Error.cause 保留原异常（镜像 Python raise ... from exc）。
        throw new BudgetExceededError(
          `policy_error:${runtimeTypeName(exc)}`,
          0,
          0,
          errorDetail(exc),
          { cause: exc },
        );
      }
    }
  }

  /**
   * 预算余量只读查询（不抛异常：预检不得影响执行）。
   * 只对实现 BudgetQuery 语义（含 remaining 方法）的策略取余量；
   * 查询故障 = 该维度标记不可用（fail-closed：余量视为 0，见 can_afford）。
   */
  async query_remaining(ctx: unknown): Promise<BudgetRemaining[]> {
    const results: BudgetRemaining[] = [];
    for (const policy of this.policies) {
      const query = (policy as Partial<BudgetQuery>).remaining;
      if (typeof query !== 'function') continue;
      try {
        const result = await query.call(policy, ctx);
        if (result !== null && result !== undefined) results.push(result);
      } catch {
        results.push(
          new BudgetRemaining(
            runtimeTypeName(policy),
            0.0,
            0.0,
            0.0,
            true,
          ),
        );
      }
    }
    return results;
  }
}

/**
 * 预算预检（fail-closed 引擎强制）：够付才放行。
 * - 无预算维度 → 放行（未启用预算语义）；
 * - 任一维度查询不可用 → 拒绝（无法确认余量 = 不得放行）；
 * - 否则 cost ≤ 最小余量才放行。
 */
export function can_afford(results: readonly BudgetRemaining[], cost: number): boolean {
  if (results.length === 0) return true;
  if (results.some((r) => r.unavailable)) return false;
  let min = Number.POSITIVE_INFINITY;
  for (const r of results) {
    if (r.remaining < min) min = r.remaining;
  }
  return cost <= min;
}
