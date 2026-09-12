/**
 * 执行级 checkpoint（挂起/恢复 seam 的数据面 + 写链/恢复解析）。
 *
 * 执行循环的挂起/恢复协议：每个 scope turn 后把 RunState 全量快照落
 * 到 **run_id 命名空间下的 checkpoint 子链**（thread = `exec:<run_id>`；子 run
 * 各自独立子链——父 run 恢复时按子链尾回执/续跑重建子树）。机制件全部复用
 * §十保留件不改语义：
 *
 * - checkpoint 版本链 = 引擎 Storage 链机制（CheckpointRecord + put_checkpoint
 *   链尾跟随 parent）；
 * - 挂起卡 = kernel/interrupt InterruptState（reason='interrupted' 随快照落
 *   盘，宿主经 checkpoint 读取卡键/负载，决议经 resume_inject 重入）；
 * - 恢复解析 = kernel/recovery resolve_resume（快照 + 输入覆盖层 + 顶层锚点
 *   回溯；本层调用 graph_path=[]、replay=false、schema=null，只取快照态）。
 *
 * 快照 = { run: RunState 序列化, phase: 挂起相位 }。相位决定恢复跳入点：
 * turn_done = 上一轮 turn 已完成（decision 已定，路由/通道未走——恢复跳过
 * turn 直接走路由）；turn_resume = 上一轮 turn 未完成（工具审批挂起，恢复
 * 带注入重跑整轮）；settled = run 已收尾（父 run 恢复时直接取回执，不重跑
 * 子执行）；idle = 循环起始无挂起语义。
 *
 * 纯数据面 + 注入 seam：本模块只做序列化与链写读，storage 由宿主注入
 * （core 零 IO）；checkpoint 失败不击穿执行（写失败 = 降级为无恢复语义，
 * 挂起卡仍随结果返回——宿主可弹卡但无法续跑，fail-closed 方向上不静默）。
 */

import { CheckpointRecord, jsonableStrip } from '../../model/storage/storage_records.js';
import type { Storage } from '../../dock/ports/storage.js';
import type { JsonRecord } from '../../model/json.js';
import { InterruptState } from '../../kernel/interrupt/interrupt_types.js';
import { resolve_resume, tail_checkpoint } from '../../kernel/recovery/index.js';
import { EntitySpec } from '../entities/entities.js';
import { Whiteboard } from '../whiteboard/index.js';
import type { RoutingDecision } from './routing_next.js';
import type { TrailHop, TrailOutcome } from '../org_archive/execution_trail.js';
import type { ChildRunOutcome, RunState } from './runtime_types.js';

/** checkpoint 子链线程命名空间（run_id 命名空间；子 run 各自独立子链）。 */
export function exec_checkpoint_thread(run_id: string): string {
  return `exec:${run_id}`;
}

/** 快照 state 内键：RunState 序列化。 */
export const EXEC_STATE_KEY = 'run';

/** 快照 state 内键：挂起相位。 */
export const EXEC_PHASE_KEY = 'phase';

/**
 * 挂起相位（checkpoint 恢复跳入点）。
 *
 * - idle：循环起始（无挂起语义，正常逐轮执行）；
 * - turn_done：上一轮 turn 已完成（decision 已定；gate = 通道审批结果——
 *   pending = 挂卡点重入时重新过闸（消费注入）、passed = 已放行直接进转场、
 *   null = 无转场）；
 * - turn_resume：上一轮 turn 未完成（工具审批挂起；step = 未完成轮次号，
 *   恢复带注入重跑整轮）；
 * - settled：run 已收尾（父 run 恢复时按此回执重建子结果，不重跑）。
 */
export type RunPhase =
  | { kind: 'idle' }
  | { kind: 'turn_done'; decision: RoutingDecision | null; gate: 'pending' | 'passed' | null }
  | { kind: 'turn_resume'; step: number }
  | { kind: 'settled'; outcome: TrailOutcome; summary: string | null; error: string | null };

