/**
 * 转场段（路由计划 → 通道条件 → 子 run 派生 → 归并）+ run 收尾（settle/回执）。
 * run 循环分层：run_loop.ts 管回合加工与挂起/恢复相位，本模块管"路由决策之后"
 * 的转场语义——计划结构校验（fail-closed）→ 通道条件（资格/审批/并行/成本池；
 * 审批 pending = 写 interrupted checkpoint 挂起卡 + 抛 InterruptSignal）→
 * delegate/fan_out/fan_in 派生子 run → fan_in 按提交契约归并回传。恢复时子
 * run 按子链尾重建：终态 = settled 相位直接回执（不重跑、轨迹不重复 ingest）；
 * 中断 = 快照续跑；无链 = 新鲜派生（Promise.all 保持 fan_out 并行）。
 */

import { validate_run_id, type TrailHop, type TrailOutcome } from '../../evolve/observe/org_archive/execution_trail.js';
import { check_parallel_guard } from './guardrails.js';
import { InterruptSignal, InterruptState } from '../interrupt/interrupt_types.js';
import {
  approval_required,
  channel_approval_key,
  enforce_transition_conditions,
} from './channel_gate.js';
import { fan_in_merge, clean_payload, strip_quality, type FanInMerged } from './fan_in.js';
import { plan_routing, type RoutePlan } from '../route/route_planner.js';
import { build_temp_scope_entity, parse_temp_scope_def } from './temp_scope.js';
import {
  exec_chain_tail,
  resolve_exec_checkpoint,
  type ExecCheckpointSnapshot,
} from './run_checkpoint.js';
import type { RoutingDecision } from '../route/routing_next.js';
import { run_one } from './run_loop.js';
import type { Core } from './execution_runtime.js';
import {
  CHANNEL_SHAPE_FAN_IN,
  type ChannelCommit,
  type ChannelShape,
} from '../../model/channels/channel_spec.js';
import type { ChildRunOutcome, RunEvent, RunRecord, RunState } from './runtime_types.js';

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

