/**
 * run 循环（作用域转场的核心执行：回合加工 → `__next` 路由 → 通道转场 → 归并）。
 *
 * 一次 run = 固定入口作用域的自治循环：每轮作用域加工经 turn seam 出载荷 →
 * 解析 `__next`（缺省回落：入口首轮先验 → 兜底直收）→ 路由计划（结构校验）→
 * 通道条件执行（资格/审批/并行/成本池，fail-closed）→ 转场。跨作用域不改变本
 * run 的作用域槽位：delegate/fan_out/fan_in 都派生**子 run**（各自独立 run_id/
 * 轨迹/成本），子 run 完成即回传父 run 归并（载荷按 scope 键并入 + 摘要收集）。
 *
 * 轨迹（每 run 的 hops）记录真实执行路径：出向转场（delegate/fan_out/fan_in
 * 目标）配一条入向归并 hop（delegate → return；fan_out/fan_in → fan_in）——
 * 保证转场链线性（scope A → scope B → scope A → ...），可直接 ingest 档案。
 */

import {
  CHANNEL_SHAPE_FAN_IN,
  type ChannelCommit,
  type ChannelShape,
} from '../channels/channel_spec.js';
import { validate_run_id, type TrailHop, type TrailOutcome } from '../org_archive/execution_trail.js';
import { check_parallel_guard, check_steps_guard, check_cost_guard } from './guardrails.js';
import { enforce_transition_conditions } from './channel_gate.js';
import { fan_in_merge, clean_payload, strip_quality, type FanInMerged } from './fan_in.js';
import { fallback_routing } from './fallback_routing.js';
import { routing_decision_from_output } from './routing_next.js';
import { PAYLOAD_AMEND_KEY, process_grant_amend } from './amend_runtime.js';
import { plan_routing, type RoutePlan } from './route_planner.js';
import { payload_from_reply, build_turn_input, type WhiteboardAssemblyOptions } from './scope_turn.js';
import { build_temp_scope_entity, parse_temp_scope_def } from './temp_scope.js';
import { Whiteboard } from '../whiteboard/board.js';
import type { WhiteboardAuditEntry, WhiteboardBlock } from '../whiteboard/index.js';
import { ContextMixer } from '../context/context_mixer.js';
import { build_block_sources } from '../context/block_source.js';
import type { AuthorizedBlock } from '../context/block_source.js';
import type { Core } from './execution_runtime.js';
import type {
  ChildRunOutcome,
  LoadedScope,
  RunEvent,
  RunRecord,
} from './runtime_types.js';

/** run 循环内部状态（一次 run 的记账面）。 */
export interface RunState {
  run_id: string;
  parent_run_id: string | null;
  scope: LoadedScope;
  trigger: string | null;
  payload: Record<string, unknown>;
  hops: TrailHop[];
  steps: number;
  cost_acc: number;
  degraded: string[];
  children: ChildRunOutcome[];
  /** 可选白板会话（同 run 内共享；子 run 穿透继承）。 */
  whiteboard?: Whiteboard;
  /** 白板装配用的作用域模型 context_window（缺省 = null，回落 200k 兜底；子 run 穿透继承）。 */
  whiteboard_context_window?: number | null;
}

type Emit = (event: RunEvent) => void;

/** 从 run 记录派生轨迹（ExecutionTrail；hops 已保证转场链线性）。 */
export function trail_from(record: RunRecord) {
  return {
    run_id: record.run_id,
    parent_run_id: record.parent_run_id,
    entry_scope: record.entry_scope,
    hops: record.hops,
    outcome: record.outcome,
    cost: record.cost,
  };
}

/** run 记录入列 + 轨迹 ingest（子 run 先入列；根 run 最后 = core.runs 树序）。 */
function settle(
  core: Core,
  state: RunState,
  outcome: TrailOutcome,
  error: string | null,
  summary: string | null,
  payload: Record<string, unknown>,
): ChildRunOutcome {
  const record: RunRecord = {
    run_id: state.run_id,
    parent_run_id: state.parent_run_id,
    entry_scope: state.scope.id,
    outcome,
    hops: [...state.hops],
    cost: { steps: state.steps, cost: state.cost_acc },
    degraded_summaries: [...state.degraded],
    children: state.children,
    error,
  };
  core.runs.push(record);
  if (core.deps.archive !== null && core.deps.archive !== undefined) {
    core.deps.archive.ingest(trail_from(record));
  }
  return {
    run_id: state.run_id,
    parent_run_id: state.parent_run_id,
    entry_scope: state.scope.id,
    outcome,
    payload: clean_payload(payload),
    summary,
    cost: record.cost,
    error,
  };
}

function finish_ok(core: Core, state: RunState): ChildRunOutcome {
  const degraded = state.degraded.length > 0;
  const outcome: TrailOutcome = degraded ? 'degraded' : 'success';
  return settle(
    core,
    state,
    outcome,
    null,
    degraded ? state.degraded.join('；') : null,
    state.payload,
  );
}

