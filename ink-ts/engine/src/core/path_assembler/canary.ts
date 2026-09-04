/**
 * canary 兼容验证链路（path_assembler.py「canary 兼容验证链路」段移植）。
 *
 * canary = 重建 + 单回合执行（风险前置：产物执行前的结构/走通校验）。
 * 重建级校验（canary_instantiate = Graph.from_dict(validate=True)）已完整
 * 落地；单回合执行（canary_round）依赖引擎执行器（core/executor.Engine），
 * executor 模块尚未迁移——本文件按「defer 预留」处理：入口保持 Python 同形
 * 签名，执行体抛出明确的未迁移错误；步数上限预算（canary_budget / 步数策略）
 * 不依赖执行器，已按 Python 语义落地。canary 执行态标记（canary_active）为
 * 模块级上下文位（executor 落地后由 canary_round 入口置位/出口复位）。
 *
 * 关联测试（依赖 executor 的执行类用例）随本文件一并 defer（见测试文件头注）。
 */

import type { NodeTypeRegistry } from '../registry/registry.js';
import { Graph } from '../graph/graph.js';
import { BudgetExceededError, BudgetManager } from '../budget/budget.js';
import type { BudgetPolicy } from '../budget/budget_types.js';
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

/** 单回合执行结果（无存储、无预算约束；stub 模型由使用方 RunOptions 注入）。 */
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

// ── canary 执行态标记（模块级上下文位；executor 落地后由 canary_round
//   入口置位、出口复位——结点层据此桩化真实执行体）─────────────────
let _canary_active = false;

/** 当前是否处于 canary 执行态（结点层桩化判定）。 */
export function canary_active(): boolean {
  return _canary_active;
}

/** canary 执行态置位/复位（canary_round 入口/出口使用；executor 落地接线）。 */
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
 * stub 一回合执行：图合法 + 单回合走通——**defer 预留**。
 *
 * Python 语义：Engine(graph, options).ainvoke(entry_state) 执行单回合（canary
 * 态置位、预算缺省注入、超时 wait_for、正常收尾 reply/stop 且无挂起 = 通过）。
 * 引擎执行器（core/executor.Engine）未迁移，本入口暂不可执行；executor 落地
 * 后按上述语义接线并补 canary 执行类测试。参数保持 Python 同形（entry_state/
 * options/canary_timeout），避免接线侧签名漂移。
 */
export async function canary_round(
  _graph: Graph,
  _opts: {
    entry_state?: Record<string, unknown> | null;
    options?: unknown | null;
    canary_timeout?: number | null;
  } = {},
): Promise<CanaryResult> {
  throw new Error(
    'canary_round：依赖引擎执行器（core/executor.Engine），executor 模块未迁移——' +
      '本入口按 defer 预留，暂不可执行（重建级校验请用 canary_instantiate）',
  );
}
