/**
 * 执行运行时（ExecutionRuntime）：作用域装载 / 通道执行 / 汇聚点合成 / 护栏。
 *
 * 执行模型（§三）语义的运行时落地：执行 = **作用域转场循环**（非每会话组装的
 * 静态图）——从入口作用域开始 → 当前作用域加工（经 turn seam 跑模型回合）→ 按
 * 产物 `__next`（结构化声明，缺省回落先验/直收）决定下一转场 → 跨作用域一律过
 * 受控通道（route_planner 结构校验 + channel_gate 条件执行，fail-closed）→ 到
 * 汇聚点 = 会话收尾（唯一最终产物合成一次）。delegate(1→1)/fan-out(1→N) 派生的
 * 子执行各自独立 run_id/轨迹/成本；fan-in 按提交契约（full/best/decision_only）
 * 归并；降级/失败子执行只产摘要。护栏（步数/成本/并行）只兜底。
 *
 * 作用域轮次经 ScopeTurnRunner seam（真实默认 = engine_turn_runner 复用既有
 * executor/agent 机制件；测试注入 fake）。组织档案 ingest 经注入 sink（试跑用
 * 独立空档案隔离）。本模块无 IO/无全局状态：一次 run = 一个实例 + 传入依赖。
 */

import { default_scope_priors } from '../scopes/scope_priors.js';
import { validate_run_id } from '../org_archive/execution_trail.js';
import type { ScopePriorPattern } from '../scopes/scope_priors.js';
import type { TransitionApprovalSeam } from './channel_gate.js';
import { default_approval_seam } from './channel_gate.js';
import { normalize_guardrails } from './guardrails.js';
import { estuary_synthesize } from './fan_in.js';
import { parse_temp_scope_def, build_temp_scope_entity, temp_scope_id } from './temp_scope.js';
import { run_one, trail_from } from './run_loop.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionRuntimeDeps,
  LoadedScope,
  RunEvent,
  RunRecord,
} from './runtime_types.js';

/** run 运行期共享依赖/收集面（一次执行内传递；子 run 递归共用）。 */
export interface Core {
  deps: ExecutionRuntimeDeps;
  guards: ReturnType<typeof normalize_guardrails>;
  approval: TransitionApprovalSeam;
  priors: readonly ScopePriorPattern[];
  events: RunEvent[];
  runs: RunRecord[];
  seq: () => string;
}

function _event(
  run_id: string,
  parent: string | null,
  scope: string,
  action: string,
  detail: Record<string, unknown> | null,
): RunEvent {
  return { run_id, parent_run_id: parent, scope, action, detail };
}

/** 执行运行时（依赖注入；可复用于多次执行——无内部全局状态）。 */
export class ExecutionRuntime {
  readonly deps: ExecutionRuntimeDeps;
  #counter = 0;

  constructor(deps: ExecutionRuntimeDeps) {
    this.deps = {
      load_scope: deps.load_scope,
      channels: deps.channels,
      turn: deps.turn,
      approval: deps.approval ?? default_approval_seam(),
      priors: deps.priors ?? default_scope_priors(),
      boot_system_prompt: deps.boot_system_prompt ?? '',
      guardrails: deps.guardrails ?? {},
      on_event: deps.on_event,
      archive: deps.archive ?? null,
      estimate_cost: deps.estimate_cost,
      now_ms: deps.now_ms ?? (() => 0),
    };
  }

  /** 单次执行（根 run；返回汇聚点产物 + 执行树 + 事件带）。 */
  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const core: Core = {
      deps: this.deps,
      guards: normalize_guardrails(this.deps.guardrails ?? {}),
      approval: this.deps.approval ?? default_approval_seam(),
      priors: this.deps.priors ?? default_scope_priors(),
      events: [],
      runs: [],
      seq: (): string => {
        this.#counter += 1;
        return `run:${this.#counter}`;
      },
    };
    const emit = (event: RunEvent): void => {
      core.events.push(event);
      if (this.deps.on_event !== undefined) this.deps.on_event(event);
    };
    const entryScope = this.#load_entry(request, core);
    const rootId = request.run_id ?? core.seq();
    validate_run_id(rootId);
    if (entryScope === null) {
      emit(_event(rootId, null, request.entry_scope ?? 'main', 'run_blocked', null));
      return this.#blocked(rootId, request, core, entryScope, '入口作用域不可装载');
    }
    emit(_event(rootId, null, entryScope.id, 'run_start', { task: request.task }));
    const seed: Record<string, unknown> = { task: request.task, ...(request.seed_payload ?? {}) };
    const childOutcome = await run_one(
      core,
      {
        run_id: rootId,
        parent_run_id: null,
        scope: entryScope,
        trigger: request.trigger ?? null,
        payload: seed,
        hops: [],
        steps: 0,
        cost_acc: 0,
        degraded: [],
        children: [],
      },
      emit,
    );
    emit(_event(rootId, null, entryScope.id, 'run_end', null));
    const root = core.runs[core.runs.length - 1]!;
    const degraded = root.degraded_summaries;
    const final_product = estuary_synthesize(childOutcome.payload, [], degraded);
    return {
      root,
      final_product,
      degraded_summaries: degraded,
      runs: core.runs,
      trails: core.runs.map((r) => trail_from(r)),
      events: core.events,
      blocked: false,
      block_reason: null,
    };
  }

  /** 入口作用域装载（目录资产优先；entry_temp_scope = 现场定义）。 */
  #load_entry(request: ExecutionRequest, core: Core): LoadedScope | null {
    if (request.entry_temp_scope !== undefined && request.entry_temp_scope !== null) {
      const def = parse_temp_scope_def(request.entry_temp_scope);
      const id = temp_scope_id(request.run_id ?? 'entry', this.#counter);
      return build_temp_scope_entity(def, id);
    }
    return core.deps.load_scope(request.entry_scope ?? 'main');
  }

  /** 执行前阻断结果（入口不可装载等；fail-closed 不产出半成品）。 */
  #blocked(
    rootId: string,
    request: ExecutionRequest,
    core: Core,
    scope: LoadedScope | null,
    reason: string,
  ): ExecutionResult {
    const record: RunRecord = {
      run_id: rootId,
      parent_run_id: null,
      entry_scope: scope?.id ?? request.entry_scope ?? 'main',
      outcome: 'failure',
      hops: [],
      cost: { steps: 0 },
      degraded_summaries: [reason],
      children: [],
      error: reason,
    };
    core.runs.push(record);
    return {
      root: record,
      final_product: { degraded: [reason] },
      degraded_summaries: [reason],
      runs: core.runs,
      trails: core.runs.map((r) => trail_from(r)),
      events: core.events,
      blocked: true,
      block_reason: reason,
    };
  }
}