function finish_fail(core: Core, state: RunState, message: string): ChildRunOutcome {
  return settle(core, state, 'failure', message, message, {});
}

/** 目标作用域装载（目录资产 / 临时现场构造）。 */
function load_target(core: Core, plan: RoutePlan, parent_id: string, index: number): LoadedScope {
  if (plan.temp_scope !== null) {
    const def = parse_temp_scope_def(plan.temp_scope);
    return build_temp_scope_entity(def, `temp_scope:${parent_id}:${index}`);
  }
  const scope = core.deps.load_scope(plan.target_scope as string);
  if (scope === null) throw new Error(`目标作用域不可装载: ${plan.target_scope}`);
  return scope;
}

function make_child_run_id(parent: string, index: number): string {
  const id = `${parent}.c${index}`;
  validate_run_id(id);
  return id;
}

function hop(
  from: string,
  to: string,
  shape: ChannelShape,
  contract: ChannelCommit,
  count?: number,
): TrailHop {
  return { from, to, shape, commit: contract, count };
}

/** 归并结果注入父载荷（单份按 scope 键并入；多份进清单；仅决策进 flag）。 */
function inject_merged(state: RunState, merged: FanInMerged): void {
  const adopted = merged.adopted.filter((c) => c.outcome !== 'failure');
  if (adopted.length === 1) {
    const only = adopted[0]!;
    state.payload[only.entry_scope] = strip_quality(only.payload);
  } else if (adopted.length > 1) {
    state.payload[adopted[0]!.entry_scope] = adopted.map((c) => strip_quality(c.payload));
  }
  if (merged.decision !== null) state.payload['decision'] = merged.decision;
  for (const summary of merged.degraded_summaries) state.degraded.push(summary);
}

/**
 * 执行一次 run 的自洽循环（含递归子 run）。
 * @returns 本 run 的完成形态（根 run 调用方可直接汇聚；子 run 由父归并）。
 */
