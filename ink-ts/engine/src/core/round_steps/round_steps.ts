/**
 * 回合步骤序列累积器（round_steps.py 移植）：纯内存、无副作用、可单测。
 *
 * 回合（用户消息边界）/ 步骤（step_id）/ 回合步骤序列是历史回放的单一事实
 * 来源：实时事件发射顺序 = 录制顺序 = 回放顺序。累积器维护「当前回合」的
 * 步骤数组，宿主把它写入 checkpoint 通道（中断回合续流）并在回合完成时
 * 快照落库——落库与传输是宿主职责，本原语纯内存、无副作用、零依赖。
 *
 * step_id 在回合内稳定唯一（前端渲染 key 与 SSE 配对更新依赖此稳定性）：
 * - thinking/plan/review_card/memory_hit/suggestions/error 按类计数
 *   （think:1 / plan:1 / card:1 ...）；
 * - tool 按 tool_call_id（tool:<id>，无 id 回退计数）；
 * - node 按 node_id（node:<node_id>；携带进度序号时按 node:<node_id>:<序号>
 *   分卡，同 id 的 node_start 复用更新）；
 * - reply_token 按回复段计数（reply:1 / reply:2——工具卡/审批卡/节点卡出现
 *   即切新段，与前端回复气泡分段语义一致）；
 * - user 固定 user（回合边界，单条）。
 *
 * 按子机制拆分（round_steps_internals.ts 提供 state + ctx 工厂，子机制模
 * 块以 ctx 接口解耦——主类不导出内部原语）：
 * - round_steps_nodes.ts：node step_id 构造 + 进度内嵌 + 节点卡方法；
 * - round_steps_tools.ts：tool start/end + 共享 ctx；
 * - round_steps_assembly.ts：组装阶段 start/end；
 * - round_steps_cards.ts：thinking/plan 流式累积 + 收尾；
 * - round_steps_reply.ts：reply_token 流式 + setFinalReply 终态校准；
 * - round_steps_misc.ts：user/memory_hit/review_card/suggestions/error。
 *
 * 节点展示标签由宿主经 `node_labels` 注入（引擎不内置任何业务节点名或界面
 * 文案）；其余语义对各类 agent 通用。
 */

import type { JsonRecord } from '../json.js';
import type { StepRecord } from './round_steps_types.js';
import {
  buildAssemblyCtx,
  buildCardCtx,
  buildMiscCtx,
  buildNodeCtx,
  buildReplyCtx,
  buildRoundStepsState,
  buildState,
  type RoundStepsState,
} from './round_steps_internals.js';
import { nodeStart, nodeStream, nodeEnd, nodeFail } from './round_steps_nodes.js';
import { toolStart, toolEnd } from './round_steps_tools.js';
import { assemblyStart, assemblyEnd } from './round_steps_assembly.js';
import {
  planEnd,
  planStart,
  planToken,
  thinkingEnd,
  thinkingStart,
  thinkingToken,
} from './round_steps_cards.js';
import {
  replyToken as replyTokenFn,
  setFinalReply as setFinalReplyFn,
} from './round_steps_reply.js';
import {
  user as userFn,
  memoryHit as memoryHitFn,
  reviewCard as reviewCardFn,
  suggestions as suggestionsFn,
  error as errorFn,
} from './round_steps_misc.js';

/**
 * 回合步骤累积器：从 checkpoint 种子恢复中断回合，计数由已有步骤反推，
 * 保证续流回合的 step_id 与中断前连续（前端按 step_id 增量更新既有卡片）。
 */
export class RoundSteps {
  readonly round_id: string;
  private readonly _node_labels: ReadonlyMap<string, string>;
  private readonly _state: RoundStepsState;

  constructor(
    round_id: string,
    seed: readonly unknown[] | null = null,
    node_labels?: Readonly<Record<string, string>> | null,
  ) {
    this.round_id = round_id || '';
    this._node_labels = new Map<string, string>(
      node_labels ? Object.entries(node_labels) : [],
    );
    const built = buildState(seed);
    this._state = buildRoundStepsState(
      built.steps,
      built.index,
      built.counts,
      built.replyOpen,
    );
  }

  // ---- 读取 ----

  /** 当前回合步骤序列（浅拷贝列表，记录本身仍为内部对象）。 */
  steps(): StepRecord[] {
    return [...this._state.steps];
  }

  /** 最近一个步骤；空累积器返回 null。 */
  lastStep(): StepRecord | null {
    return this._state.lastStep();
  }

  /** 最近一个步骤的 step_id；空累积器返回空串。 */
  lastStepId(): string {
    const last = this._state.lastStep();
    return last ? last.step_id : '';
  }

  /** 取指定步骤的 label（payload.label 缺省归空串）。 */
  stepLabel(step_id: string): string {
    const payload = this._state.stepPayload(step_id);
    const label = payload['label'];
    return label === undefined || label === null ? '' : String(label);
  }

  // ---- 回合边界 ----

  /** 回合边界用户消息步骤（幂等：已存在则不重复记录）。 */
  user(content: string): string {
    return userFn(buildMiscCtx(this._state), content);
  }

  // ---- 回复流 ----

  /** 回复流累积：当前段追加；无打开段时新建 reply 步骤。 */
  replyToken(token: string): string {
    const ctx = buildReplyCtx(this._state);
    const r = replyTokenFn(ctx, token);
    this._state.replyOpen = ctx.replyOpen;
    return r;
  }

