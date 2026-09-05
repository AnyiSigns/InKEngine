// gate: 超限(391 行) - 多径运行器基段（接缝/嵌套深度护栏/支流执行真接线/审计收口同文件共享状态类型），拆文件扩散内部契约
/**
 * 多径运行器基段（multipath.py MultipathRunner 依赖面/审计段移植，1:1）。
 *
 * 本文件承载运行器与父引擎的接缝面与审计收口：
 * - multipath_branch_thread / multipath_branch_path：支流独立子链归属
 *   （``{父thread}:multipath:{index}``）与事件路径归属；
 * - 多径嵌套深度护栏的运行期计数（Python ContextVar 语义——支流经 fan_out
 *   继承父任务深度；TS 侧以模块变量 + 显式令牌形表达，_execute_branches
 *   负责 +1/复位，见下注）；
 * - MultipathRunnerBase：字段/构造、证据索引、预算余量查询、支流判败/
 *   转 Junction 口径、审计组装 + sink 回调。
 *
 * 支流执行（_execute_branches：子引擎展开/子链 checkpoint 续跑/事件并轨）
 * 经父引擎执行器（core/executor.Engine 结构面）接线：每条候选以独立实例
 * 引擎执行（_make_instance_engine 同源展开）+ checkpoint 独立子链续跑 +
 * fan_out 并发 + 中断提升为父图挂起卡 + 证据/步数护栏 + 事件计数并入父
 * 引擎——与 spawn 实例/推演分支的展开口径同构。
 */

import type { BudgetManager } from '../budget/budget.js';
import type { BudgetRemaining } from '../budget/budget_types.js';
import type { EdgeEvidenceStore } from '../edge_evidence/index.js';
import type { AssemblyCandidate, AssemblyRequest } from '../path_assembler/types.js';
import type { EngineEvent, EngineTransport } from '../events/events.js';
import type { Graph } from '../graph/graph.js';
import { TerminateReason } from '../graph/graph_types.js';
import { InterruptSignal } from '../interrupt/interrupt_types.js';
import type { RunResult } from '../run_result/run_result.js';
import type { RunOptions } from '../run_result/run_result.js';
import type { StateSchema } from '../state/schema.js';
import type { Storage } from '../storage/storage.js';
import type { TraceStep } from '../settle/index.js';
import { fan_out } from '../fanout/fanout.js';
import { tail_checkpoint } from '../recovery/index.js';
import { is_merge_reducer } from '../state/reducers.js';
import { subgraph_overlay_delta } from '../state/schema.js';
import { MultiPathConfig } from './config.js';
import {
  chain_edge_refs,
  chain_evidence,
  chain_terminal_fields,
  evidence_index_of,
  type EvidenceIndex,
} from './evidence.js';
import { JunctionBranch } from './junction_types.js';
import { BudgetView, MultiPathBranchResult, MultiPathResult } from './results.js';

// ── 多径嵌套深度（运行期护栏计数；0 = 顶层多径）───────────────────
// Python 用 contextvars.ContextVar（fan_out 子任务继承父任务深度，支流子
// 引擎内天然可见）；TS 侧零依赖 async-local 未引入前以模块变量表达，令牌
// 语义（set → 返回前一值；reset(前值)）与 Python set/reset 同构——
// _execute_branches 以 fan_out 整体包裹 +1/复位（并发行内嵌套多径的深度
// 隔离需任务级 async-local 支撑，落地后收敛实现）。
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

/** 支流子引擎执行选项（_execute 的面收窄；真实引擎签名接受超集）。 */
export interface MultipathExecuteOptions {
  state: Record<string, unknown>;
  thread_id: string;
  round_id: string | null;
  resume_from: number | null;
  trace_id: string;
  queue: null;
  graph_path: readonly string[];
  transports: EngineTransport[];
  checkpoint_thread_id: string;
}

/**
 * 支流子引擎结构面（_make_instance_engine 产物；executor.Engine 满足）。
 * 携带父引擎轨迹合并所需的载体字段（_trace_merge_from 的参数兼容面）。
 */
export interface MultipathSubEngine {
  readonly options: { schema: StateSchema | null };
  _chain_advanced: boolean;
  _event_counter: number;
  _latest_event_seq: number | null;
  executed_node_steps: number;
  _run_trace: TraceStep[];
  _trace_graphs: Map<string, Graph>;
  _node_tokens: Map<string, number>;
  _execute(opts: MultipathExecuteOptions): Promise<[Record<string, unknown>, RunResult]>;
}