export async function run_one(core: Core, state: RunState, emit: Emit): Promise<ChildRunOutcome> {
  for (;;) {
    const stepOk = check_steps_guard(state.steps, core.guards);
    if (!stepOk.ok) return finish_fail(core, state, stepOk.message);

    const beforeAudit = state.whiteboard ? state.whiteboard.audit().length : 0;
    let wbBlocks: AuthorizedBlock[] | undefined;
    if (state.whiteboard) {
      const viewBlocks = state.whiteboard.view(state.scope.id);
      wbBlocks = viewBlocks.map((b) => ({
        kind: b.kind,
        owner: b.owner,
        content: b.content,
        seq: b.seq,
      }));
    }
    const turn = await core.deps.turn.run_scope_turn({
      run_id: state.run_id,
      step: state.steps + 1,
      scope: state.scope,
      boot_system_prompt: core.deps.boot_system_prompt ?? '',
      input: await build_turn_input('', state.payload, wbBlocks, {
        context_window: state.whiteboard_context_window ?? null,
      }),
      payload: { ...state.payload },
      thread_id: state.run_id,
      whiteboard_blocks: wbBlocks,
    });
    state.steps += 1;

    if (state.whiteboard) {
      const afterAudit = state.whiteboard.audit();
      const newEntries = afterAudit.slice(beforeAudit);
      for (const entry of newEntries) {
        const detail: Record<string, unknown> = {
          scope: entry.scope,
          block_id: entry.block_id,
          kind: entry.kind,
          action: entry.action,
        };
        emit({
          run_id: state.run_id,
          parent_run_id: state.parent_run_id,
          scope: state.scope.id,
          action: 'whiteboard_audit',
          detail,
        });
      }
      if (core.deps.on_whiteboard_audit && newEntries.length > 0) {
        core.deps.on_whiteboard_audit(newEntries);
      }
    }

    const costInc = core.deps.estimate_cost?.(turn) ?? (turn.cost?.cost ?? 0);
    const costOk = check_cost_guard(state.cost_acc, costInc, core.guards);
    if (!costOk.ok) return finish_fail(core, state, costOk.message);
    state.cost_acc += costInc;
    emit({ run_id: state.run_id, parent_run_id: state.parent_run_id, scope: state.scope.id, action: 'scope_turn', detail: { step: state.steps } });
    if (!turn.ok) {
      const summary = turn.summary ?? turn.reason ?? '作用域加工失败';
      state.degraded.push(summary);
      return settle(core, state, 'failure', turn.reason ?? null, summary, {});
    }
    const produced = turn.payload !== undefined ? turn.payload : payload_from_reply(turn.reply);
    // 运行中改授权（`__amend` 结构化产物声明）：复用仲裁者判定，main 才生效；
    // 非仲裁者/结构非法 = 显式拒绝（fail-closed，本 run 判失败）；生效后审计经
    // 既有事件通道带出（top-of-loop 差量已含本轮之前的条目，不重复发）。
    const amend = process_grant_amend(state.whiteboard, state.scope.id, produced);
    delete produced[PAYLOAD_AMEND_KEY];
    if (amend.status === 'rejected') {
      return finish_fail(core, state, amend.reason);
    }
    if (amend.status === 'applied') {
      const detail: Record<string, unknown> = {
        scope: amend.entry.scope,
        block_id: amend.entry.block_id,
        kind: amend.entry.kind,
        action: amend.entry.action,
      };
      if (amend.entry.amendment !== undefined) detail['amendment'] = amend.entry.amendment;
      emit({ run_id: state.run_id, parent_run_id: state.parent_run_id, scope: state.scope.id, action: 'whiteboard_audit', detail });
      if (core.deps.on_whiteboard_audit) core.deps.on_whiteboard_audit([amend.entry]);
    }
    let decision = routing_decision_from_output(produced, turn.reply);
    // 先验回落只作用于入口首轮（steps=1 的这次加工 = 入口路由局部判定）；其后
    // 无声明即兜底直收（自治"何时收"，不反复按路线首跳重入）
    if (decision === null && state.steps === 1) {
      const fb = fallback_routing(core.priors, state.scope.id, state.trigger, 0);
      if (fb !== null) decision = fb.decision;
    }
    Object.assign(state.payload, clean_payload(produced));
    if (decision === null) return finish_ok(core, state);
    const result = plan_routing(decision, {
      currentScope: state.scope.id,
      hasParent: state.parent_run_id !== null,
      directory: { has_scope: (id) => core.deps.load_scope(id) !== null },
      channels: core.deps.channels,
    });
    if (!result.ok) {
      return finish_fail(core, state, `路由拒绝 ${result.reason}: ${result.detail}`);
    }
    const plan = result;
    emit({ run_id: state.run_id, parent_run_id: state.parent_run_id, scope: state.scope.id, action: `route:${plan.kind}`, detail: null });
    if (plan.kind === 'converge' || plan.kind === 'sink') {
      return finish_ok(core, state);
    }
    if (plan.kind === 'return') {
      return state.parent_run_id === null
        ? finish_fail(core, state, 'return 转场须在子执行内（父在场）')
        : finish_ok(core, state);
    }
    if (plan.kind === 'fan_out') {
      const parallelOk = check_parallel_guard(plan.count, core.guards);
      if (!parallelOk.ok) return finish_fail(core, state, parallelOk.message);
    }
    const channel = core.deps.channels.get(plan.channel_id);
    if (channel === null) return finish_fail(core, state, `通道不可用: ${plan.channel_id}`);
    const gateBlock = await enforce_transition_conditions(
      channel,
      {
        currentScope: state.scope.id,
        accumulated_cost: state.cost_acc,
        cost_increment: 0,
      },
      plan.count,
      core.approval,
    );
    if (gateBlock !== null) return finish_fail(core, state, gateBlock.message);

    // delegate / fan_out / fan_in：派生子 run（独立 run_id/轨迹/成本）→ 归并回传
    if (plan.kind === 'delegate' || plan.kind === 'fan_out' || plan.kind === 'fan_in') {
      const targetScope = load_target(core, plan, state.run_id, state.children.length);
      const count = plan.kind === 'fan_out' ? plan.count : 1;
      state.hops.push(
        hop(state.scope.id, targetScope.id, plan.shape as ChannelShape, plan.contract, plan.kind === 'fan_out' ? count : undefined),
      );
      const spawned: Promise<ChildRunOutcome>[] = [];
      const base = state.children.length;
      for (let i = 0; i < count; i++) {
        const childState: RunState = {
          run_id: make_child_run_id(state.run_id, base + i),
          parent_run_id: state.run_id,
          scope: targetScope,
          trigger: state.trigger,
          payload: { ...state.payload },
          hops: [],
          steps: 0,
          cost_acc: 0,
          degraded: [],
          children: [],
          whiteboard: state.whiteboard,
          whiteboard_context_window: state.whiteboard_context_window,
        };
        spawned.push(run_one(core, childState, emit));
      }
      const outcomes = await Promise.all(spawned);
      const inShape: ChannelShape = plan.kind === 'fan_out' ? CHANNEL_SHAPE_FAN_IN : 'return';
      state.hops.push(
        hop(targetScope.id, state.scope.id, inShape, plan.contract, plan.kind === 'fan_out' ? count : undefined),
      );
      const merged = fan_in_merge(outcomes, plan.contract);
      state.children.push(...merged.adopted, ...merged.losers);
      inject_merged(state, merged);
      emit({ run_id: state.run_id, parent_run_id: state.parent_run_id, scope: state.scope.id, action: 'merge', detail: { contract: plan.contract, adopted: merged.adopted.length } });
      continue;
    }
    return finish_fail(core, state, `无法执行的路由计划: ${plan.kind}`);
  }
}
