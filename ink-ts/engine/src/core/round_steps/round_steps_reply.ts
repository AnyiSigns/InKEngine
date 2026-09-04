/**
 * RoundSteps 回复流原语（round_steps.py reply_token / set_final_reply 部分
 * 移植）。
 *
 * 回复段切分与终态校准逻辑拆出为纯函数——便于 RoundSteps 主文件按子机制
 * 拆分；调用方传 CardCtx 形态的最小状态（与 cards.ts 同构）。
 */

import type { JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import { REPLY_COUNT_KEY, REPLY_JOIN_SEPARATOR, type StepRecord } from './round_steps_types.js';

/** 回复流累积所需的最小状态（与 cards.ts CardCtx 同构，reply_open 由 ctx 闭包）。 */
export interface ReplyCtx {
  readonly steps: StepRecord[];
  replyOpen: boolean;
  readonly closeReply: () => void;
  readonly nextCount: (kind: string) => string;
  readonly append: (step_type: string, step_id: string, payload: JsonRecord) => string;
  readonly lastStep: () => StepRecord | null;
}

/** 回复流累积：当前段追加；无打开段时新建 reply 步骤。 */
export function replyToken(ctx: ReplyCtx, token: string): string {
  const last = ctx.steps.length > 0 ? ctx.steps[ctx.steps.length - 1]! : null;
  if (ctx.replyOpen && last !== null && last.type === 'reply_token') {
    const cur = isRecord(last.payload) ? last.payload : {};
    const prevContent = cur['content'];
    const next = (typeof prevContent === 'string' ? prevContent : '') + token;
    last.payload = { ...cur, content: next };
    return last.step_id;
  }
  const stepId = `reply:${ctx.nextCount(REPLY_COUNT_KEY)}`;
  ctx.append('reply_token', stepId, { content: token });
  ctx.replyOpen = true;
  return stepId;
}

/**
 * 回合完成时以最终回复校准回复（防执行层回复重复）。
 *
 * 终态回复常是「执行层回复 + 收尾段」的完整拼接，而执行层回复已流式进更早
 * 的 reply 段，按三种情形处理：
 * - 多段且 reply 以「前 N-1 段拼接」为前缀 → 仅替换末段为剩余部分；
 * - 单段且该段仍是最后一步（未切段）→ 整段替换为 reply（与实时流式气泡
 *   定型语义一致）；
 * - 末段已被切段（工具/审批卡之后）或与既有段无前缀关系（非流式内容）
 *   → 保留已流式段，另起新段（与实时分气泡一致）。
 */
export function setFinalReply(ctx: ReplyCtx, reply: string): void {
  if (!reply) return;
  const replySteps: StepRecord[] = [];
  for (const s of ctx.steps) {
    if (s.type === 'reply_token') replySteps.push(s);
  }
  if (replySteps.length === 0) {
    const stepId = `reply:${ctx.nextCount(REPLY_COUNT_KEY)}`;
    ctx.append('reply_token', stepId, { content: reply });
    return;
  }
  const last = replySteps[replySteps.length - 1]!;
  let prefix = '';
  for (let i = 0; i < replySteps.length - 1; i++) {
    const s = replySteps[i]!;
    const content = s.payload['content'];
    prefix += typeof content === 'string' ? content : '';
  }
  if (prefix && reply.startsWith(prefix)) {
    let remainder = reply.slice(prefix.length);
    if (remainder.startsWith(REPLY_JOIN_SEPARATOR)) {
      remainder = remainder.slice(REPLY_JOIN_SEPARATOR.length);
    }
    if (remainder) {
      last.payload = { ...last.payload, content: remainder };
    } else {
      // 终态回复恰等于前缀（末段流式内容被前缀覆盖/冗余）：清空末段，与单段
      // 路径「整段定型为 reply」语义一致，避免末段残留重复内容
      last.payload = { ...last.payload, content: '' };
    }
    return;
  }
  const lastOverall = ctx.lastStep();
  if (lastOverall === last) {
    // 末段仍是最后一步（回复段未切段）：整段定型替换
    const cur = last.payload['content'];
    if (cur !== reply) {
      last.payload = { ...last.payload, content: reply };
    }
    return;
  }
  let total = '';
  for (const s of replySteps) {
    const content = s.payload['content'];
    total += typeof content === 'string' ? content : '';
  }
  if (reply !== total) {
    const stepId = `reply:${ctx.nextCount(REPLY_COUNT_KEY)}`;
    ctx.append('reply_token', stepId, { content: reply });
  }
}