// gate: 超限(361 行) - 多径 run 编排单段状态机（降级/分叉/汇总/留痕同流），拆文件破状态连续
/**
 * 多径运行器 run 编排（multipath.py MultipathRunner.run 段移植，1:1）。
 *
 * run() = 一次多径执行：触发判据（开关/预算/径数/嵌套护栏）→ 降级单径
 * 或候选并行执行 → 汇流裁决 → 证据回写 → 审计组装。只执行不判定触发
 * （触发信号由组装侧判定后传入）。
 *
 * 支流执行（_execute_branches，见 _runner_base.ts）经父引擎执行器真接线：
 * 每条候选独立实例引擎执行 + 子链 checkpoint 续跑 + 事件并轨（与 spawn/
 * 推演分支同构）。运行器只持父引擎结构面（MultipathEngineLike），实例由
 * executor 侧注入——开关关闭/无候选的零生效路径不触达引擎内部。
 */

import type { BudgetRemaining } from '../budget/budget_types.js';
import type { QualityGate } from '../contracts/contracts.js';
import type { EngineTransport } from '../events/events.js';
import type { AssemblyCandidate, AssemblyRequest } from '../path_assembler/types.js';
import { check_multipath_budget, multipath_budget_required, MultiPathConfig } from './config.js';
import {
  DEFAULT_MULTIPATH_K,
  HIGH_RISK_SAFETY_TIER,
  MODE_NONE,
  MODE_SYNTHETIC,
} from './constants.js';
import { chain_evidence } from './evidence.js';
import { JunctionSynthContext, JunctionVerdict } from './junction_types.js';
import type { JunctionBranch } from './junction_types.js';
import {
  MultipathRunnerBase,
  _multipath_depth_get,
} from './_runner_base.js';
import {
  apply_junction_updates,
  junction_audit_record,
  plan_junction_updates,
} from './updates.js';
import type { JunctionSynthProvider } from './verdict.js';
import { junction_verdict } from './verdict.js';
import type { MultiPathBranchResult } from './results.js';
import { MultiPathResult } from './results.js';
import type { JunctionEvidenceUpdate } from './updates.js';

/** 缺省 trace id（镜像 Python f"multipath-{time.time_ns():x}"；注入可覆盖）。 */
function default_trace_id(): string {
  return `multipath-${Math.floor(Date.now() * 1000).toString(16)}`;
}

/** 支流序号 → 独立子链线程 id（回溯/换选锚点）。 */
function thread_index_map(
  branches: readonly MultiPathBranchResult[],
): Record<number, string> {
  const map: Record<number, string> = {};
  for (const b of branches) map[b.index] = b.thread_id;
  return map;
}