/** 相位 → JSON 形态（未知键不落；settled 缺省回落 null）。 */
export function phase_to_dict(phase: RunPhase): Record<string, unknown> {
  if (phase.kind === 'turn_done') {
    const data: Record<string, unknown> = { kind: 'turn_done', decision: phase.decision };
    if (phase.gate !== null) data['gate'] = phase.gate;
    return data;
  }
  if (phase.kind === 'turn_resume') {
    return { kind: 'turn_resume', step: phase.step };
  }
  if (phase.kind === 'settled') {
    return {
      kind: 'settled',
      outcome: phase.outcome,
      summary: phase.summary,
      error: phase.error,
    };
  }
  return { kind: 'idle' };
}

/** JSON → 相位（缺省回落 idle；结构非法 = idle，不击穿恢复）。 */
export function phase_from_dict(raw: unknown): RunPhase {
  const data = raw as Record<string, unknown> | null;
  if (data === null || typeof data !== 'object') return { kind: 'idle' };
  if (data['kind'] === 'turn_done') {
    const decision = (data['decision'] ?? null) as RoutingDecision | null;
    const gate =
      data['gate'] === 'pending' || data['gate'] === 'passed'
        ? (data['gate'] as 'pending' | 'passed')
        : null;
    return { kind: 'turn_done', decision, gate };
  }
  if (data['kind'] === 'turn_resume') {
    const step = typeof data['step'] === 'number' ? data['step'] : 0;
    return { kind: 'turn_resume', step };
  }
  if (data['kind'] === 'settled') {
    const outcome = (data['outcome'] ?? 'failure') as TrailOutcome;
    return {
      kind: 'settled',
      outcome,
      summary: (data['summary'] ?? null) as string | null,
      error: (data['error'] ?? null) as string | null,
    };
  }
  return { kind: 'idle' };
}

function copy_hop(hop: TrailHop): TrailHop {
  return {
    from: hop.from,
    to: hop.to,
    shape: hop.shape,
    commit: hop.commit,
    ...(hop.count !== undefined ? { count: hop.count } : {}),
  };
}

function copy_child(child: ChildRunOutcome): ChildRunOutcome {
  return {
    run_id: child.run_id,
    parent_run_id: child.parent_run_id,
    entry_scope: child.entry_scope,
    outcome: child.outcome,
    payload: { ...child.payload },
    summary: child.summary,
    cost: { ...child.cost },
    error: child.error,
    ...(child.adopted !== undefined ? { adopted: child.adopted } : {}),
  };
}

/** RunState → JSON 形态（白板全量随快照落盘——恢复后审计连续性保持）。 */
export function state_to_dict(state: RunState): Record<string, unknown> {
  return {
    run_id: state.run_id,
    parent_run_id: state.parent_run_id,
    scope: state.scope.to_dict(),
    trigger: state.trigger,
    payload: { ...state.payload },
    hops: state.hops.map(copy_hop),
    steps: state.steps,
    cost_acc: state.cost_acc,
    degraded: [...state.degraded],
    children: state.children.map(copy_child),
    whiteboard: state.whiteboard !== undefined ? state.whiteboard.to_dict() : null,
    whiteboard_context_window: state.whiteboard_context_window ?? null,
  };
}

/** JSON → RunState（不含相位；结构非法字段抛错——恢复数据损坏 fail-closed，
 *  不静默错位）。返回全量拷贝：恢复态可继续演进（push/assign）不反写落库
 *  快照（MemoryStorage 等持引用后端的防变面）。 */
export function state_from_dict(data: Record<string, unknown>): Omit<RunState, 'phase'> {
  const run_id = data['run_id'];
  if (typeof run_id !== 'string') throw new Error('执行级快照缺 run_id');
  const parent_run_id = (data['parent_run_id'] ?? null) as string | null;
  const scopeRaw = data['scope'];
  const scope = EntitySpec.from_dict(scopeRaw);
  const trigger = (data['trigger'] ?? null) as string | null;
  const payload = { ...((data['payload'] ?? {}) as Record<string, unknown>) };
  const hops = Array.isArray(data['hops']) ? (data['hops'] as TrailHop[]).map(copy_hop) : [];
  const steps = typeof data['steps'] === 'number' ? data['steps'] : 0;
  const cost_acc = typeof data['cost_acc'] === 'number' ? data['cost_acc'] : 0;
  const degraded = Array.isArray(data['degraded']) ? [...(data['degraded'] as string[])] : [];
  const children = Array.isArray(data['children'])
    ? (data['children'] as ChildRunOutcome[]).map(copy_child)
    : [];
  const wbRaw = data['whiteboard'];
  const whiteboard =
    wbRaw !== null && wbRaw !== undefined ? Whiteboard.from_dict(wbRaw) : undefined;
  const whiteboard_context_window = (data['whiteboard_context_window'] ?? null) as number | null;
  return {
    run_id,
    parent_run_id,
    scope,
    trigger,
    payload,
    hops,
    steps,
    cost_acc,
    degraded,
    children,
    whiteboard,
    whiteboard_context_window,
  };
}

