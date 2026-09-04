/**
 * RoundSteps 共享常量与类型（round_steps.py 移植的协议面）。
 *
 * step_id 长度上限统一在追加时截断——超长 node_id / tool_call_id 会撑爆
 * 存储行与前端渲染 key；回合内唯一性由前缀 + 计数/调用 id 保证，截断不
 * 致冲突（截断后 hash 同前缀撞号仍由 tool_call_id/node_id 决定，无法
 * 跨 id 撞号）。
 *
 * 按类计数的步骤类型：step_id = <前缀>:<该类序号>，从种子恢复时由
 * `_restore_counts` 重建计数保证续流 step_id 与中断前连续。
 *
 * 回复段落计数键（reply_token 步骤共用一个计数器，与步骤 type 名不同）：
 * reply 与其它按类计数步骤解耦——同一回合内 reply 段数无上限。
 *
 * 路由 reply 分支拼接「执行层回复」与「收尾段」的分隔符：不属流式内容，
 * set_final_reply 剥离前缀后需连带剥离它（防末段以空行开头）。
 *
 * memory_hit 可挂载的宿主卡类型（就近附着到最近一张思考/规划卡）。
 */

import type { JsonRecord } from '../json.js';

/** step_id 长度上限（超长 id 在追加时截断，回合内唯一性由前缀保证）。 */
export const STEP_ID_MAX_CHARS = 200;

/** 按类计数的步骤类型集合（步骤 type ∈ 此集合 → 占同前缀计数器）。 */
export const COUNTED_KINDS: ReadonlySet<string> = new Set<string>([
  'thinking',
  'plan',
  'review_card',
  'memory_hit',
  'suggestions',
  'error',
]);

/** 回复段落计数键（reply_token 步骤共用此键，与步骤 type 名不同）。 */
export const REPLY_COUNT_KEY = 'reply';

/** 路由 reply 分支拼接「执行层回复」与「收尾段」的分隔符（两个换行）。 */
export const REPLY_JOIN_SEPARATOR = '\n\n';

/** memory_hit 可挂载的宿主卡类型：就近附着到最近一张思考/规划卡。 */
export const MEMORY_ATTACH_KINDS: readonly string[] = ['plan', 'thinking'];

/** 步骤记录形状：{step_id, type, payload}（JSON 兼容值）。 */
export type StepRecord = {
  step_id: string;
  type: string;
  payload: JsonRecord;
};

/** 节点进度内嵌（第 n/total 项）。 */
export type NodeProgress = {
  step: 'write';
  n: number;
  total: number;
};

/** 节点卡额外参数（携带进度序号时按 chapter_index 分卡并内嵌进度）。 */
export type NodeExtra = {
  chapter_index?: number;
  chapter_total?: number;
};