/**
 * 模型档案多模态图像门禁 + 图像附件 → 厂商消息段构造（W8B 多模态链路）。
 *
 * 门禁语义（fail-closed，不静默降级）：待发消息携带图像附件时，模型档案
 * 必须声明图像输入模态（LLMConfig.extra 透传键，装配侧从模型条目原样带入）：
 *   - `modalities: ['text','image']`（字符串数组）或 `{input: [...,'image']}`
 *   - `multimodal: true`（壳侧档案三态的透传兼容；'true' 字符串同真）
 * 未声明/声明不含图像 = 携图请求显式抛 LLMConfigError——纯文本请求永不受
 * 此门禁影响（零漂移）。
 *
 * 图像段构造共享原语：data URL → base64 {media_type,data} 解析（Anthropic
 * source 形态）与 attachment → 引用值收敛，供各厂商 payload 模块复用；
 * openai chat 段形态由 Message.to_openai_dict 既有展开承接，本模块只补
 * responses/anthropic 两协议缺口。
 */

import { LLMConfigError } from '../../model/llm/errors.js';
import type { LLMConfig } from '../../dock/ports/llm.js';
import type { Attachment, Message } from '../../model/llm/messages.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 档案模态声明是否含图像输入（未声明 = false，fail-closed 判定在调用面）。 */
export function image_input_supported(config: LLMConfig): boolean {
  const extra = config.extra;
  if (!isRecord(extra)) return false;
  const modalities = extra['modalities'];
  if (Array.isArray(modalities)) {
    return modalities.some((m) => m === 'image' || m === 'vision');
  }
  if (isRecord(modalities)) {
    const input = modalities['input'];
    if (Array.isArray(input) && input.some((m) => m === 'image' || m === 'vision')) return true;
    if (modalities['image_input'] === true) return true;
  }
  const multimodal = extra['multimodal'];
  return multimodal === true || multimodal === 'true';
}

/** 消息链携带的图像附件条数（fail-closed 门禁的触发计数）。 */
export function count_image_attachments(messages: readonly Message[]): number {
  let count = 0;
  for (const m of messages) {
    for (const a of m.attachments) {
      if (a.kind === 'image') count += 1;
    }
  }
  return count;
}

/**
 * 图像附件按模型档案门禁放行/显式拒绝（各适配器 payload 装配统一 choke point）。
 *
 * 无图像 = 直通（纯文本零漂移）；有图像且档案声明支持 = 直通（消息已由
 * 厂商 payload 构造展开多模态段）；有图像且档案未声明 = LLMConfigError
 * 显式报错并计数（不静默丢弃附件、不降级为文本引用）。
 */
export function assert_images_supported(
  config: LLMConfig,
  messages: readonly Message[],
): void {
  const count = count_image_attachments(messages);
  if (count === 0) return;
  if (image_input_supported(config)) return;
  throw new LLMConfigError(
    `模型 ${JSON.stringify(config.model_id)} 档案未声明图像输入模态（modalities 不含 image），` +
      `本回合携带 ${count} 个图像附件，显式拒绝发送（不静默丢弃、不降级文本引用）：` +
      '请改用声明多模态图像输入的模型档案，或移除图像附件',
  );
}

/** data URL 解析结果（base64 形态 = media_type + data；charset 段忽略）。 */
export interface ParsedImageDataUrl {
  media_type: string;
  data: string;
}

/** data: URL → {media_type,data}（非 base64 图像 data URL = null，调用方显式拒绝）。 */
export function parse_image_data_url(url: string): ParsedImageDataUrl | null {
  const match = /^data:([^;,]+)((?:;[^;,]*)*),([0-9A-Za-z+/=]*)$/.exec(url);
  if (match === null) return null;
  const mime = match[1] ?? '';
  const params = match[2] ?? '';
  const data = match[3] ?? '';
  if (!/;base64/i.test(params)) return null;
  if (!/^image\//i.test(mime)) return null;
  return { media_type: mime, data: data.replace(/\s+/g, '') };
}

/** 图像附件的 Anthropic image source 形态（data URL 解 base64；否则 url 引用）。 */
export function anthropic_image_source(
  attachment: Attachment,
): Record<string, string> {
  const ref = attachment.ref;
  if (ref.startsWith('data:')) {
    const parsed = parse_image_data_url(ref);
    if (parsed === null) {
      throw new LLMConfigError(
        `图像附件 data URL 无法解析为 base64 源（Anthropic 要求 image/jpeg|png|gif|webp 的 base64 data URL）: ${JSON.stringify(
          attachment.name ?? ref.slice(0, 48),
        )}`,
      );
    }
    return {
      type: 'base64',
      media_type: attachment.mime_type ?? parsed.media_type,
      data: parsed.data,
    };
  }
  if (ref === '') {
    throw new LLMConfigError('图像附件引用缺失（url/path 均为空），无法构造消息图像段');
  }
  return { type: 'url', url: ref };
}
