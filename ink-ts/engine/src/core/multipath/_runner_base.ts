/**
 * 多径运行器基段（multipath.py MultipathRunner 依赖面/审计段移植，1:1）。
 *
 * 本文件承载运行器与父引擎的接缝面与审计收口：
 * - multipath_branch_thread / multipath_branch_path：支流独立子链归属
 *   （``{父thread}:multipath:{index}``）与事件路径归属；
 * - 多径嵌套深度护栏的运行期计数（Python ContextVar 语义——支流经 fan_out
 *   继承父任务深度；TS 侧 executor 未迁移前以模块变量 + 显式令牌形表达，
 *   支流执行接线时由 _execute_branches 自增/复位，见 runner.ts 头注）；
 * - MultipathRunnerBase：字段/构造、证据索引、预算余量查询、支流判败/
 *   转 Junction 口径、审计组装 + sink 回调。
 *
 * 支流执行（_execute_branches：子引擎展开/子链 checkpoint 续跑/事件并轨）
 * 依赖引擎执行器（core/executor.Engine），executor 模块尚未迁移——按 defer
 * 预留：入口保持 Python 同形签名，执行体抛明确的未迁移错误（参照
 * path_assembler/canary.ts 的 defer 先例）。
 */

import type { BudgetManager } from '../budget/budget.js';
import type { BudgetRemaining } from '../budget/budget_types.js';
import type { EdgeEvidenceStore } from '../edge_evidence/index.js';
import type { AssemblyCandidate, AssemblyRequest } from '../path_assembler/types.js';
import { MultiPathConfig } from './config.js';
import {
  evidence_index_of,
  type EvidenceIndex,
} from './evidence.js';
import { JunctionBranch } from './junction_types.js';
import { BudgetView, MultiPathBranchResult, MultiPathResult } from './results.js';

// ── 多径嵌套深度（运行期护栏计数；0 = 顶层多径）───────────────────
// Python 用 contextvars.ContextVar（fan_out 子任务继承父任务深度，支流子
// 引擎内天然可见）；TS 侧零依赖 async-local 未引入前以模块变量表达，令牌
// 语义（set → 返回前一值；reset(前值)）与 Python set/reset 同构——_execute
// _branches 负责 +1/复位，executor 落地后如需任务级隔离再收敛实现。
let _multipath_depth = 0;

/** 当前多径嵌套深度（护栏读取口）。 */
export function _multipath_depth_get(): number {
  return _multipath_depth;
}

/** 多径嵌套深度 +1（返回前一值 = 令牌；收口时 _reset 还原）。 */
export function _multipath_depth_set(value: number): number {
  const previous = _multipath_depth;
  _multipath_depth = value;
  return previous;
}

/** 多径嵌套深度复位（令牌还原）。 */
export function _multipath_depth_reset(previous: number): void {
  _multipath_depth = previous;
}

/** 支流独立子链归属：``{父thread}:multipath:{index}``。 */
export function multipath_branch_thread(parent_thread: string, index: number): string {
  return `${parent_thread}:multipath:${index}`;
}

/** 支流事件路径归属（事件统一父链 + 路径标记）。 */
export function multipath_branch_path(index: number): readonly string[] {
  return ['multipath', String(index)];
}

/**
 * 父引擎接缝面（MultipathRunner 构造注入）。
 *
 * Python 侧为 core/executor.Engine（TYPE_CHECKING 导入）；executor 未迁移，
 * 此处只钉住运行器当前可达的最小只读面（预算余量查询）。支流执行所需的
 * options.storage/schema/transports/spawn_depth/simulate_max_branch_steps 与
 * _make_instance_engine/_execute/_trace_merge_from 等随 _execute_branches
 * 落地（executor 迁移后扩展本接口并接线，见 runner.ts defer 说明）。
 */
export interface MultipathEngineLike {
  readonly options: { budget: BudgetManager | null };
}

/** 多径运行器基类（字段 + 支流/审计私助；run 编排见 runner.ts）。 */
export abstract class MultipathRunnerBase {
  protected readonly _engine: MultipathEngineLike;
  protected readonly _store: EdgeEvidenceStore | null;
  protected readonly _config: MultiPathConfig | null;
  protected readonly _sink: ((record: Record<string, unknown>) => void) | null;
  protected readonly _now: number | null;

