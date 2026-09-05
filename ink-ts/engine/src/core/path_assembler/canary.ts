/**
 * canary 兼容验证链路（path_assembler.py「canary 兼容验证链路」段移植）。
 *
 * canary = 重建 + 单回合执行（风险前置：产物执行前的结构/走通校验）。
 * 重建级校验（canary_instantiate = Graph.from_dict(validate=True)）与单回合
 * 试跑（canary_round = 复用 executor.Engine 单次执行验证候选链可跑通）均已
 * 落地：canary_round 在 canary 态（canary_active）下以独立实例引擎执行候选
 * 图，预算缺省注入步数护栏（canary_budget），正常收尾（reply/stop）且无挂起
 * = 通过；超时（canary_timeout）与执行异常 = 未通过。
 *
 * canary 执行态标记（canary_active）为模块级上下文位：canary_round 入口置位、
 * 出口复位——结点层据此桩化真实执行体。
 */

import type { NodeTypeRegistry } from '../registry/registry.js';
import { Graph } from '../graph/graph.js';
import { BudgetExceededError, BudgetManager } from '../budget/budget.js';
import type { BudgetPolicy } from '../budget/budget_types.js';
import { TerminateReason } from '../graph/graph_types.js';
import { Engine, RunOptions } from '../executor/index.js';
import { CANARY_MAX_STEPS } from './constants.js';

// ── canary 数据形态（PathAssemblyResult.canary 结论 / canary_round 结果）────

/** 候选图的 canary 验证结论（重建 + 单回合执行；风险前置校验）。 */
export class CanaryVerdict {
  readonly rank: number;
  readonly digest: string;
  readonly ok: boolean;
  readonly executed: boolean;
  readonly terminal: string | null;
  readonly error: string | null;

  constructor(init: {
    rank: number;
    digest: string;
    ok: boolean;
    executed?: boolean;
    terminal?: string | null;
    error?: string | null;
  }) {
    this.rank = init.rank;
    this.digest = init.digest;
    this.ok = init.ok;
    this.executed = init.executed ?? false;
    this.terminal = init.terminal ?? null;
    this.error = init.error ?? null;
  }

  to_dict(): Record<string, unknown> {
    return {
      rank: this.rank,
      digest: this.digest,
      ok: this.ok,
      executed: this.executed,
      terminal: this.terminal,
      error: this.error,
    };
  }
}

/** 单回合执行结果（试跑验证结论；stub 模型由使用方 RunOptions 注入）。 */
export class CanaryResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly final_state: Record<string, unknown>;
  readonly events_emitted: number;

  constructor(init: {
    ok: boolean;
    reason: string;
    final_state: Record<string, unknown>;
    events_emitted: number;
  }) {
    this.ok = init.ok;
    this.reason = init.reason;
    this.final_state = init.final_state;
    this.events_emitted = init.events_emitted;
  }

  to_dict(): Record<string, unknown> {
    return {
      ok: this.ok,
      reason: this.reason,
      final_state: this.final_state,
      events_emitted: this.events_emitted,
    };
  }
}

// ── canary 执行态标记（模块级上下文位；canary_round 入口置位、出口复位——
//   结点层据此桩化真实执行体）─────────────────────────────
let _canary_active = false;

/** 当前是否处于 canary 执行态（结点层桩化判定）。 */
export function canary_active(): boolean {
  return _canary_active;
}

/** canary 执行态置位/复位（canary_round 入口/出口使用）。 */
export function _set_canary_active(active: boolean): void {
  _canary_active = active;
}

/** canary 预算上限策略：执行步数超限即终止（预算护栏的第二道闸）。 */
export class _CanaryStepBudget implements BudgetPolicy {
  readonly max_steps: number;
  private _visited: string[] = [];

  constructor(max_steps: number = CANARY_MAX_STEPS) {
    this.max_steps = max_steps;
  }

  async check(ctx: unknown): Promise<void> {
    const node = (ctx as { node?: unknown } | null)?.node;
    this._visited.push(node === null || node === undefined ? '' : String(node));
    if (this._visited.length > this.max_steps) {
      throw new BudgetExceededError('canary_steps', this.max_steps, this._visited.length);
    }
  }
}

/** canary 预算管理器（步数上限；canary_round 缺省注入）。 */
export function canary_budget(): BudgetManager {
  const manager = new BudgetManager();
  manager.register(new _CanaryStepBudget());
  return manager;
}

/** 候选图定义数据 → 重建实例（``from_dict(validate=True)`` 口径）。
 *  重建即校验：结构非法（悬挂入口/未知类型引用/边解析失败）在建图期暴露。 */
export function canary_instantiate(
  graph_data: Record<string, unknown>,
  opts: { registry: NodeTypeRegistry; edge_registry?: unknown },
): Graph {
  return Graph.from_dict(graph_data, {
    registry: opts.registry,
    edge_registry: opts.edge_registry as never,
    validate: true,
  });
}

/**
 * 单回合试跑选项（RunOptions 或构造字段子集；null = 引擎默认）。
 * 试跑为独立实例：强制无存储（不落链）、预算缺省 = canary 步数护栏。
 */
function canary_run_options(raw: RunOptions | Partial<RunOptions> | null | undefined): RunOptions {
  const base =
    raw instanceof RunOptions
      ? raw
      : new RunOptions({ ...((raw ?? {}) as Partial<RunOptions>) });
  return new RunOptions({
    ...base,
    storage: null,
    budget: base.budget !== null ? base.budget : canary_budget(),
  });
}

/** 超时护栏：到点终止试跑（JS 无任务取消，后台执行完成即弃；结论按超时失败）。 */
function with_timeout<T>(promise: Promise<T>, timeout_seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`canary 试跑超时（${timeout_seconds}s）`));
    }, timeout_seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (exc) => {
        clearTimeout(timer);
        reject(exc);
      },
    );
  });
}

/**
 * canary 一回合试跑：图合法 + 单回合走通——复用 executor 单次执行验证。
 *
 * 语义对齐 Python：Engine(graph, options).ainvoke(entry_state) 执行单回合
 * （canary 态置位、预算缺省注入、超时 wait_for）；正常收尾（reply/stop）且
 * 无挂起 = 通过；其余终态（error/budget_exceeded）或执行异常/超时 = 未通过。
 * 试跑引擎独立实例：强制无存储（canary 只出结论不留版本链），budget 未注入
 * 时以 canary_budget（步数护栏）兜底——失控候选在步数上限处被截止。
 */
export async function canary_round(
  graph: Graph,
  opts: {
    entry_state?: Record<string, unknown> | null;
    options?: RunOptions | Partial<RunOptions> | null;
    canary_timeout?: number | null;
  } = {},
): Promise<CanaryResult> {
  const entry_state = { ...(opts.entry_state ?? {}) };
  const engine = new Engine(graph, canary_run_options(opts.options));
  _set_canary_active(true);
  try {
    const run_promise = engine.ainvoke(entry_state);
    const run_result =
      opts.canary_timeout !== null && opts.canary_timeout !== undefined && opts.canary_timeout > 0
        ? await with_timeout(run_promise, opts.canary_timeout)
        : await run_promise;
    const ok =
      (run_result.reason === TerminateReason.REPLY || run_result.reason === TerminateReason.STOP) &&
      run_result.interrupt === null;
    return new CanaryResult({
      ok,
      reason: run_result.reason,
      final_state: { ...run_result.state },
      events_emitted: run_result.events_emitted,
    });
  } finally {
    _set_canary_active(false);
  }
}