/**
 * 父引擎接缝面（MultipathRunner 构造注入；executor.Engine 结构满足）。
 *
 * 与 Python 侧一致：multipath 只按 TYPE_CHECKING 依赖 executor.Engine——
 * 此处以结构面钉住运行器可达的只读运行面（预算余量查询 + 支流执行所需的
 * 实例工厂/计数/轨迹/链压缩/选项传播），真实接线见 _engine_multipath.ts
 * （executor 侧把 Engine 实例注入 MultipathRunner）。
 */
export interface MultipathEngineLike {
  readonly options: RunOptions;
  _make_instance_engine(subgraph: Graph, spawn_depth: number): MultipathSubEngine;
  _event_counter: number;
  _latest_event_seq: number | null;
  _trace_merge_from(sub_engine: MultipathSubEngine): void;
  _maybe_compact_chain(thread_id: string): Promise<void>;
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
   * 每条候选 = 独立实例引擎执行（子链深度 = 父深度 + 1，事件统一父链、
   * checkpoint 独立子链 ``{父thread}:multipath:{index}``），按候选位置
   * 声明序回填结果；执行语义与 spawn 实例/推演分支同构：
   * - 入口状态 = runner 注入的 entry_state 快照（合并累加族通道归零——
   *   回流增量防二次加和）；
   * - 恢复：支流从自身子链尾续跑（中断/未终态 checkpoint）；终态链尾 =
   *   陈旧结果，从头执行；
   * - 支流内中断提升为父图挂起卡（fan_out propagate，经 run() 上抛给
   *   调用方）；终态 error/步数超限 = 该支流失败（剔除留痕，结果带失败
   *   原因回填——汇流裁决按失败归约）；
   * - 支流事件计数/seq 锚点/轨迹并入父引擎（审计连续，父引擎后续
   *   checkpoint 锚点含支流事件 seq）；
   * - 证据（chain_evidence + 域内索引）随结果回填（裁决输入口径）。
   */
  protected async _execute_branches(
    candidates: readonly AssemblyCandidate[],
    _request: AssemblyRequest,
    opts: {
      entry_state: Record<string, unknown>;
      thread_id: string;
      round_id: string | null;
      trace_id: string;
      concurrency: number;
      inject: Record<string, unknown> | null;
      evidence_index: EvidenceIndex;
      transports?: EngineTransport[] | null;
    },
  ): Promise<MultiPathBranchResult[]> {
    const engine = this._engine;
    const parent_options = engine.options;
    const child_depth = parent_options.spawn_depth + 1;
    const branch_results: Array<MultiPathBranchResult | null> = new Array(candidates.length).fill(null);
    const run_one = async (position: number): Promise<void> => {
      const candidate = candidates[position];
      if (candidate === undefined) {
        throw new Error(`多径支流候选缺失（position=${position}）`);
      }
      const sub_engine = engine._make_instance_engine(candidate.graph, child_depth);
      const sub_path = multipath_branch_path(position);
      const branch_thread = multipath_branch_thread(opts.thread_id, position);
      // 入口状态自包含（与 spawn 实例/推演分支同语义：各支共享的回合任务输入
      // 快照，合并累加族通道归零——回流增量 = 支流内新增）
      const entry_state: Record<string, unknown> = { ...opts.entry_state };
      const sub_schema = sub_engine.options.schema;
      if (sub_schema !== null) {
        for (const [key, channel] of Object.entries(sub_schema.channels)) {
          if (is_merge_reducer(channel.reducer) && key in entry_state) {
            entry_state[key] = {};
          }
        }
      }
      // 恢复：支流从自身子链尾续跑（中断/未终态 checkpoint 续跑，同 spawn
      // 实例语义）；终态链尾（reply/stop/error = 陈旧结果）从头执行。
      let resume_from: number | null = null;
      if (parent_options.storage !== null) {
        const tail = await tail_checkpoint(parent_options.storage, branch_thread);
        if (tail !== null && (tail.reason === null || tail.reason === 'interrupted')) {
          resume_from = tail.checkpoint_id;
        }
        sub_engine._chain_advanced = true;
      }
      const [final_state, sub_result] = await sub_engine._execute({
        state: entry_state,
        thread_id: opts.thread_id,
        round_id: opts.round_id,
        resume_from,
        trace_id: opts.trace_id,
        queue: null,
        graph_path: sub_path,
        // 事件统一父链：支流事件汇入父事件流（与 spawn/推演分支同口径）
        transports: opts.transports ?? parent_options.transports,
        checkpoint_thread_id: branch_thread,
      });
      // 支流事件并入父引擎计数与 seq 锚点（事件统一落父链日志，父引擎后续
      // checkpoint 须以含支流事件的最新 seq 为锚，防恢复重放重复）
      engine._event_counter += sub_engine._event_counter;
      // 支流轨迹并入父引擎（结点级成败留痕跨层连续）
      engine._trace_merge_from(sub_engine);
      if (sub_engine._latest_event_seq !== null) {
        engine._latest_event_seq =
          engine._latest_event_seq === null
            ? sub_engine._latest_event_seq
            : Math.max(engine._latest_event_seq, sub_engine._latest_event_seq);
      }
      // 支流独立子链执行链级 rebase（支流链长有界化；事件日志归父链不裁剪）
      await engine._maybe_compact_chain(branch_thread);
      // 支流内中断 → 提升为父图 interrupt（挂起卡跨层保留，重入语义一致）
      if (sub_result.interrupt !== null) {
        throw new InterruptSignal(sub_result.interrupt.key, sub_result.interrupt.payload);
      }
      // 支流步数截止护栏（与推演分支/spawn 实例同口径）：执行步数超限 = 该
      // 支流失败（剔除留痕，汇流按失败归约）；0 = 按数据声明不校验
      const step_limit = parent_options.simulate_max_branch_steps;
      if (step_limit > 0 && sub_engine.executed_node_steps > step_limit) {
        throw new Error(`多径支流步数超限: ${sub_engine.executed_node_steps} > ${step_limit}`);
      }
      // 支流终态为 ERROR：不入回流（剔除留痕，汇流按失败归约）
      if (sub_result.reason === TerminateReason.ERROR) {
        throw new Error(sub_result.error ?? `多径支流执行失败（index=${position}）`);
      }
      // 回流增量（delta = 支流内实际变化，防 reducer 加和翻倍）
      const overlay = subgraph_overlay_delta(entry_state, final_state, sub_schema);
      branch_results[position] = this._branch_result(
        candidate,
        position,
        opts.evidence_index,
        sub_path,
        branch_thread,
        overlay,
        final_state,
        sub_result.reason,
        null,
      );
    };

    // 嵌套深度护栏：支流执行期间深度 +1（嵌套多径按一级计）；fan_out 收口
    // 后复位（含中断传播路径）
    const previous_depth = _multipath_depth_set(_multipath_depth_get() + 1);
    try {
      const outcome = await fan_out(
        candidates.map((_c, pos) => async (): Promise<void> => {
          await run_one(pos);
        }),
        Math.max(1, opts.concurrency),
        { propagate: InterruptSignal },
      );
      // 失败支流回填（结果带失败原因：汇流裁决据此归约败者）
      for (const failure of outcome.failures) {
        const candidate = candidates[failure.index];
        if (candidate === undefined) continue;
        branch_results[failure.index] = this._branch_result(
          candidate,
          failure.index,
          opts.evidence_index,
          multipath_branch_path(failure.index),
          multipath_branch_thread(opts.thread_id, failure.index),
          {},
          { ...opts.entry_state },
          TerminateReason.ERROR,
          failure.error,
        );
      }
    } finally {
      _multipath_depth_reset(previous_depth);
    }
    // 未回填槽位兜底（正常执行不会发生；fan_out propagate 中断路径已上抛）
    return branch_results.map(
      (branch, position) =>
        branch ??
        this._branch_result(
          candidates[position] as AssemblyCandidate,
          position,
          opts.evidence_index,
          multipath_branch_path(position),
          multipath_branch_thread(opts.thread_id, position),
          {},
          { ...opts.entry_state },
          TerminateReason.ERROR,
          '多径支流未执行（并发调度中断）',
        ),
    );
  }

  /** 支流结果组装（成功/失败共用：终态 + 归因口径 + 子链锚点）。 */
  private _branch_result(
    candidate: AssemblyCandidate,
    position: number,
    evidence_index: EvidenceIndex,
    sub_path: readonly string[],
    branch_thread: string,
    overlay: Record<string, unknown>,
    final_state: Record<string, unknown>,
    terminal: string,
    error: string | null,
  ): MultiPathBranchResult {
    return new MultiPathBranchResult({
      index: position,
      chain: candidate.chain,
      digest: candidate.graph.digest(),
      overlay,
      final_state,
      terminal,
      error,
      interrupt: null,
      evidence: chain_evidence(candidate, evidence_index),
      thread_id: branch_thread,
      graph_path: sub_path,
      terminal_fields: chain_terminal_fields(candidate),
      edge_refs: chain_edge_refs(candidate),
    });
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
