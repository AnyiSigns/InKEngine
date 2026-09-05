/**
 * 上下文窗口压缩策略与历史压缩（context.py 移植）。
 *
 * 窗口参数一律按「该调用所用模型」的模型档案（model_archive context_window），
 * 不做角色槽推断（角色槽只决定哪个通道用哪个模型，不决定窗口参数）；档案缺失
 * 回落 200k 兜底（现代长窗，避免短视压缩）。比例由宿主可调（全局占比）。
 */

import { message_role, user, Message } from '../llm/messages.js';

/** 压缩阈值与模型窗口比例（全局唯一旋钮）。 */
export const COMPRESSION_CONTEXT_WINDOW_RATIO = 0.8;
/** 档案缺失时回落 200k 兜底（现代长窗，避免短视压缩）。 */
export const COMPRESSION_DEFAULT_CONTEXT_WINDOW = 200_000;
/** 默认压缩字符阈值 = 兜底窗口 × 比例。 */
export const COMPRESSION_DEFAULT_MIN_CHARS = Math.trunc(
  COMPRESSION_DEFAULT_CONTEXT_WINDOW * COMPRESSION_CONTEXT_WINDOW_RATIO,
);

/** 工具结果回填截断：窗口占比 + 下限兜底（小窗口模型不虚高）。 */
export const TOOL_RESULT_WINDOW_RATIO = 0.05;
/** 工具结果回填下限（小窗口模型不因比例跌破，零回归）。 */
export const TOOL_RESULT_MAX_CHARS_FLOOR = 4000;

/**
 * 压缩字符阈值（按模型档案 context_window 动态推算）。
 *
 * - 已知 context_window：取 ``int(ratio * cw)``（250k→200k、32k→26k）；
 * - 档案缺失：回落 ``ratio × 200k`` 兜底（不按角色槽推断）。
 */
export function resolve_compression_min_chars(
  context_window: number | null | undefined,
  opts: { ratio?: number } = {},
): number {
  const ratio = opts.ratio ?? COMPRESSION_CONTEXT_WINDOW_RATIO;
  if (context_window && context_window > 0) {
    return Math.trunc(context_window * ratio);
  }
  return Math.trunc(COMPRESSION_DEFAULT_CONTEXT_WINDOW * ratio);
}

/**
 * 工具结果回填截断上限（按模型档案 context_window 动态推算）。
 *
 * - 已知 context_window：``max(floor, int(ratio * cw))``（250k→12.5k）；
 * - 档案缺失：``max(floor, int(0.05 * 200k))``（10k）；
 * - 下限 = floor（小窗口模型不因比例跌破，零回归）。
 */
export function resolve_tool_result_max_chars(
  context_window: number | null | undefined,
  opts: { ratio?: number; floor?: number } = {},
): number {
  const ratio = opts.ratio ?? TOOL_RESULT_WINDOW_RATIO;
  const floor = opts.floor ?? TOOL_RESULT_MAX_CHARS_FLOOR;
  if (context_window && context_window > 0) {
    return Math.max(floor, Math.trunc(context_window * ratio));
  }
  return Math.max(floor, Math.trunc(COMPRESSION_DEFAULT_CONTEXT_WINDOW * ratio));
}

/**
 * 压缩策略钩子：触发判定 + 预算（宿主注入，换策略不改装配）。
 *
 * 触发判定与预算分配分层：判定（该不该压）与分配（压到多紧）都是
 * 可注入策略——分配复用 BudgetAllocator 协议，判定/预算经本钩子
 * 注入；默认实现见 ThresholdCompressionPolicy。
 */
export interface CompressionPolicy {
  /** 触发判定：基于状态（消息量/字符量等）决定本轮是否压缩。 */
  should_compress(state: Record<string, unknown>): boolean;
  /** 压缩预算（摘要目标字符数，喂给预算分配）。 */
  budget_chars(state: Record<string, unknown>): number;
}

/**
 * 默认压缩策略：消息量与字符量双阈值触发（确定性，可断言）。
 *
 * 策略语义：两者都达到阈值才触发（短消息多轮不压、长消息少量不压），
 * 预算固定返回配置值；阈值与预算均为构造参数（宿主按场景注入）。
 *
 * ``from_context_window`` 类方法按模型档案 ``context_window`` 动态推算
 * 字符阈值，使压缩阈值随模型窗口自适应。
 */