  constructor(
    engine: MultipathEngineLike,
    opts: {
      evidence_store?: EdgeEvidenceStore | null;
      config?: MultiPathConfig | null;
      sink?: ((record: Record<string, unknown>) => void) | null;
      now?: number | null;
    } = {},
  ) {
    this._engine = engine;
    this._store = opts.evidence_store ?? null;
    this._config = opts.config ?? null;
    this._sink = opts.sink ?? null;
    this._now = opts.now ?? null;
  }

  /** 域内证据索引（无存储 = 空索引 = 零证据口径）。 */
  protected async _evidence_index(domain: string): Promise<EvidenceIndex> {
    if (this._store === null) return new Map();
    const rows = await this._store.list_edges(domain);
    return evidence_index_of(rows);
  }

  /** 预算余量只读查询（BudgetManager.query_remaining；无管理器 = 空）。 */
  protected async _budget_remaining(): Promise<BudgetRemaining[]> {
    const manager = this._engine.options.budget;
    if (manager === null) return [];
    return manager.query_remaining(new BudgetView());
  }

  /**
   * 支流并行执行（子链隔离 + 事件统一父链；与既有子链同构）。
   *
   * **defer 预留**：Python 语义 = 每条候选独立子引擎执行（_make_instance_
   * engine）+ checkpoint 独立子链续跑 + fan_out 并发 + 中断/取消语义 +
   * 证据/步数护栏 + 事件计数并入父引擎；引擎执行器（core/executor.Engine）
   * 未迁移，本入口暂不可执行——executor 落地后按上述语义接线并补支流执行
   * 类测试（参数保持 Python 同形，避免接线侧签名漂移）。
   */
  protected async _execute_branches(
    _candidates: readonly AssemblyCandidate[],
    _request: AssemblyRequest,
    _opts: {
      entry_state: Record<string, unknown>;
      thread_id: string;
      round_id: string | null;
      trace_id: string;
      concurrency: number;
      inject: Record<string, unknown> | null;
      evidence_index: EvidenceIndex;
    },
  ): Promise<MultiPathBranchResult[]> {
    throw new Error(
      'MultipathRunner 支流执行（_execute_branches）依赖引擎执行器（core/executor.' +
        'Engine），executor 模块未迁移——本入口按 defer 预留，暂不可执行',
    );
  }

  /** 支流判败：terminal=error 或携带失败原因 = 失败支流。 */
  protected _failed(branch: MultiPathBranchResult): boolean {
    return branch.terminal === 'error' || branch.error !== null;
  }

  /** 支流执行结果 → Junction 裁决输入（口径转换）。 */
  protected _as_junction_branch(branch: MultiPathBranchResult): JunctionBranch {
    return new JunctionBranch({
      index: branch.index,
      chain: branch.chain,
      overlay: { ...branch.overlay },
      terminal_fields: branch.terminal_fields,
      edge_refs: branch.edge_refs,
      evidence: branch.evidence,
      graph_path: branch.graph_path,
    });
  }

  /** 审计组装 + 回调发射（append-only；失败留痕同样经回调）。 */
  protected _finalize_result(
    result: MultiPathResult,
    request: AssemblyRequest,
    trace_id: string,
    opts: {
      run_record: Record<string, unknown>;
      junction_record?: Record<string, unknown> | null;
    },
  ): MultiPathResult {
    const ts = this._now !== null ? this._now : Date.now() / 1000;
    const records: Record<string, unknown>[] = [
      { ts, domain: request.domain, trace_id, ...opts.run_record },
    ];
    if (opts.junction_record !== null && opts.junction_record !== undefined) {
      records.push(opts.junction_record);
    }
    const out = new MultiPathResult({
      triggered: result.triggered,
      k: result.k,
      candidates: result.candidates,
      base_cost: result.base_cost,
      budget_required: result.budget_required,
      budget_passed: result.budget_passed,
      budget_note: result.budget_note,
      degraded_reason: result.degraded_reason,
      branches: result.branches,
      verdict: result.verdict,
      thread_ids: { ...result.thread_ids },
      updates: result.updates,
      audit: records,
    });
    if (this._sink !== null) {
      for (const record of records) {
        this._sink({ ...record });
      }
    }
    return out;
  }
}
