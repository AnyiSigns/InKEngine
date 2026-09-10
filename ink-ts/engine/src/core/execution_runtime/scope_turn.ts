/**
 * 单轮作用域加工的执行契约（ScopeTurnRunner seam 类型 + 载荷文本投影辅助）。
 *
 * 执行模型「§7.1 工具统一触发协议 / §7.2 块 → 物理输入的分层衔接」：每次作用域
 * LLM 调用 = 输入调配的收敛点——本运行时把当前载荷投影成文本 input（调用级临时
 * 拼接，不进持久化消息链），系统提示词按「boot 基线 + 作用域 persona 叠加」给；
 * 产物 = 回复文本（可含 `__next`）+ turn runner 直接给的结构化字段。载荷清洗与
 * 归并不在本层（fan_in / execution_runtime），本层只定 seam 与投影辅助。
 */

import { isRecord } from '../json.js';
import type { ScopeTurnContext, ScopeTurnResult } from './runtime_types.js';
import type { ScopeTurnRunner } from './runtime_types.js';
import { build_block_sources } from '../context/block_source.js';
import type { AuthorizedBlock } from '../context/block_source.js';
import { ContextMixer } from '../context/context_mixer.js';

/** 载荷文本投影的字段保留键（task 文本的载荷键）。 */
export const PAYLOAD_TASK_KEY = 'task';

/** 载荷字段 → 文本投影（输入调配面；JSON 序列化 + 只读展示字段）。 */
export function project_payload_text(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && key === PAYLOAD_TASK_KEY) {
      parts.push(value);
      continue;
    }
    parts.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return parts.join('\n');
}

/**
 * scope 加工输入装配（调用级临时拼接，不进持久化消息链）。
 *
 * 零漂移：blocks 为空/undefined 时行为与旧版同步 build_turn_input 完全一致。
 * 带白板时：被授权块集 + 作用域私有上下文（payload 投影）交既有调配管线
 * （§7.2 ContextMixer/ContextAssembler/WeightedBudgetAllocator）统一预算
 * 分配、加权组装——调配切片不进 messages 通道，只拼进本次调用的 input。
 */
export async function build_turn_input(
  task: string,
  payload: Record<string, unknown>,
  blocks: readonly AuthorizedBlock[] | undefined,
  opts: WhiteboardAssemblyOptions = {},
): Promise<string> {
  const projected = project_payload_text(payload);
  if (task === '' && !blocks?.length) return projected;

  let whiteboardText = '';
  if (blocks && blocks.length > 0) {
    const blockResult = build_block_sources(blocks, projected, opts.context_window);
    const mixed = await (opts.mixer ?? new ContextMixer()).mix(blockResult.sources, {
      total_chars: blockResult.budget_chars,
    });
    whiteboardText = mixed.text;
  }

  const parts: string[] = [];
  if (task !== '') parts.push(task);
  if (whiteboardText !== '') parts.push(whiteboardText);
  if (projected !== '' && !blocks?.length) parts.push(projected);
  return parts.join('\n');
}

/** 白板装配选项（全部可选；缺省 = 沿用命名常量默认值）。 */
export interface WhiteboardAssemblyOptions {
  /** 作用域所用模型的 context_window（缺省 = null，resolve_compression_min_chars 回落 200k 兜底）。 */
  context_window?: number | null | undefined;
  /** 装配管线混音器（缺省 = 新建 ContextMixer）。 */
  mixer?: ContextMixer | null;
}

/** 回复文本 → 载荷（模型产物为 JSON dict 时逐字段并入；否则为 message 文本）。 */
export function payload_from_reply(reply: string): Record<string, unknown> {
  const trimmed = reply.trim();
  if (trimmed === '') return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) return { ...parsed };
  } catch {
    // 非纯 JSON 回复 → 按文本载荷处理
  }
  return { message: reply };
}

/** 便捷构造 ScopeTurnResult（成功面）。 */
export function ok_turn(
  reply: string,
  extra: { payload?: Record<string, unknown>; cost?: ScopeTurnResult['cost'] } = {},
): ScopeTurnResult {
  const out: ScopeTurnResult = { ok: true, reply };
  if (extra.payload !== undefined) out.payload = extra.payload;
  if (extra.cost !== undefined && extra.cost !== null) out.cost = extra.cost;
  return out;
}

/** 便捷构造 ScopeTurnResult（失败/降级面）。 */
export function failed_turn(reason: string, summary: string): ScopeTurnResult {
  return { ok: false, reply: '', reason, summary };
}

export type { ScopeTurnContext, ScopeTurnResult, ScopeTurnRunner };
