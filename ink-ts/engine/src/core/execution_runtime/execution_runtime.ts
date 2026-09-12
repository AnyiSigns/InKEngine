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
 * 挂起/恢复 seam（W7-D）：通道/工具审批在 review 档不再 fail-closed 阻断——run
 * 循环写执行级 checkpoint（run_id 命名空间子链，复用 §十保留件：checkpoint 链 +
 * kernel/interrupt InterruptCoordinator + kernel/recovery 恢复解析）后抛
 * InterruptSignal 挂起，本层把结果标记 pending_approval（含挂起卡 + root 链尾
 * 锚点）；宿主弹卡决议后经 resume_from + resume_inject 续跑（恢复跳过已完成
 * turn，子执行按子链尾重建不重跑）。§7.3 中断注入（等/注入/中止改用）的注入与
 * 中止 seam 在 ExecutionRuntimeDeps（next_user_input / abort_requested）。
 *
 * 作用域轮次经 ScopeTurnRunner seam（真实默认 = engine_turn_runner 复用既有
 * executor/agent 机制件；测试注入 fake）。组织档案 ingest 经注入 sink（试跑用
 * 独立空档案隔离）。本模块无 IO/无全局状态：一次 run = 一个实例 + 传入依赖。
 */

import { default_scope_priors } from '../../model/scopes/scope_priors.js';
import { validate_run_id } from '../org_archive/execution_trail.js';
import type { ScopePriorPattern } from '../../model/scopes/scope_priors.js';
import type { TransitionApprovalSeam } from './channel_gate.js';
import {
  channel_approval_key,
  default_approval_seam,
  normalize_injected_decision,
} from './channel_gate.js';
import { normalize_guardrails } from './guardrails.js';
import { run_one } from './run_loop.js';
import {
  exec_chain_tail,
  resolve_exec_checkpoint,
  write_exec_checkpoint,
  type RunPhase,
} from './run_checkpoint.js';
import {
  _event,
  blocked_result,
  finish_result,
  load_entry,
  load_whiteboard,
  pending_result,
} from './run_result.js';
import { InterruptCoordinator } from '../../kernel/interrupt/interrupt.js';
import { InterruptSignal, InterruptState } from '../../kernel/interrupt/interrupt_types.js';
import type { CheckpointRecord } from '../storage/storage_records.js';
import type { Storage } from '../storage/storage.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionRuntimeDeps,
  RunEvent,
  RunRecord,
  RunState,
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
  /** 中断协调器（注入值挂载/宽容消费/gate 发卡计数；run 级共享）。 */
  coordinator: InterruptCoordinator;
  /** 挂起恢复态（恢复时子 run 按子链尾重建，已完成子执行不重跑）。 */
  resuming: boolean;
  /** 会话记忆摘要切片（request 级注入；仅 main 根 run turn 消费，引擎不持久化）。 */
  session_context: string | null;
  /** 执行级 checkpoint 写入（storage 未装配/写失败 = null 降级，不击穿执行）。 */
  checkpoint: (
    state: RunState,
    phase: RunPhase,
    opts?: { reason?: string | null; interrupt?: InterruptState | null },
  ) => Promise<CheckpointRecord | null>;
  /** 注入给 turn 的决议子集（排除通道审批键——工具 gate 命名空间隔离）。 */
  inject_for_turn: () => Record<string, unknown> | null;
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
      on_whiteboard_audit: deps.on_whiteboard_audit,
      storage: deps.storage ?? null,
      next_user_input: deps.next_user_input,
      abort_requested: deps.abort_requested,
    };
  }

  /** run 级共享面构造（协调器注入值挂载 + checkpoint 写面 + 转场审批包装）。 */
  #makeCore(coordinator: InterruptCoordinator, resuming: boolean, sessionContext: string | null): Core {
    const deps = this.deps;
    const storage = deps.storage ?? null;
    const nowMs = deps.now_ms ?? (() => 0);
    return {
      deps,
      guards: normalize_guardrails(deps.guardrails ?? {}),
      // 转场审批包装：先消费注入决议（accept/auto/edit = 放行，其余 fail-closed），
      // 无注入才问宿主 seam（review 档返回 pending = 挂卡）
      approval: async (request) => {
        const injected = coordinator.consume_review(channel_approval_key(request.channel_id));
        if (injected !== null && injected !== undefined) {
          return normalize_injected_decision(injected);
        }
        return (deps.approval ?? default_approval_seam())(request);
      },
      priors: deps.priors ?? default_scope_priors(),
      events: [],
      runs: [],
      seq: (): string => {
        this.#counter += 1;
        return `run:${this.#counter}`;
      },
      coordinator,
      resuming,
      session_context: sessionContext,
      checkpoint: (state, phase, opts) =>
        write_exec_checkpoint(storage, state, phase, {
          reason: opts?.reason ?? null,
          interrupt: opts?.interrupt ?? null,
          now_ms: nowMs,
        }).catch(() => null),
      inject_for_turn: () => {
        const pending = coordinator.pending_inject;
        if (pending.size === 0) return null;
        const out: Record<string, unknown> = {};
        for (const [key, value] of pending) {
          if (key.startsWith('gate:channel:')) continue;
          out[key] = value;
        }
        return Object.keys(out).length > 0 ? out : null;
      },
    };
  }

  /** 单次执行（根 run；返回汇聚点产物 + 执行树 + 事件带；可挂起/恢复/分支）。 */
  async run(request: ExecutionRequest): Promise<ExecutionResult> {
    const resumeFrom = request.resume_from ?? null;
    const branchFrom = request.branch_from ?? null;
    const coordinator = new InterruptCoordinator();
    if (request.resume_inject !== null && request.resume_inject !== undefined) {
      coordinator.inject(request.resume_inject);
    }
    const sessionContext =
      typeof request.session_context === 'string' && request.session_context !== ''
        ? request.session_context
        : null;
    const core = this.#makeCore(coordinator, resumeFrom !== null, sessionContext);
    const emit = (event: RunEvent): void => {
      core.events.push(event);
      if (this.deps.on_event !== undefined) this.deps.on_event(event);
    };
    if (branchFrom !== null) {
      return this.#branch(request, core, emit, branchFrom);
    }
    if (resumeFrom !== null) {
      return this.#resume(request, core, emit, resumeFrom);
    }
    return this.#start(request, core, emit);
  }

  /** 正常执行入口（入口作用域装载 → run 循环 → 汇聚点合成）。 */
  async #start(
    request: ExecutionRequest,
    core: Core,
    emit: (event: RunEvent) => void,
  ): Promise<ExecutionResult> {
    const entryScope = load_entry(request, core, this.#counter);
    const rootId = request.run_id ?? core.seq();
    validate_run_id(rootId);
    if (entryScope === null) {
      emit(_event(rootId, null, request.entry_scope ?? 'main', 'run_blocked', null));
      return blocked_result(core, rootId, request, entryScope, '入口作用域不可装载');
    }
    emit(_event(rootId, null, entryScope.id, 'run_start', { task: request.task ?? '' }));
    const seed: Record<string, unknown> = { task: request.task ?? '', ...(request.seed_payload ?? {}) };
    const whiteboard = load_whiteboard(request);
    try {
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
          whiteboard,
          whiteboard_context_window: request.whiteboard_context_window ?? null,
          phase: { kind: 'idle' },
        },
        emit,
      );
      return finish_result(core, rootId, entryScope.id, childOutcome, emit);
    } catch (error) {
      if (error instanceof InterruptSignal) {
        return pending_result(core, rootId, entryScope.id, error, emit);
      }
      throw error;
    }
  }

  /** 挂起恢复入口（从 checkpoint 恢复 RunState + 相位，绕过入口装载）。 */
  async #resume(
    request: ExecutionRequest,
    core: Core,
    emit: (event: RunEvent) => void,
    resumeFrom: number,
  ): Promise<ExecutionResult> {
    const rootId = request.run_id;
    if (rootId === undefined || rootId === null) {
      return blocked_result(core, 'resume', request, null, '挂起恢复需 run_id（root 链命名空间）');
    }
    validate_run_id(rootId);
    if (core.deps.storage === null || core.deps.storage === undefined) {
      return blocked_result(core, rootId, request, null, '挂起恢复需 storage（未装配）');
    }
    const storage: Storage | null = core.deps.storage ?? null;
    let snapshot: Awaited<ReturnType<typeof resolve_exec_checkpoint>>;
    try {
      snapshot = await resolve_exec_checkpoint(storage, rootId, resumeFrom);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return blocked_result(core, rootId, request, null, `挂起恢复失败: ${message}`);
    }
    emit(_event(rootId, null, snapshot.state.scope.id, 'run_resumed', { checkpoint_id: resumeFrom, phase: snapshot.phase.kind }));
    try {
      const childOutcome = await run_one(core, { ...snapshot.state, phase: snapshot.phase }, emit);
      return finish_result(core, rootId, snapshot.state.scope.id, childOutcome, emit);
    } catch (error) {
      if (error instanceof InterruptSignal) {
        return pending_result(core, rootId, snapshot.state.scope.id, error, emit);
      }
      throw error;
    }
  }

  /** 分支分叉入口（从既有执行 checkpoint 状态分叉新 run_id）：复用恢复解析
   *  （resolve_exec_checkpoint）重建 RunState + 相位，改名新 run_id 后照常
   *  进入 run 循环——checkpoint 写面按新 run_id 开新链（原 run 链零触碰）；
   *  白板按新 run 开（request.whiteboard 注入或空），原 run 白板/载荷深拷贝
   *  隔离（state_from_dict 全量拷贝，互不反写）。相位原样保留：turn_done =
   *  从路由决策继续（gate pending 恢复后重过闸 = 新 run 独立审批生命周期；
   *  gate passed 继承已放行决策不重挂）；turn_resume = 带新 run 决议重跑整轮；
   *  settled = 按相位回执收口（不重跑）。 */
  async #branch(
    request: ExecutionRequest,
    core: Core,
    emit: (event: RunEvent) => void,
    branchFrom: { source_run_id: string; checkpoint_id: number },
  ): Promise<ExecutionResult> {
    const rootId = request.run_id;
    if (rootId === undefined || rootId === null) {
      return blocked_result(core, 'branch', request, null, '分支分叉需 run_id（新 run 命名）');
    }
    validate_run_id(rootId);
    if (rootId === branchFrom.source_run_id) {
      return blocked_result(
        core,
        rootId,
        request,
        null,
        `分支分叉 run_id 不得与源 run 相同（${rootId}）——新 run 须独立命名空间`,
      );
    }
    if (request.resume_from !== null && request.resume_from !== undefined) {
      return blocked_result(core, rootId, request, null, '分支分叉与挂起恢复（resume_from）互斥');
    }
    if (core.deps.storage === null || core.deps.storage === undefined) {
      return blocked_result(core, rootId, request, null, '分支分叉需 storage（未装配）');
    }
    const storage: Storage | null = core.deps.storage ?? null;
    let snapshot: Awaited<ReturnType<typeof resolve_exec_checkpoint>>;
    try {
      snapshot = await resolve_exec_checkpoint(storage, branchFrom.source_run_id, branchFrom.checkpoint_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return blocked_result(core, rootId, request, null, `分支分叉失败: ${message}`);
    }
    const task = typeof snapshot.state.payload['task'] === 'string'
      ? snapshot.state.payload['task']
      : '';
    emit(_event(rootId, null, snapshot.state.scope.id, 'run_start', {
      task,
      branch_from: { source_run_id: branchFrom.source_run_id, checkpoint_id: branchFrom.checkpoint_id },
    }));
    try {
      const childOutcome = await run_one(
        core,
        {
          ...snapshot.state,
          run_id: rootId,
          parent_run_id: null,
          // 白板按新 run 开：request.whiteboard 注入或空（不继承源 run 白板——
          // 白板可变状态，共享即污染原 run 视图）
          whiteboard: load_whiteboard(request),
          whiteboard_context_window:
            request.whiteboard_context_window ?? snapshot.state.whiteboard_context_window,
          phase: snapshot.phase,
        },
        emit,
      );
      return finish_result(core, rootId, snapshot.state.scope.id, childOutcome, emit);
    } catch (error) {
      if (error instanceof InterruptSignal) {
        return pending_result(core, rootId, snapshot.state.scope.id, error, emit);
      }
      throw error;
    }
  }
}