  /** 回合完成时以最终回复校准回复（防执行层回复重复）。 */
  setFinalReply(reply: string): void {
    const ctx = buildReplyCtx(this._state);
    setFinalReplyFn(ctx, reply);
    this._state.replyOpen = ctx.replyOpen;
  }

  // ---- 思考卡 / 规划卡 ----

  /** 思考卡开始（按 thinking 计数器新建）。 */
  thinkingStart(): string {
    return thinkingStart(buildCardCtx(this._state));
  }

  /** 思考 token 流式追加（仅当末步是思考卡时生效）。 */
  thinkingToken(token: string): void {
    thinkingToken(buildCardCtx(this._state), token);
  }

  /**
   * 思考卡收尾。返回收尾卡的 step_id。
   *
   * 空思考被丢弃时仍返回其原 step_id（供事件层携带，前端据此移除对应空卡，
   * 不指向其它步骤）。
   */
  thinkingEnd(): string {
    return thinkingEnd(buildCardCtx(this._state));
  }

  /** 规划卡开始（按 plan 计数器新建）。 */
  planStart(): string {
    return planStart(buildCardCtx(this._state));
  }

  /** 规划 token 流式追加（仅当末步是规划卡时生效）。 */
  planToken(token: string): void {
    planToken(buildCardCtx(this._state), token);
  }

  /**
   * 规划卡收尾（与 thinking_end 同语义：空规划返回原 step_id 供前端移除）。
   */
  planEnd(): string {
    return planEnd(buildCardCtx(this._state));
  }

  // ---- 组装阶段（固定单步，折叠为一条轨迹步骤）----

  /**
   * 组装阶段开始（固定 assembly 步；重复进入同 id 复用）。
   */
  assemblyStart(started_at: number): string {
    return assemblyStart(buildAssemblyCtx(this._state), started_at);
  }

  /**
   * 组装阶段收尾（定型 done + 耗时；缺 start = 幂等空操作）。
   */
  assemblyEnd(ended_at: number): string {
    return assemblyEnd(buildAssemblyCtx(this._state), ended_at);
  }

  // ---- 记忆命中（挂所属步骤） ----

  /**
   * 记忆命中：挂到最近一张规划/思考卡，否则独立 memory 步骤。
   *
   * 同 id 命中幂等（重复注入不重复挂载），返回承载步骤的 step_id。
   */
  memoryHit(hits: readonly unknown[]): string {
    return memoryHitFn(buildMiscCtx(this._state), hits);
  }

  // ---- 工具卡 ----

  /**
   * 工具卡开始。同 tool_call_id 复用既有卡并复位 running（审批 resume 重发
   * 同一工具调用时不产生重复卡）。
   */
  toolStart(category: string, tool_call_id: string): string {
    return toolStart(
      {
        steps: this._state.steps,
        closeReply: this._state.closeReply,
        nextCount: this._state.nextCount,
        lastByType: this._state.lastByType,
        append: this._state.append,
        lastStep: this._state.lastStep,
      },
      category,
      tool_call_id,
    );
  }

  /**
   * 工具卡收尾。返回命中的 step_id（供事件层配对更新），未命中返回 ""。
   */
  toolEnd(tool_call_id: string, success: boolean): string {
    return toolEnd(
      {
        steps: this._state.steps,
        closeReply: this._state.closeReply,
        nextCount: this._state.nextCount,
        lastByType: this._state.lastByType,
        append: this._state.append,
        lastStep: this._state.lastStep,
      },
      tool_call_id,
      success,
    );
  }

  /**
   * 审批卡到达：把匹配的写工具卡置 pending（等待审批）。返回命中的 step_id。
   */
  toolPending(tool_call_id: string): string {
    return this._state.toolPending(tool_call_id);
  }

  // ---- 节点卡 ----

  /**
   * 节点卡开始。extra 携带进度序号（chapter_index/chapter_total）时按序号
   * 分卡并内嵌进度。
   */
  nodeStart(node_id: string, label: string, extra?: JsonRecord | null): string {
    return nodeStart(buildNodeCtx(this._state, this._node_labels), node_id, label, extra);
  }

  /** 节点流式 token 追加。 */
  nodeStream(node_id: string, index: number, token: string): string {
    return nodeStream(buildNodeCtx(this._state, this._node_labels), node_id, index, token);
  }

  /** 节点收尾（定型 completed；tokens 非空才写 tokens 字段）。 */
  nodeEnd(node_id: string, index: number, tokens: number | null): string {
    return nodeEnd(buildNodeCtx(this._state, this._node_labels), node_id, index, tokens);
  }

  /** 节点失败（定型 failed + 失败原因）。 */
  nodeFail(node_id: string, index: number, reason: string): string {
    return nodeFail(buildNodeCtx(this._state, this._node_labels), node_id, index, reason);
  }

  // ---- 审批卡 ----

  /**
   * 审批卡步骤。payload 携带 tool_call_id 时连带把该工具卡置 pending。
   */
  reviewCard(payload: JsonRecord): string {
    return reviewCardFn(buildMiscCtx(this._state), payload);
  }

  // ---- 建议 / 错误 ----

  /** 建议步骤（按 suggestions 计数器新建）。 */
  suggestions(items: readonly unknown[]): string {
    return suggestionsFn(buildMiscCtx(this._state), items);
  }

  /** 错误步骤（按 error 计数器新建）。 */
  error(content: string): string {
    return errorFn(buildMiscCtx(this._state), content);
  }
}