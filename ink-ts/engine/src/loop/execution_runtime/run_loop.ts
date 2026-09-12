/**
 * run 循环（作用域转场的核心执行：回合加工 → `__next` 路由 → 通道转场 → 归并）。
 *
 * 一次 run = 固定入口作用域的自治循环：每轮作用域加工经 turn seam 出载荷 →
 * 解析 `__next`（缺省回落：入口首轮先验 → 兜底直收）→ 路由计划（结构校验）→
 * 通道条件执行（资格/审批/并行/成本池，fail-closed；审批 pending = 挂卡）→
 * 转场（转场段见 run_transition.ts）。跨作用域不改变本 run 的作用域槽位：
 * delegate/fan_out/fan_in 都派生**子 run**（各自独立 run_id/轨迹/成本），子
 * run 完成即回传父 run 归并。
 *
 * 挂起/恢复（W7-D）：每轮 turn 后写执行级 checkpoint（run_id 命名空间子链，
 * 见 run_checkpoint.ts）——相位 turn_done 携带决策，恢复跳过 turn 直走路由；
 * 通道审批 pending 或工具审批挂起 → 写 interrupted checkpoint（挂起卡）后抛
 * InterruptSignal 挂起整次执行，宿主弹卡决议后 resume 续跑。恢复时子 run 按
 * 各自子链尾重建：终态子链 = 直接回执（不重跑）、中断子链 = 从快照续跑、
 * 无链 = 新鲜派生——已完成子执行绝不重执行。
 *
 * §7.3 中断注入：每轮 turn 前询问 next_user_input（返回文本并入本轮输入，
 * main 自治仲裁消费）+ abort_requested（命中 = 中止改用，fail-closed 收口）。
 */

import {
  CHANNEL_SHAPE_FAN_IN,
  type ChannelShape,
} from '../../model/channels/channel_spec.js';
import type { TrailHop, TrailOutcome } from '../../evolve/observe/org_archive/execution_trail.js';
import { check_steps_guard, check_cost_guard } from './guardrails.js';
import { InterruptSignal } from '../interrupt/interrupt_types.js';
import { fallback_routing } from '../route/fallback_routing.js';
import { routing_decision_from_output } from '../route/routing_next.js';
import { PAYLOAD_AMEND_KEY, process_grant_amend } from './amend_runtime.js';
import { PAYLOAD_BOARD_KEY, process_board_write } from './board_runtime.js';
import { payload_from_reply, build_turn_input } from './scope_turn.js';
import { clean_payload } from './fan_in.js';
import type { Core } from './execution_runtime.js';
import { run_transition, finish_ok, finish_fail, settle } from './run_transition.js';
import type { AuthorizedBlock } from '../context/block_source.js';
import type { ChildRunOutcome, RunEvent, RunRecord, RunState } from './runtime_types.js';

type Emit = (event: RunEvent) => void;

/**
 * 执行一次 run 的自洽循环（含递归子 run）。
 * @returns 本 run 的完成形态（根 run 调用方可直接汇聚；子 run 由父归并）。
 */