/** 多径运行器：候选集并行执行 → 汇流裁决 → 证据回写。 */
export class MultipathRunner extends MultipathRunnerBase {
  /**
   * 执行一次多径（触发判据复用组装信号的语义；只执行不判定触发）。
   *
   * @param request 组装请求（安全档/闸门/域；k=3 高风险门限按
   *   max_safety_tier ≥ 1 判定）。
   * @param candidates 候选路径（取前 k 条执行）。
   * @param opts.entry_state 支流入口状态（各支相同的自包含任务输入）。
   * @param opts.thread_id 回合线程 id（事件统一父链 + 子链归属）。
   * @param opts.round_id / trace_id 事件契约透传。
   * @param opts.k 径数（缺省 = 配置 default_k；上界 = max_k 与候选数）。
   * @param opts.concurrency 支流并发上限（缺省 = 配置值）。
   * @param opts.quality_gate 质量闸门（缺省 = 请求注入；同构择优用）。
   * @param opts.synth_provider 合成源（异构输出合成用；合成源归使用方）。
   * @param opts.inject 中断注入值（{key: value} 一次性；重入语义与引擎一致）。
   * @param opts.transports 支流事件传输链（null = 父引擎 options.transports；
   *   引擎 run 队列等顶层链路经此下传——事件统一父链）。
   * @param opts.budget_remaining 预算余量（缺省 = 经引擎 BudgetManager 只读
   *   查询；预检 fail-closed）。
   */
  async run(
    request: AssemblyRequest,
    candidates: readonly AssemblyCandidate[],
    opts: {
      entry_state: Record<string, unknown>;
      thread_id: string;
      round_id?: string | null;
      trace_id?: string | null;
      k?: number | null;
      concurrency?: number | null;
      quality_gate?: QualityGate | null;
      synth_provider?: JunctionSynthProvider | null;
      inject?: Record<string, unknown> | null;
      transports?: EngineTransport[] | null;
      budget_remaining?: readonly BudgetRemaining[] | null;
    },
  ): Promise<MultiPathResult> {
    const config = this._config ?? new MultiPathConfig();
    if (!config.enabled) {
      return new MultiPathResult({
        triggered: false,
        k: 0,
        candidates: candidates.length,
        budget_note: '机制开关关闭（默认全关），未触发',
      });
    }
    if (candidates.length === 0) {
      return new MultiPathResult({
        triggered: false,
        k: 0,
        candidates: 0,
        budget_note: '无候选（组装未解出），未触发',
      });
    }
    const evidence_index = await this._evidence_index(request.domain);
    const trace_id = opts.trace_id ?? default_trace_id();
    const round_id = opts.round_id ?? null;
    const inject = opts.inject ?? null;
    const desired = opts.k !== null && opts.k !== undefined ? Math.trunc(opts.k) : config.default_k;
    let k_eff = Math.max(1, Math.min(desired, candidates.length, config.max_k));
    const degradations: string[] = [];
    // k>2 仅高风险任务放行（max_safety_tier ≥ 1），否则降为 2
    if (
      k_eff > DEFAULT_MULTIPATH_K &&
      request.max_safety_tier < HIGH_RISK_SAFETY_TIER
    ) {
      const degradation = 'k>2 仅高风险任务放行（max_safety_tier ≥ 1），已降为 2';
      k_eff = DEFAULT_MULTIPATH_K;
      degradations.push(degradation);
    }
    // 多径嵌套护栏：嵌套深度 ≥ 上限直接降级单径 + 审计注明
    const nesting = _multipath_depth_get();
    if (nesting >= config.max_nesting) {
      k_eff = 1;
      degradations.push(
        `多径嵌套超限（深度 ${nesting} ≥ 上限 ${config.max_nesting}），降级单径执行`,
      );
    }
    if (k_eff < 2) {
      let branch_results: readonly MultiPathBranchResult[] = [];
      if (k_eff === 1) {
        branch_results = await this._execute_branches(
          candidates.slice(0, 1),
          request,
          {
            entry_state: opts.entry_state,
            thread_id: opts.thread_id,
            round_id,
            trace_id,
            concurrency: 1,
            inject,
            evidence_index,
            transports: opts.transports ?? null,
          },
        );
      }
      const degraded =
        degradations.length > 0 ? degradations.join('; ') : '候选不足（<2 条），单径执行';
      const result = new MultiPathResult({
        triggered: false,
        k: k_eff,
        candidates: candidates.length,
        degraded_reason: degraded,
        budget_note: degraded.startsWith('多径嵌套超限')
          ? '多径嵌套超限，未触发多径'
          : '候选不足，未触发多径',
        branches: branch_results,
        thread_ids: thread_index_map(branch_results),
      });
      return this._finalize_result(result, request, trace_id, {
        run_record: {
          triggered: false,
          k: k_eff,
          base_cost: 0.0,
          budget_required: 0.0,
          budget_passed: true,
          budget_note: result.budget_note,
          degraded_reason: degraded,
        },
      });
    }
    // 预算预检（fail-closed）：需求 B×(1+(k-1)ρ) ≤ 各维度最小余量才放行
    const base_cost = chain_evidence(candidates[0]!, evidence_index).cost_estimate;
    const required = multipath_budget_required(base_cost, k_eff, {
      rho: config.shared_rho,
    });
    const remaining =
      opts.budget_remaining !== null && opts.budget_remaining !== undefined
        ? opts.budget_remaining
        : await this._budget_remaining();
    const [budget_ok, budget_note] = check_multipath_budget(
      remaining,
      base_cost,
      k_eff,
      { rho: config.shared_rho },
    );
    if (!budget_ok) {
      k_eff = 1;
      degradations.push(`预算预检拒绝（${budget_note}），降级单径执行`);
    }
    if (k_eff < 2) {
      const branch_results = await this._execute_branches(
        candidates.slice(0, 1),
        request,
        {
          entry_state: opts.entry_state,
          thread_id: opts.thread_id,
          round_id,
          trace_id,
          concurrency: 1,
          inject,
          evidence_index,
          transports: opts.transports ?? null,
        },
      );
      const degraded = degradations.length > 0 ? degradations.join('; ') : null;
      const result = new MultiPathResult({
        triggered: false,
        k: 1,
        candidates: candidates.length,
        base_cost,
        budget_required: required,
        budget_passed: budget_ok,
        budget_note,
        degraded_reason: degraded,
        branches: branch_results,
        thread_ids: thread_index_map(branch_results),
      });
      return this._finalize_result(result, request, trace_id, {
        run_record: {
          triggered: false,
          k: 1,
          base_cost,
          budget_required: required,
          budget_passed: budget_ok,
          budget_note,
          degraded_reason: degraded,
        },
      });
    }
    // 支流并行执行 + 汇流裁决 + 证据回写
    const branch_results = await this._execute_branches(
      candidates.slice(0, k_eff),
      request,
      {
        entry_state: opts.entry_state,
        thread_id: opts.thread_id,
        round_id,
        trace_id,
        concurrency:
          opts.concurrency !== null && opts.concurrency !== undefined
            ? opts.concurrency
            : config.concurrency,
        inject,
        evidence_index,
        transports: opts.transports ?? null,
      },
    );
    const failed_indexes = branch_results
      .filter((b) => this._failed(b))
      .map((b) => b.index);
    const successful = branch_results.filter((b) => !this._failed(b));
    let verdict: JunctionVerdict | null = null;
    let updates: readonly JunctionEvidenceUpdate[] = [];
    let junction_branches: readonly JunctionBranch[] = [];
    if (successful.length > 0) {
      junction_branches = successful.map((b) => this._as_junction_branch(b));
      const effective_gate =
        opts.quality_gate !== null && opts.quality_gate !== undefined
          ? opts.quality_gate
          : request.quality_gate;
      verdict = await junction_verdict(junction_branches, {
        domain: request.domain,
        goal: request.goal_fields(),
        quality_gate: effective_gate,
        synth_provider: opts.synth_provider ?? null,
        now: this._now,
      });
      const all_branches = branch_results.map((b) => this._as_junction_branch(b));
      updates = plan_junction_updates(verdict, all_branches, {
        domain: request.domain,
        failed_indexes,
      });
    } else {
      if (opts.synth_provider !== null && opts.synth_provider !== undefined) {
        let selection: Record<string, unknown> | null = null;
        try {
          const context = new JunctionSynthContext({
            domain: request.domain,
            goal: request.goal_fields(),
            branches: branch_results.map((b) => this._as_junction_branch(b)),
            notes: ['全部支流执行失败'],
          });
          selection = await opts.synth_provider.synthesize(context);
        } catch {
          selection = null;
        }
        if (selection !== null) {
          verdict = new JunctionVerdict({
            mode: MODE_SYNTHETIC,
            homogeneous: false,
            winner: null,
            selection: { ...selection },
            reasons: ['全部支流执行失败，经合成源合成'],
            losers: branch_results.map((b) => b.index),
          });
        }
      }
      if (verdict === null) {
        verdict = new JunctionVerdict({
          mode: MODE_NONE,
          homogeneous: false,
          winner: null,
          selection: {},
          reasons: ['全部支流执行失败，且无合成源'],
          losers: branch_results.map((b) => b.index),
        });
      }
      const all_branches = branch_results.map((b) => this._as_junction_branch(b));
      updates = plan_junction_updates(verdict, all_branches, {
        domain: request.domain,
        failed_indexes,
      });
    }
    if (this._store !== null && updates.length > 0) {
      await apply_junction_updates(this._store, updates, { now: this._now ?? null });
    }
    const result = new MultiPathResult({
      triggered: true,
      k: k_eff,
      candidates: candidates.length,
      base_cost,
      budget_required: required,
      budget_passed: budget_ok,
      budget_note,
      degraded_reason: degradations.length > 0 ? degradations.join('; ') : null,
      branches: branch_results,
      verdict,
      thread_ids: thread_index_map(branch_results),
      updates,
    });
    const junction_record =
      verdict !== null
        ? junction_audit_record(
            verdict,
            junction_branches.length > 0
              ? junction_branches
              : branch_results.map((b) => this._as_junction_branch(b)),
            {
              domain: request.domain,
              fingerprint: result.branches.length > 0 ? result.branches[0]!.digest : '',
              ts: this._now !== null ? this._now : Date.now() / 1000,
            },
          )
        : null;
    return this._finalize_result(result, request, trace_id, {
      run_record: {
        triggered: true,
        k: k_eff,
        base_cost,
        budget_required: required,
        budget_passed: budget_ok,
        budget_note,
        degraded_reason: degradations.length > 0 ? degradations.join('; ') : null,
      },
      junction_record,
    });
  }
}
