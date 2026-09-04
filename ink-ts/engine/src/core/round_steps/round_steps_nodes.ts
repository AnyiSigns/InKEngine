/**
 * RoundSteps 节点步工具（round_steps.py 节点相关部分移植）。
 *
 * 节点 step_id 构造与进度内嵌的纯函数——剥离自 RoundSteps 类便于拆分（与
 * Python `_node_step_id` / `_progress_from` 静态方法同构）。
 *
 * step_id 截断统一在构造时按与 `_append` 同口径——stream/end/fail 按此 id
 * 查索引，不截断会在超长 node_id 时查不到已追加的记录。
 */

import type { JsonRecord } from '../json.js';
import type { NodeProgress, StepRecord } from './round_steps_types.js';
import { STEP_ID_MAX_CHARS } from './round_steps_types.js';

/**
 * 节点 step_id：带序号即分卡（批量任务每项一卡），否则同 id 复用。
 *
 * 与 `_append` 同口径截断——stream/end/fail 按此 id 查索引，不截断会在
 * 超长 node_id 时查不到已追加的记录。
 */
export function node_step_id(node_id: string, index: number = 0): string {
  const stepId = index ? `node:${node_id}:${index}` : `node:${node_id}`;
  return stepId.slice(0, STEP_ID_MAX_CHARS);
}

/**
 * 批量进度内嵌（第 n/total 项）；缺任一维度即无进度。
 *
 * 只给 chapter_index 也会归 0/0 不写进度，避免渲染 n/0；与 Python 同语义。
 */
export function nodeProgressFrom(extra: JsonRecord): NodeProgress | null {
  const ciRaw = extra['chapter_index'];
  const ctRaw = extra['chapter_total'];
  const chapterIndex =
    typeof ciRaw === 'number' ? Math.trunc(ciRaw) : (ciRaw ? Number(ciRaw) : 0);
  const chapterTotal =
    typeof ctRaw === 'number' ? Math.trunc(ctRaw) : (ctRaw ? Number(ctRaw) : 0);
  if (chapterTotal && chapterIndex) {
    return { step: 'write', n: chapterIndex, total: chapterTotal };
  }
  return null;
}

/** 节点卡方法所需的最小状态（与 cards/reply 子机制 ctx 同构，便于拆分）。 */
export interface NodeCtx {
  readonly steps: StepRecord[];
  readonly index: Map<string, StepRecord>;
  readonly nodeLabels: ReadonlyMap<string, string>;
  readonly lastByType: (step_type: string) => StepRecord | null;
  readonly closeReply: () => void;
  readonly append: (step_type: string, step_id: string, payload: JsonRecord) => string;
  readonly update: (step_id: string, patch: JsonRecord) => void;
  readonly stepPayload: (step_id: string) => JsonRecord;
}

/**
 * 节点卡开始。extra 携带进度序号（chapter_index/chapter_total）时按序号
 * 分卡并内嵌进度。
 *
 * 同 step_id 复用时只刷新状态/进度，保留首次标签——节点内部多环节各自
 * start 不覆盖对外展示名。
 */
export function nodeStart(
  ctx: NodeCtx,
  node_id: string,
  label: string,
  extra?: JsonRecord | null,
): string {
  ctx.closeReply();
  const ex = extra ? extra : {};
  const chapterIndexRaw = ex['chapter_index'];
  const chapterIndex =
    typeof chapterIndexRaw === 'number' ? Math.trunc(chapterIndexRaw) : 0;
  const stepId = node_step_id(node_id, chapterIndex);
  const progress = nodeProgressFrom(ex);
  const existing = ctx.lastByType('node');
  if (existing && existing.step_id === stepId) {
    const patch: JsonRecord = { status: 'running' };
    if (progress) patch['progress'] = progress;
    existing.payload = { ...existing.payload, ...patch };
    return existing.step_id;
  }
  const overrideLabel = ctx.nodeLabels.get(node_id);
  const finalLabel = overrideLabel ?? (label || node_id);
  const payload: JsonRecord = {
    node_id,
    label: finalLabel,
    status: 'running',
  };
  if (progress) payload['progress'] = progress;
  return ctx.append('node', stepId, payload);
}

/** 节点流式 token 追加（按 step_id 命中既有记录并累积 content）。 */
export function nodeStream(
  ctx: NodeCtx,
  node_id: string,
  index: number,
  token: string,
): string {
  const stepId = node_step_id(node_id, Math.trunc(Number(index) || 0));
  const cur = ctx.stepPayload(stepId);
  const prevContent = cur['content'];
  const next = (typeof prevContent === 'string' ? prevContent : '') + token;
  ctx.update(stepId, { content: next });
  return stepId;
}

/** 节点收尾（定型 completed；tokens 非空才写 tokens 字段）。 */
export function nodeEnd(
  ctx: NodeCtx,
  node_id: string,
  index: number,
  tokens: number | null,
): string {
  const stepId = node_step_id(node_id, Math.trunc(Number(index) || 0));
  const patch: JsonRecord = { status: 'completed' };
  if (tokens !== null) patch['tokens'] = tokens;
  ctx.update(stepId, patch);
  return stepId;
}

/** 节点失败（定型 failed + 失败原因）。 */
export function nodeFail(
  ctx: NodeCtx,
  node_id: string,
  index: number,
  reason: string,
): string {
  const stepId = node_step_id(node_id, Math.trunc(Number(index) || 0));
  ctx.update(stepId, { status: 'failed', reason });
  return stepId;
}