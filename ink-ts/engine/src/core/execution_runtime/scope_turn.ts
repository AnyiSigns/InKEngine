/**
 * 单轮作用域加工的执行契约（ScopeTurnRunner seam 类型 + 载荷文本投影辅助）。
 *
 * 执行模型「§7.1 工具统一触发协议 / §7.2 块 → 物理输入的分层衔接」：每次作用域
 * LLM 调用 = 输入调配的收敛点——本运行时把当前载荷投影成文本 input（调用级临时
 * 拼接，不进持久化消息链），系统提示词按「boot 基线 + 作用域 persona 叠加」给；
 * 产物 = 回复文本（可含 `__next`）+ turn runner 直接给的结构化字段。载荷清洗与
 * 归并不在本层（fan_in / execution_runtime），本层只定 seam 与投影辅助。
 */

import { isRecord } from '../../model/json.js';
import type { ScopeTurnContext, ScopeTurnResult } from './runtime_types.js';
import type { ScopeTurnRunner } from './runtime_types.js';
import { build_block_sources } from '../context/block_source.js';
import type { AuthorizedBlock } from '../context/block_source.js';
import { ContextMixer } from '../context/context_mixer.js';

/** 载荷文本投影的字段保留键（task 文本的载荷键）。 */
export const PAYLOAD_TASK_KEY = 'task';

/** 载荷附件回声键（rounds seed_payload 同名；W8A 收口 ExecutionRequest.attachments 后的键名）。 */
export const PAYLOAD_ATTACHMENTS_KEY = 'attachments';

/**
 * 回合图像分量（W8B 最简契约 dict，与宿主附件归一侧可互投影）。
 *
 * 引用面三选一：url（http(s)/data:）> data（base64，可带 data: 前缀）> path；
 * media_type 缺省回落 data URL 头部推导或 image/png（url/path 引用不需要合成）。
 */
export interface TurnImageComponent {
  type: 'image';
  media_type?: string | null;
  data?: string | null;
  url?: string | null;
  path?: string | null;
  name?: string | null;
}

/** 附件投影的 mime 候选键（宿主 AttachmentPayload mime_type / DTO mime / 档案 media_type）。 */
function _image_media_type(raw: Record<string, unknown>): string | null {
  for (const key of ['media_type', 'mime_type', 'mime']) {
    if (typeof raw[key] === 'string' && raw[key] !== '') return raw[key] as string;
  }
  return null;
}

