/**
 * 执行结果装配面（run 收尾/挂起/阻断结果构造 + 入口装载 + 白板装载）。
 *
 * execution_runtime 的纯装配侧拆分（≤350 行纪律）：finish_result（汇聚点
 * 单份最终产物 + 执行树投影）、pending_result（审批挂起结果：挂起卡 + root
 * 链尾恢复锚点 + 已收尾子执行树）、blocked_result（入口不可装载等 fail-closed
 * 阻断）、入口作用域装载（目录/临时现场）、白板会话装载。全部为纯数据装配
 * （JSON 进 JSON 出 + 注入 seam），不持有运行时语义。
 */

import { WHITEBOARD_VERSION, Whiteboard, whiteboard_block_to_dict } from '../whiteboard/index.js';
import { InterruptSignal, InterruptState } from '../interrupt/interrupt_types.js';
import { exec_chain_tail } from './run_checkpoint.js';
import { estuary_synthesize } from './fan_in.js';
import { parse_temp_scope_def, build_temp_scope_entity, temp_scope_id } from './temp_scope.js';
import { trail_from } from './run_transition.js';
import type { run_one } from './run_loop.js';
import type { Core } from './execution_runtime.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  LoadedScope,
  RunEvent,
  RunRecord,
  WhiteboardSession,
} from './runtime_types.js';

type Emit = (event: RunEvent) => void;

/** 事件构造（执行树可观测面统一形态）。 */
export function _event(
  run_id: string,
  parent: string | null,
  scope: string,
  action: string,
  detail: Record<string, unknown> | null,
): RunEvent {
  return { run_id, parent_run_id: parent, scope, action, detail };
}

/** 入口作用域装载（目录资产优先；entry_temp_scope = 现场定义）。 */
export function load_entry(
  request: ExecutionRequest,
  core: Core,
  counter: number,
): LoadedScope | null {
  if (request.entry_temp_scope !== undefined && request.entry_temp_scope !== null) {
    const def = parse_temp_scope_def(request.entry_temp_scope);
    const id = temp_scope_id(request.run_id ?? 'entry', counter);
    return build_temp_scope_entity(def, id);
  }
  return core.deps.load_scope(request.entry_scope ?? 'main');
}

/** 白板会话装载（召集下发的当前态；装载不产生 write 审计）。 */
export function load_whiteboard(request: ExecutionRequest): Whiteboard | undefined {
  const wbSession: WhiteboardSession | null | undefined = request.whiteboard;
  if (wbSession === null || wbSession === undefined) return undefined;
  return Whiteboard.from_dict({
    version: WHITEBOARD_VERSION,
    arbiter: wbSession.arbiter ?? 'main',
    grants: { mode: wbSession.grants.mode, entries: wbSession.grants.entries.map((e) => ({ ...e })) },
    blocks: wbSession.blocks.map(whiteboard_block_to_dict),
    audit: [],
  });
}

/** 收尾合成（run_end 事件 + 汇聚点单份最终产物 + 执行树投影）。 */
export function finish_result(
  core: Core,
  rootId: string,
  entryScopeId: string,
  childOutcome: Awaited<ReturnType<typeof run_one>>,
  emit: Emit,
): ExecutionResult {
  emit(_event(rootId, null, entryScopeId, 'run_end', null));
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
    pending_approval: false,
    pending_interrupt: null,
    resume_checkpoint_id: null,
  };
}

/** 挂起结果（审批卡在途：挂起卡 + root 链尾恢复锚点 + 已收尾子执行树）。 */
export async function pending_result(
  core: Core,
  rootId: string,
  entryScopeId: string,
  signal: InterruptSignal,
  emit: Emit,
): Promise<ExecutionResult> {
  const tail = await exec_chain_tail(core.deps.storage ?? null, rootId);
  const interrupt = new InterruptState(signal.key, signal.payload);
  emit(_event(rootId, null, entryScopeId, 'pending_approval', {
    key: signal.key,
    run_id: rootId,
    checkpoint_id: tail?.checkpoint_id ?? null,
  }));
  const record: RunRecord = {
    run_id: rootId,
    parent_run_id: null,
    entry_scope: entryScopeId,
    outcome: 'failure',
    hops: [],
    cost: { steps: 0 },
    degraded_summaries: [],
    children: [],
    error: '审批挂起（pending_approval，经 resume 续跑）',
  };
  core.runs.push(record);
  return {
    root: record,
    final_product: {},
    degraded_summaries: [],
    runs: core.runs,
    trails: [],
    events: core.events,
    blocked: false,
    block_reason: null,
    pending_approval: true,
    pending_interrupt: interrupt,
    resume_checkpoint_id: tail?.checkpoint_id ?? null,
  };
}

/** 执行前阻断结果（入口不可装载等；fail-closed 不产出半成品）。 */
export function blocked_result(
  core: Core,
  rootId: string,
  request: ExecutionRequest,
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
    pending_approval: false,
    pending_interrupt: null,
    resume_checkpoint_id: null,
  };
}
