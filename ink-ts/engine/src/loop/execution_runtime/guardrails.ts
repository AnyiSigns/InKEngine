/**
 * 护栏（guardrails）：步数/成本/并行上限的命名常量 + 纯判定。
 *
 * 执行模型「护栏只兜底」：步数/成本上限、并行上限只作 fail-closed 的兜底线，
 * 主成本控制靠自治"何时收"（作用域 `__next` 收敛）。本模块给三条护栏的缺省
 * 档 + 纯判定函数（护栏判定不触 IO，超限 = 阻断 + 原因词）。
 *
 * 语义：步数护栏按单执行计（每轮作用域加工 +1）；成本护栏按该执行累计成本
 * 判定（子执行各自独立记账，不并入父护栏——fan-out 的各路子执行有自己的
 * 轨迹/成本，见 fan_in 归并语义）；并行护栏按单次 fan_out 声明路数判定。
 */

export const GUARDRAIL_DEFAULT_MAX_STEPS = 16;
export const GUARDRAIL_DEFAULT_MAX_COST = 1000;
export const GUARDRAIL_DEFAULT_MAX_PARALLEL = 8;

/** 护栏配置（缺省 = 出厂默认档；0 或 null = 关闭该项）。 */
export interface GuardrailConfig {
  max_steps?: number | null;
  max_cost?: number | null;
  max_parallel?: number | null;
}

/** 护栏判定结果（ok = 放行；blocked = fail-closed 阻断）。 */
export interface GuardrailVerdict {
  ok: boolean;
  rule: string;
  message: string;
}

function verdict(ok: boolean, rule: string, message: string): GuardrailVerdict {
  return { ok, rule, message };
}

/** 归一护栏配置（缺省补默认档；非法值 = 关闭该项语义拒绝由调用方承担）。 */
export function normalize_guardrails(config: GuardrailConfig): Required<GuardrailConfig> {
  const num = (value: number | null | undefined, fallback: number): number | null => {
    if (value === undefined || value === null) return fallback;
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  return {
    max_steps: num(config.max_steps, GUARDRAIL_DEFAULT_MAX_STEPS),
    max_cost: num(config.max_cost, GUARDRAIL_DEFAULT_MAX_COST),
    max_parallel: num(config.max_parallel, GUARDRAIL_DEFAULT_MAX_PARALLEL),
  };
}

/** 步数护栏：已走 steps 轮后放行一次加工须 steps+1 ≤ max_steps（0 = 关闭）。 */
export function check_steps_guard(
  steps: number,
  guards: Required<GuardrailConfig>,
): GuardrailVerdict {
  if (guards.max_steps === null || guards.max_steps <= 0) return verdict(true, 'steps', '');
  if (steps + 1 > guards.max_steps) {
    return verdict(
      false,
      'steps',
      `执行步数超限: ${steps + 1} > ${guards.max_steps}`,
    );
  }
  return verdict(true, 'steps', '');
}

/** 成本护栏：累计成本 + 增量 ≤ max_cost（0 = 关闭）。 */
export function check_cost_guard(
  accumulated: number,
  increment: number,
  guards: Required<GuardrailConfig>,
): GuardrailVerdict {
  if (guards.max_cost === null || guards.max_cost <= 0) return verdict(true, 'cost', '');
  if (accumulated + increment > guards.max_cost) {
    return verdict(false, 'cost', `执行成本超限: ${accumulated + increment} > ${guards.max_cost}`);
  }
  return verdict(true, 'cost', '');
}

/** 并行护栏：fan_out 声明路数 ≤ max_parallel（0 = 关闭）。 */
export function check_parallel_guard(
  count: number,
  guards: Required<GuardrailConfig>,
): GuardrailVerdict {
  if (guards.max_parallel === null || guards.max_parallel <= 0) return verdict(true, 'parallel', '');
  if (count > guards.max_parallel) {
    return verdict(false, 'parallel', `并行路数超限: ${count} > ${guards.max_parallel}`);
  }
  return verdict(true, 'parallel', '');
}