export class ThresholdCompressionPolicy implements CompressionPolicy {
  readonly min_messages: number;
  readonly min_chars: number;
  private readonly _budget_chars: number;

  constructor(opts: { min_messages?: number; min_chars?: number; budget_chars?: number } = {}) {
    const min_messages = opts.min_messages ?? 30;
    const min_chars = opts.min_chars ?? COMPRESSION_DEFAULT_MIN_CHARS;
    const budget_chars = opts.budget_chars ?? 8000;
    if (min_messages < 1 || min_chars < 1 || budget_chars < 1) {
      throw new RangeError('压缩阈值与预算必须为正数');
    }
    this.min_messages = min_messages;
    this.min_chars = min_chars;
    this._budget_chars = budget_chars;
  }

  /**
   * 按模型档案 context_window 动态构建（阈值 = 占比 × cw，档案缺失 200k 兜底）。
   *
   * ratio = 压缩占比（全局唯一旋钮，默认 0.8；用户可在设置页调整，
   * 引擎按模型档案窗口 × 占比动态推算阈值——不暴露 token 数）。
   */
  static from_context_window(
    context_window: number | null | undefined,
    opts: { ratio?: number; min_messages?: number; budget_chars?: number } = {},
  ): ThresholdCompressionPolicy {
    const min_chars = resolve_compression_min_chars(context_window, { ratio: opts.ratio });
    return new ThresholdCompressionPolicy({
      min_messages: opts.min_messages,
      min_chars,
      budget_chars: opts.budget_chars,
    });
  }

  should_compress(state: Record<string, unknown>): boolean {
    const messages = (state['messages'] as unknown[] | null | undefined) ?? [];
    if (messages.length < this.min_messages) return false;
    let total = 0;
    for (const msg of messages) {
      const content = msg_content(msg);
      total += String(content ?? '').length;
      if (total >= this.min_chars) return true;
    }
    return false;
  }

  budget_chars(_state: Record<string, unknown>): number {
    return this._budget_chars;
  }
}

/** 消息内容归一取值（dict / 类实例兼容）。 */
function msg_content(msg: unknown): unknown {
  if (msg !== null && typeof msg === 'object' && !Array.isArray(msg)) {
    const obj = msg as Record<string, unknown>;
    return obj['content'];
  }
  return (msg as { content?: unknown } | null | undefined)?.content;
}

/** 单条消息归一为 dict 形态（state['messages'] 期望）。 */
export function message_to_dict(msg: unknown): Record<string, unknown> {
  if (msg instanceof Message) return msg.to_dict() as Record<string, unknown>;
  if (msg !== null && typeof msg === 'object' && !Array.isArray(msg)) {
    return msg as Record<string, unknown>;
  }
  return {};
}

/**
 * 回合内消息流压缩（LLM 消息组装处的确定性压缩视图）。
 *
 * 语义（非破坏性：原始消息流不修改，返回压缩后的视图列表）：
 * - ``policy.should_compress`` 未触发 → 原列表副本直接返回（零改动）；
 * - 触发 → 头部 system 消息恒保留（提示词不压缩）+ 最近
 *   ``keep_recent`` 条消息原样保留 + 中间旧消息段折叠为一条确定性
 *   摘要 user 消息（archive_digest，预算 = ``policy.budget_chars``）。
 *
 * 摘要以「历史上下文压缩摘要」标注前缀，模型可辨识该段为压缩锚点
 * 而非原始消息。
 */