/**
 * 写执行级 checkpoint（链尾跟随 parent；state 经 jsonableStrip 落盘）。
 *
 * @returns 落库记录；storage 未装配 = null（无恢复语义，不击穿执行）。
 */
export async function write_exec_checkpoint(
  storage: Storage | null,
  state: RunState,
  phase: RunPhase,
  opts: { reason?: string | null; interrupt?: InterruptState | null; now_ms?: () => number } = {},
): Promise<CheckpointRecord | null> {
  if (storage === null) return null;
  const thread = exec_checkpoint_thread(state.run_id);
  const tail = await tail_checkpoint(storage, thread);
  const now = opts.now_ms !== undefined ? opts.now_ms() : 0;
  return storage.put_checkpoint(
    new CheckpointRecord({
      checkpoint_id: 0,
      thread_id: thread,
      node: null,
      graph_path: [],
      state: jsonableStrip({
        [EXEC_STATE_KEY]: state_to_dict(state),
        [EXEC_PHASE_KEY]: phase_to_dict(phase),
      }) as JsonRecord,
      parent_id: tail !== null ? tail.checkpoint_id : null,
      reason: opts.reason ?? null,
      created_at: now > 0 ? Math.floor(now / 1000) : 0,
      event_seq: 0,
      error: null,
      interrupt: opts.interrupt ?? null,
      graph_version: null,
      plan: null,
    }),
    { fork: false },
  );
}

/** 恢复快照（RunState + 相位）。 */
export interface ExecCheckpointSnapshot {
  state: Omit<RunState, 'phase'>;
  phase: RunPhase;
}

/**
 * 恢复解析：按锚点读回执行级快照（kernel/recovery resolve_resume 复用——
 * 顶层锚点回溯对本链 = 锚点自身，state 无覆盖层）。
 *
 * @throws 锚点缺失/链损坏（fail-closed 显式化，不静默从头跑）。
 */
export async function resolve_exec_checkpoint(
  storage: Storage,
  run_id: string,
  checkpoint_id: number,
): Promise<ExecCheckpointSnapshot> {
  const thread = exec_checkpoint_thread(run_id);
  // 锚点归属校验：恢复只认本 run 命名空间子链（跨 run 续跑 = 显式拒绝，
  // 防串链恢复错位）
  const anchor = await storage.get_checkpoint(checkpoint_id);
  if (anchor === null) {
    throw new Error(`恢复锚点不存在: ${checkpoint_id}`);
  }
  if (anchor.thread_id !== thread) {
    throw new Error(
      `恢复锚点 #${checkpoint_id} 不属于执行 ${run_id}（线程 ${anchor.thread_id} ≠ ${thread}）`,
    );
  }
  const resolution = await resolve_resume({
    storage,
    state: {},
    schema: null,
    thread_id: thread,
    chain_thread: thread,
    resume_from: checkpoint_id,
    continue_chain: false,
    graph_path: [],
    replay: false,
    resume_map: null,
    graph_version: null,
  });
  const raw = resolution.state;
  const runRaw = raw[EXEC_STATE_KEY];
  if (runRaw === null || typeof runRaw !== 'object' || Array.isArray(runRaw)) {
    throw new Error(`执行级 checkpoint #${checkpoint_id} 缺 run 快照（链损坏或非执行链）`);
  }
  return {
    state: state_from_dict(runRaw as Record<string, unknown>),
    phase: phase_from_dict(raw[EXEC_PHASE_KEY]),
  };
}

/** 读链尾（root 挂起结果取恢复锚点；无链 = null）。 */
export async function exec_chain_tail(
  storage: Storage | null,
  run_id: string,
): Promise<CheckpointRecord | null> {
  if (storage === null) return null;
  return tail_checkpoint(storage, exec_checkpoint_thread(run_id));
}