/** 附件投影的可选字符串字段归一（空串/null → null）。 */
function _opt_string(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 单条附件投影 → 图像分量（非图像/无引用 = null 留在文本域，零漂移）。 */
function image_component_from(raw: unknown): TurnImageComponent | null {
  if (!isRecord(raw)) return null;
  const kind = _opt_string(raw, 'type') ?? _opt_string(raw, 'kind');
  if (kind !== 'image') return null;
  const data = _opt_string(raw, 'data');
  const url = _opt_string(raw, 'url');
  const path = _opt_string(raw, 'path');
  if (data === null && url === null && path === null) return null;
  const mediaType = _image_media_type(raw);
  const name = _opt_string(raw, 'name');
  return {
    type: 'image',
    media_type: mediaType,
    data,
    url,
    path,
    name,
  };
}

/**
 * 载荷 → 文本域 + 图像分量拆分（装配源形态；图像单列，不进文本预算域）。
 *
 * attachments 数组中的图像条目摘出为媒体分量，其余条目（document/video 与
 * 非法形态）原样留在文本投影（既有文档文件名引用语义零漂移）；图像条目为
 * 空/键非数组 = 逐字段行为与旧版完全一致。
 */
export function split_turn_payload(payload: Record<string, unknown>): {
  text_payload: Record<string, unknown>;
  images: TurnImageComponent[];
} {
  const raw = payload[PAYLOAD_ATTACHMENTS_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return { text_payload: payload, images: [] };
  const images: TurnImageComponent[] = [];
  const rest: unknown[] = [];
  for (const item of raw) {
    const image = image_component_from(item);
    if (image !== null) images.push(image);
    else rest.push(item);
  }
  if (images.length === 0) return { text_payload: payload, images: [] };
  const textPayload: Record<string, unknown> = { ...payload };
  if (rest.length === 0) delete textPayload[PAYLOAD_ATTACHMENTS_KEY];
  else textPayload[PAYLOAD_ATTACHMENTS_KEY] = rest;
  return { text_payload: textPayload, images };
}

/** 载荷中的图像附件分量（供装配方单列携带，不进 input 文本）。 */
export function collect_turn_images(payload: Record<string, unknown>): TurnImageComponent[] {
  return split_turn_payload(payload).images;
}

/** data:URL → mime 头（非 data URL = null）。 */
function _data_url_mime(ref: string): string | null {
  const match = /^data:([^;,]+)[;,]/.exec(ref);
  return match?.[1] ?? null;
}

/** 图像分量引用值（data 缺 data: 前缀时按 media_type 合成 data URL）。 */
export function turn_image_ref(image: TurnImageComponent): string {
  const url = typeof image.url === 'string' && image.url !== '' ? image.url : null;
  if (url !== null) return url;
  const data = typeof image.data === 'string' && image.data !== '' ? image.data : null;
  if (data !== null) {
    if (data.startsWith('data:')) return data;
    return `data:${image.media_type ?? 'image/png'};base64,${data}`;
  }
  return typeof image.path === 'string' ? image.path : '';
}

/**
 * 图像分量 → 引擎 Attachment 数据面 dict（kind=image + url）。
 *
 * 装配侧把返回值随 state.attachments 带给 llm_decider `_toAttachments` 直构
 * （消息附件段构造既有通道）；mime_type 缺省回落 data URL 头部推导。
 */
export function turn_image_to_attachment(image: TurnImageComponent): Record<string, unknown> {
  const ref = turn_image_ref(image);
  return {
    kind: 'image',
    url: ref,
    path: image.path ?? null,
    mime_type: image.media_type ?? _data_url_mime(ref),
    name: image.name ?? null,
  };
}

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
 * 零漂移：blocks 为空/undefined 且无 session_context 时行为与旧版同步
 * build_turn_input 完全一致。带白板时：被授权块集 + 作用域私有上下文（payload
 * 投影）交既有调配管线（§7.2 ContextMixer/ContextAssembler/WeightedBudgetAllocator）
 * 统一预算分配、加权组装——调配切片不进 messages 通道，只拼进本次调用的 input。
 *
 * session_context（W8D 会话记忆收口）：宿主 history 摘要切片（宿主已裁剪预算），
 * 以「会话记忆」标注段拼进输入（作用域私有上下文通道，白板语义之外；不经预算
 * 调配——宿主裁剪即预算），缺省 = 零漂移。
 *
 * 图像分量：载荷 attachments 中的图像条目在投影前摘除（不进文本预算域，
 * 单列媒体分量由 `build_turn_input_with_media` 随消息携带）；无图像 =
 * 文本输出与旧版逐字段一致。
 */
export async function build_turn_input(
  task: string,
  payload: Record<string, unknown>,
  blocks: readonly AuthorizedBlock[] | undefined,
  opts: WhiteboardAssemblyOptions = {},
): Promise<string> {
  const projected = project_payload_text(split_turn_payload(payload).text_payload);
  const sessionText =
    typeof opts.session_context === 'string' && opts.session_context !== ''
      ? opts.session_context
      : '';
  if (task === '' && !blocks?.length && sessionText === '') return projected;

  let whiteboardText = '';
  if (blocks && blocks.length > 0) {
    const blockResult = build_block_sources(blocks, projected, opts.context_window);
    const mixed = await (opts.mixer ?? new ContextMixer()).mix(blockResult.sources, {
      total_chars: blockResult.budget_chars,
    });
    whiteboardText = mixed.text;
  }

  const parts: string[] = [];
  if (sessionText !== '') parts.push(`## 会话记忆\n${sessionText}`);
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
  /** 调用点显式声明的媒体分量（W8A 透传的 request 附件注入面；不进文本预算域）。 */
  images?: readonly TurnImageComponent[] | null;
  /** 会话记忆摘要切片（宿主 history 摘要，宿主已裁剪预算；以标注段拼进输入，
   *  缺省 = 零漂移）。 */
  session_context?: string | null;
}

/**
 * 回合输入装配（文本 + 图像分量分离返回——「随消息走」的单一调用面）。
 *
 * run_loop（W8A 接线）以本形态替换 build_turn_input 调用：text 落
 * ScopeTurnContext.input（既有文本通道，逐字段与 build_turn_input 一致），
 * images 经 turn_image_to_attachment 投影随 state.attachments 进 llm_decider
 * 消息构造（引擎既有附件通道）。
 */
export async function build_turn_input_with_media(
  task: string,
  payload: Record<string, unknown>,
  blocks: readonly AuthorizedBlock[] | undefined,
  opts: WhiteboardAssemblyOptions = {},
): Promise<{ text: string; images: TurnImageComponent[] }> {
  const { text_payload, images } = split_turn_payload(payload);
  const text = await build_turn_input(task, text_payload, blocks, opts);
  return { text, images: [...images, ...(opts.images ?? [])] };
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