export function compress_message_history(
  messages: readonly unknown[],
  opts: { policy: CompressionPolicy; keep_recent?: number },
): unknown[] {
  if (messages.length === 0) return [...messages];
  const state = { messages: messages.map(message_to_dict) };
  if (!opts.policy.should_compress(state)) return [...messages];

  const count = messages.length;
  let head = 0;
  while (head < count && message_role(messages[head]) === 'system') {
    head += 1;
  }
  const keep_recent = Math.max(1, Math.trunc(opts.keep_recent ?? 10));
  let tail_start = Math.max(head, count - keep_recent);
  // 折叠边界对齐工具轮：不让 tail 以 tool 消息开头，也不把工具轮从中劈断。
  for (const [start, end] of tool_round_spans(messages)) {
    if (start <= tail_start && tail_start <= end) {
      tail_start = start >= head ? start : end + 1;
      break;
    }
  }
  // 兜底：剔除仍可能残留在 tail 开头的孤立 tool 消息
  while (tail_start < count && message_role(messages[tail_start]) === 'tool') {
    tail_start += 1;
  }
  if (tail_start <= head) {
    // 中间无旧消息段可折叠：全部为 system + 保留尾段，不压缩
    return [...messages];
  }
  const middle = messages.slice(head, tail_start);
  const digest = archive_digest(middle, { max_chars: opts.policy.budget_chars(state) });
  const summary = user(`【历史上下文压缩摘要（${middle.length} 条旧消息）】\n${digest}`);
  return [...messages.slice(0, head), summary, ...messages.slice(tail_start)];
}

/**
 * 工具轮区间 [起点索引, 终点索引]（assistant(tool_calls) → 末尾 tool）。
 * 折叠点若落在某轮区间内会劈断工具轮，产生悬空 tool 消息。
 */
export function tool_round_spans(messages: readonly unknown[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let cur_start: number | null = null;
  let cur_tools: number[] = [];

  const close = (): void => {
    if (cur_start !== null && cur_tools.length > 0) {
      spans.push([cur_start, cur_tools[cur_tools.length - 1]!]);
    }
    cur_start = null;
    cur_tools = [];
  };

  messages.forEach((msg, idx) => {
    const role = message_role(msg);
    if (role === 'tool') {
      if (cur_start !== null) cur_tools.push(idx);
    } else if (role === 'assistant') {
      close();
      if (tool_calls_of(msg).length > 0) cur_start = idx;
    } else if (role === 'user') {
      close(); // 回合边界闭合当前轮
    }
  });
  close();
  return spans;
}

/** 取 assistant 消息的工具调用列表（Message / dict 双形态，无则空序列）。 */
function tool_calls_of(msg: unknown): readonly unknown[] {
  if (msg instanceof Message) return msg.tool_calls ?? [];
  if (msg !== null && typeof msg === 'object' && !Array.isArray(msg)) {
    const calls = (msg as Record<string, unknown>)['tool_calls'];
    return Array.isArray(calls) ? calls : [];
  }
  return [];
}

/** 确定性窗口归档摘要（无 LLM，避免域切换频繁触发压缩成本）。 */
export function archive_digest(
  window: readonly unknown[],
  opts: { max_chars?: number } = {},
): string {
  const DIGEST_GOAL_CHARS = 120;
  const DIGEST_GOAL_COUNT = 3;
  const DIGEST_BODY_CHARS = 400;
  const maxChars = opts.max_chars ?? 800;

  const goals: string[] = [];
  const bodies: string[] = [];
  let toolRounds = 0;
  for (const m of window) {
    const role = message_role(m);
    const text = message_text(m);
    if (role === 'user' && text.length > 0) {
      goals.push(text.slice(0, DIGEST_GOAL_CHARS));
    } else if (role === 'assistant' && tool_calls_of(m).length === 0 && text.length > 0) {
      bodies.push(text.slice(0, DIGEST_BODY_CHARS));
    } else if (role === 'assistant' && tool_calls_of(m).length > 0) {
      toolRounds += 1;
    }
  }
  const parts: string[] = [];
  if (goals.length > 0) {
    parts.push('用户目标：' + goals.slice(-DIGEST_GOAL_COUNT).join('；'));
  }
  if (bodies.length > 0) {
    parts.push('最近回复：' + bodies[bodies.length - 1]!);
  }
  parts.push(`工具轮数：${toolRounds}`);
  return parts.join('\n').slice(0, maxChars);
}

/**
 * 消息文本统一取值（Message / dict 双形态；list 型 content 拼接 text 段）。
 */
export function message_text(msg: unknown): string {
  const content = msg_content(msg);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const seg of content) {
      if (seg !== null && typeof seg === 'object' && !Array.isArray(seg)) {
        const text = (seg as Record<string, unknown>)['text'];
        if (text !== undefined && text !== null) parts.push(String(text));
      }
    }
    return parts.join('\n');
  }
  return String(content ?? '');
}