export async function run_one(core: Core, state: RunState, emit: Emit): Promise<ChildRunOutcome> {
  for (;;) {
    const stepOk = check_steps_guard(state.steps, core.guards);
    if (!stepOk.ok) return finish_fail(core, state, stepOk.message);

    // §7.3 中止改用：每轮 turn 边界询问（既有 abort 语义的引擎面）
    if (core.deps.abort_requested !== undefined && core.deps.abort_requested(state.run_id)) {
      return finish_fail(core, state, '执行已中止（中止改用）');
    }

    // 恢复语义：turn_done 相位 = 上一轮 turn 已完成 → 跳过 turn 直走转场段
    if (state.phase.kind === 'turn_done') {
      const decision = state.phase.decision;
      const gatePassed = state.phase.gate === 'passed';
      state.phase = { kind: 'idle' };
      if (decision === null) return finish_ok(core, state);
      const outcome = await run_transition(core, state, emit, decision, gatePassed);
      if (outcome !== null) return outcome;
      continue;
    }

    // 恢复语义：turn_resume 相位 = 上一轮 turn 未完成（工具审批挂起）→ 步进回拨
    // 一轮再带注入重跑整轮（步号与首轮一致，不产生步号空洞）
    if (state.phase.kind === 'turn_resume') {
      state.steps = Math.max(0, state.phase.step - 1);
      state.phase = { kind: 'idle' };
    }

    // 恢复语义：settled 相位 = run 已收尾（宿主误续跑已完成 run）→ 按相位回执
    // 收口，不重跑 turn、不重复 settle/ingest
    if (state.phase.kind === 'settled') {
      const record: RunRecord = {
        run_id: state.run_id,
        parent_run_id: state.parent_run_id,
        entry_scope: state.scope.id,
        outcome: state.phase.outcome,
        hops: [...state.hops],
        cost: { steps: state.steps, cost: state.cost_acc },
        degraded_summaries: [...state.degraded],
        children: state.children,
        error: state.phase.error,
      };
      core.runs.push(record);
      return {
        run_id: state.run_id,
        parent_run_id: state.parent_run_id,
        entry_scope: state.scope.id,
        outcome: state.phase.outcome,
        payload: clean_payload(state.payload),
        summary: state.phase.summary,
        cost: record.cost,
        error: state.phase.error,
      };
    }

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
    // §7.3 注入：运行中用户发话并入本轮输入（main 自治仲裁消费；排队语义由
    // 注入 seam 保证——未消费消息保持待取，不丢）
    const userText = core.deps.next_user_input?.(state.run_id, state.scope.id) ?? '';
    // 会话记忆注入：仅 main 作用域根 run 的 turn（作用域私有上下文通道，白板
    // 语义之外；子执行/子作用域零注入——引擎不持久化记忆）
    const sessionCtx =
      state.scope.id === 'main' && state.parent_run_id === null ? core.session_context : null;
    const turn = await core.deps.turn.run_scope_turn({
      run_id: state.run_id,
      step: state.steps + 1,
      scope: state.scope,
      boot_system_prompt: core.deps.boot_system_prompt ?? '',
      input: await build_turn_input(userText, state.payload, wbBlocks, {
        context_window: state.whiteboard_context_window ?? null,
        session_context: sessionCtx ?? undefined,
      }),
      payload: { ...state.payload },
      thread_id: state.run_id,
      whiteboard_blocks: wbBlocks,
      inject: core.inject_for_turn(),
    });
    state.steps += 1;
    state.phase = { kind: 'idle' };

    // 工具审批挂起（turn 内模型回路 review 挂卡）：写 interrupted checkpoint
    // （相位 turn_resume）+ 挂起——恢复时注入决议后整轮重跑
    if (turn.interrupt !== null && turn.interrupt !== undefined) {
      await core.checkpoint(
        state,
        { kind: 'turn_resume', step: state.steps },
        { reason: 'interrupted', interrupt: turn.interrupt },
      );
      throw new InterruptSignal(turn.interrupt.key, turn.interrupt.payload);
    }

    if (userText !== '') {
      emit({ run_id: state.run_id, parent_run_id: state.parent_run_id, scope: state.scope.id, action: 'user_inject', detail: { step: state.steps } });
    }

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
    // 圆桌共享板面写路径（`__board` 结构化产物声明）：写授权（open 模式或召集
    // grants 显式授 board write，fail-closed）→ 追加 board 块（owner=声明作用域）
    // → 审计经既有 whiteboard_audit 通道带出（追加产 1 条 write 审计；本处位于
    // top-of-loop 差量之后，生效分支显式转发一次不重复）。blind 无授权 = 显式拒绝。
    const board = process_board_write(state.whiteboard, state.scope.id, produced);
    delete produced[PAYLOAD_BOARD_KEY];
    if (board.status === 'rejected') {
      return finish_fail(core, state, board.reason);
    }
    if (board.status === 'applied') {
      const detail: Record<string, unknown> = {
        scope: board.entry.scope,
        block_id: board.entry.block_id,
        kind: board.entry.kind,
        action: board.entry.action,
      };
      emit({ run_id: state.run_id, parent_run_id: state.parent_run_id, scope: state.scope.id, action: 'whiteboard_audit', detail });
      if (core.deps.on_whiteboard_audit) core.deps.on_whiteboard_audit([board.entry]);
    }
    let decision = routing_decision_from_output(produced, turn.reply);
    // 先验回落只作用于入口首轮（steps=1 的这次加工 = 入口路由局部判定）；其后
    // 无声明即兜底直收（自治"何时收"，不反复按路线首跳重入）
    if (decision === null && state.steps === 1) {
      const fb = fallback_routing(core.priors, state.scope.id, state.trigger, 0);
      if (fb !== null) decision = fb.decision;
    }
    Object.assign(state.payload, clean_payload(produced));

    // 每轮 scope turn 后写执行级 checkpoint（相位 turn_done；gate pending =
    // 恢复时重过闸，passed = 已放行跳过）——挂起/崩溃恢复的续跑锚点
    await core.checkpoint(state, { kind: 'turn_done', decision, gate: 'pending' });

    if (decision === null) return finish_ok(core, state);
    const outcome = await run_transition(core, state, emit, decision, false);
    if (outcome !== null) return outcome;
  }
}