/** run 记录入列 + 轨迹 ingest + 终态 checkpoint（子 run 先、根 run 后 = 树序；终态 checkpoint 是父恢复回执锚点）。 */
export async function settle(
  core: Core,
  state: RunState,
  outcome: TrailOutcome,
  error: string | null,
  summary: string | null,
  payload: Record<string, unknown>,
): Promise<ChildRunOutcome> {
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
  await core.checkpoint(
    state,
    { kind: 'settled', outcome, summary, error },
    { reason: outcome },
  );
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

/** 直收/收敛收尾（有降级摘要 = degraded，否则 success）。 */
export async function finish_ok(core: Core, state: RunState): Promise<ChildRunOutcome> {
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

/** 失败收尾（fail-closed 方向统一走此出口）。 */
export async function finish_fail(core: Core, state: RunState, message: string): Promise<ChildRunOutcome> {
  return settle(core, state, 'failure', message, message, {});
}

/** 目标作用域装载（目录资产 / 临时现场构造）。 */
function load_target(core: Core, plan: RoutePlan, parent_id: string, index: number): RunState['scope'] {
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

/** 终态快照 → 子执行回执（父恢复按子链尾重建，不重跑）。 */
function outcome_from_settled(snapshot: ExecCheckpointSnapshot): ChildRunOutcome {
  if (snapshot.phase.kind !== 'settled') {
    throw new Error(`终态回执重建需 settled 相位（收到 ${snapshot.phase.kind}）`);
  }
  const state = snapshot.state;
  return {
    run_id: state.run_id,
    parent_run_id: state.parent_run_id,
    entry_scope: state.scope.id,
    outcome: snapshot.phase.outcome,
    payload: clean_payload(state.payload),
    summary: snapshot.phase.summary,
    cost: { steps: state.steps, cost: state.cost_acc },
    error: snapshot.phase.error,
  };
}

/** 终态快照 → run 记录（恢复树树序补齐；轨迹已由挂起前 settle ingest，不重复）。 */
function record_from_settled(snapshot: ExecCheckpointSnapshot): RunRecord {
  if (snapshot.phase.kind !== 'settled') {
    throw new Error(`终态记录重建需 settled 相位（收到 ${snapshot.phase.kind}）`);
  }
  const state = snapshot.state;
  return {
    run_id: state.run_id,
    parent_run_id: state.parent_run_id,
    entry_scope: state.scope.id,
    outcome: snapshot.phase.outcome,
    hops: [...state.hops],
    cost: { steps: state.steps, cost: state.cost_acc },
    degraded_summaries: [...state.degraded],
    children: state.children,
    error: snapshot.phase.error,
  };
}

/** 新鲜子 run 状态（无链派生；相位 idle）。 */
function fresh_child_state(
  core: Core,
  state: RunState,
  targetScope: RunState['scope'],
  childRunId: string,
): RunState {
  return {
    run_id: childRunId,
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
    phase: { kind: 'idle' },
  };
}

/** 派生子 run（恢复感知：终态子链直接回执/中断子链快照续跑/无链新鲜派生；
 *  Promise.all 保持 fan_out 并行语义）。 */
async function spawn_children(
  core: Core,
  state: RunState,
  targetScope: RunState['scope'],
  count: number,
  emit: Emit,
): Promise<ChildRunOutcome[]> {
  const base = state.children.length;
  const specs: Array<{
    run_id: string;
    resume: ExecCheckpointSnapshot | null;
    done: ChildRunOutcome | null;
  }> = [];
  for (let i = 0; i < count; i++) {
    const childRunId = make_child_run_id(state.run_id, base + i);
    let resume: ExecCheckpointSnapshot | null = null;
    let done: ChildRunOutcome | null = null;
    if (core.resuming && core.deps.storage !== null && core.deps.storage !== undefined) {
      const tail = await exec_chain_tail(core.deps.storage, childRunId);
      if (tail !== null) {
        const snapshot = await resolve_exec_checkpoint(core.deps.storage, childRunId, tail.checkpoint_id);
        if (tail.reason === 'success' || tail.reason === 'degraded' || tail.reason === 'failure') {
          done = outcome_from_settled(snapshot);
          core.runs.push(record_from_settled(snapshot));
        } else {
          resume = snapshot;
        }
      }
    }
    specs.push({ run_id: childRunId, resume, done });
  }
  const outcomes = await Promise.all(
    specs.map((spec) => {
      if (spec.done !== null) return Promise.resolve(spec.done);
      if (spec.resume !== null) {
        return run_one(core, { ...spec.resume.state, phase: spec.resume.phase }, emit);
      }
      return run_one(core, fresh_child_state(core, state, targetScope, spec.run_id), emit);
    }),
  );
  return outcomes;
}

/**
 * 转场段（路由计划 → 通道条件 → 子 run 派生 → 归并）。返回 null = 循环继续；
 * 非 null = 本 run 收尾形态（收敛/直收/回传/失败）。
 */
export async function run_transition(
  core: Core,
  state: RunState,
  emit: Emit,
  decision: RoutingDecision,
  gatePassed: boolean,
): Promise<ChildRunOutcome | null> {
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

  // 通道条件执行：审批 pending = 写 interrupted checkpoint（挂起卡）+ 抛信号挂起
  //（review 档不再 fail-closed 阻断；恢复时注入决议重过闸）。
  if (!gatePassed) {
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
    if (gateBlock !== null) {
      if (gateBlock.reason === 'approval_pending') {
        const level = approval_required(channel) ?? '';
        const key = core.coordinator.next_gate_key(state.run_id, channel_approval_key(channel.id));
        const payload: Record<string, unknown> = {
          level,
          channel_id: channel.id,
          action: { scope: state.scope.id, channel: channel.id, count: plan.count },
          run_id: state.run_id,
        };
        await core.checkpoint(
          state,
          { kind: 'turn_done', decision, gate: 'pending' },
          { reason: 'interrupted', interrupt: new InterruptState(key, payload) },
        );
        throw new InterruptSignal(key, payload);
      }
      return finish_fail(core, state, gateBlock.message);
    }
    // 已放行：写 checkpoint（gate passed）——恢复跳过重过闸，杜绝 re-hang
    await core.checkpoint(state, { kind: 'turn_done', decision, gate: 'passed' });
  }

  // delegate / fan_out / fan_in：派生子 run → 归并回传
  if (plan.kind === 'delegate' || plan.kind === 'fan_out' || plan.kind === 'fan_in') {
    const targetScope = load_target(core, plan, state.run_id, state.children.length);
    const count = plan.kind === 'fan_out' ? plan.count : 1;
    state.hops.push(
      hop(state.scope.id, targetScope.id, plan.shape as ChannelShape, plan.contract, plan.kind === 'fan_out' ? count : undefined),
    );
    const outcomes = await spawn_children(core, state, targetScope, count, emit);
    const inShape: ChannelShape = plan.kind === 'fan_out' ? CHANNEL_SHAPE_FAN_IN : 'return';
    state.hops.push(
      hop(targetScope.id, state.scope.id, inShape, plan.contract, plan.kind === 'fan_out' ? count : undefined),
    );
    const merged = fan_in_merge(outcomes, plan.contract);
    state.children.push(...merged.adopted, ...merged.losers);
    inject_merged(state, merged);
    emit({ run_id: state.run_id, parent_run_id: state.parent_run_id, scope: state.scope.id, action: 'merge', detail: { contract: plan.contract, adopted: merged.adopted.length } });
    return null;
  }
  return finish_fail(core, state, `无法执行的路由计划: ${plan.kind}`);
}
