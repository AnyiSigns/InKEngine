/**
 * llm 多模态消息构造与模型档案模态门禁测试（W8B：图像分量 → 厂商消息 parts）。
 *
 * 测什么：
 * - image_input_supported：档案（LLMConfig.extra 透传键）声明形态四分——
 *   modalities 字符串数组 / {input:[...]} / multimodal 三态；未声明 = false
 *   （fail-closed 判定面）；
 * - OpenAI 兼容 build_payload：支持图像模型 → user 消息展开 text +
 *   image_url（data URL）多模态 parts；不支持两模型携图 → LLMConfigError
 *   显式报错（不静默降级）；纯文本消息不受门禁影响（零漂移）；
 * - Anthropic build_anthropic_payload：data URL 附件 → image/base64 source
 *   块（media_type 取附件声明或 data URL 头）；http url → url source；携图且
 *   档案未声明 → 显式拒绝；无附件请求消息形态逐字段不变（零漂移）；
 * - Responses to_input_items：图像 → input_image 段；非图像沿用既有段形态。
 */
import { describe, expect, it } from 'vitest';

import { LLMConfig } from '../../../src/dock/ports/llm.js';
import { Attachment, user } from '../../../src/model/llm/messages.js';
import { LLMConfigError } from '../../../src/model/llm/errors.js';
import {
  anthropic_image_source,
  assert_images_supported,
  count_image_attachments,
  image_input_supported,
  parse_image_data_url,
} from '../../../src/adapters/llm/image_gate.js';
import { build_payload } from '../../../src/adapters/llm/compat_payload.js';
import { build_anthropic_payload } from '../../../src/adapters/llm/anthropic_payload.js';
import { to_input_items } from '../../../src/adapters/llm/_responses_payload.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

function config(extra: Record<string, unknown> | null, modelId = 'bai/qwen3.8-flash'): LLMConfig {
  return new LLMConfig({
    adapter: 'openai_compatible',
    model_id: modelId,
    base_url: 'https://example.com/v1',
    api_key: 'sk-test',
    extra,
  });
}

function imageMessage(text = '看看这张图'): ReturnType<typeof user> {
  return user(text, { attachments: [new Attachment({ kind: 'image', url: PNG_URL, mime_type: 'image/png', name: 'shot.png' })] });
}

describe('模型档案 modalities 门禁判定', () => {
  it('声明支持图像输入的四形态（image 数组/input 对象/vision 别名/multimodal 三态）', () => {
    expect(image_input_supported(config({ modalities: ['text', 'image'] }))).toBe(true);
    expect(image_input_supported(config({ modalities: { input: ['text', 'image'] } }))).toBe(true);
    expect(image_input_supported(config({ modalities: ['vision'] }))).toBe(true);
    expect(image_input_supported(config({ multimodal: true }))).toBe(true);
    expect(image_input_supported(config({ multimodal: 'true' }))).toBe(true);
  });

  it('未声明/仅文本 = 不支持（fail-closed 判定；extra 其他键不干扰）', () => {
    expect(image_input_supported(config(null))).toBe(false);
    expect(image_input_supported(config({ reasoning_style: 'effort' }))).toBe(false);
    expect(image_input_supported(config({ modalities: ['text'] }))).toBe(false);
    expect(image_input_supported(config({ multimodal: 'unknown' }))).toBe(false);
  });

  it('from_dict 档案透传：模型条目 modalities 键收进 extra 即为门禁可读形态', () => {
    const cfg = LLMConfig.from_dict({
      adapter: 'openai_compatible',
      model_id: 'bai/qwen3.8-flash',
      base_url: 'https://example.com/v1',
      modalities: ['text', 'image'],
    });
    expect(image_input_supported(cfg)).toBe(true);
  });

  it('门禁消息计数：只数图像附件（document/video 携文本注记不触发）', () => {
    expect(count_image_attachments([user('纯文本')])).toBe(0);
    expect(count_image_attachments([imageMessage()])).toBe(1);
    const docOnly = user('文档', { attachments: [new Attachment({ kind: 'document', url: 'file.pdf' })] });
    expect(count_image_attachments([docOnly])).toBe(0);
  });
});

describe('OpenAI 兼容消息构造：多模态 parts + fail-closed', () => {
  it('支持图像模型：user 消息展开 text + image_url（data URL）内容段数组', () => {
    const payload = build_payload(
      config({ modalities: ['text', 'image'] }),
      [imageMessage()],
      null,
      null,
      false,
    );
    const messages = payload['messages'] as Record<string, unknown>[];
    const content = messages[0]!['content'];
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Record<string, unknown>[];
    expect(parts[0]).toEqual({ type: 'text', text: '看看这张图' });
    expect(parts[1]!['type']).toBe('image_url');
    expect((parts[1]!['image_url'] as Record<string, unknown>)['url']).toBe(PNG_URL);
  });

  it('不支持图像的两类档案（未声明/仅文本）携图 = LLMConfigError 显式拒绝', () => {
    expect(() => build_payload(config(null), [imageMessage()], null, null, false)).toThrow(LLMConfigError);
    expect(() => build_payload(config(null), [imageMessage()], null, null, false)).toThrow(/显式拒绝/);
    expect(() => build_payload(config({ modalities: ['text'] }), [imageMessage()], null, null, true)).toThrow(/模态/);
  });

  it('纯文本零漂移：不支持图像的档案发文本消息照旧（content 为字符串单字段）', () => {
    const payload = build_payload(config(null), [user('你好')], null, null, false);
    const messages = payload['messages'] as Record<string, unknown>[];
    expect(messages[0]).toEqual({ role: 'user', content: '你好' });
  });
});

describe('Anthropic 消息构造：image source 块 + fail-closed', () => {
  it('data URL 附件 → image/base64 source（media_type 头推导）；http 引用 → url source', () => {
    const payload = build_anthropic_payload(
      config({ modalities: ['text', 'image'] }, 'claude-sonnet'),
      [imageMessage()],
      null,
      null,
      false,
    );
    const messages = payload['messages'] as Record<string, unknown>[];
    const blocks = messages[0]!['content'] as Record<string, unknown>[];
    expect(blocks[0]).toEqual({ type: 'text', text: '看看这张图' });
    expect(blocks[1]!['type']).toBe('image');
    expect(blocks[1]!['source']).toEqual({ type: 'base64', media_type: 'image/png', data: PNG_B64 });
    const remote = user('线上图', { attachments: [new Attachment({ kind: 'image', url: 'https://example.com/a.png' })] });
    const remotePayload = build_anthropic_payload(config({ multimodal: true }, 'claude-sonnet'), [remote], null, null, false);
    const remoteBlocks = (remotePayload['messages'] as Record<string, unknown>[]) [0]!['content'] as Record<string, unknown>[];
    expect(remoteBlocks[0]).toEqual({ type: 'text', text: '线上图' });
    expect(remoteBlocks[1]!['source']).toEqual({ type: 'url', url: 'https://example.com/a.png' });
  });

  it('档案未声明图像输入的携图请求显式报错；无附件请求逐字段与旧行为一致', () => {
    expect(() => build_anthropic_payload(config(null), [imageMessage()], null, null, false)).toThrow(LLMConfigError);
    const plain = build_anthropic_payload(config(null), [user('无附件')], null, null, false);
    const messages = plain['messages'] as Record<string, unknown>[];
    expect(messages[0]!['content']).toEqual([{ type: 'text', text: '无附件' }]);
  });

  it('anthropic_image_source：非 base64 data URL 显式拒绝（无静默降级）', () => {
    expect(() =>
      anthropic_image_source(new Attachment({ kind: 'image', url: 'data:image/png;charset=utf8,plain' })),
    ).toThrow(LLMConfigError);
    expect(parse_image_data_url('data:image/svg+xml;base64,AAAA')).toEqual({ media_type: 'image/svg+xml', data: 'AAAA' });
    expect(parse_image_data_url('data:text/plain;base64,AAAA')).toBeNull();
  });
});

describe('Responses 协议消息构造：input_image 段', () => {
  it('图像附件展开为 input_image 段（image_url 字符串形态）；文本先行', () => {
    const items = to_input_items([imageMessage()]);
    const content = items[0]!['content'] as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: 'input_text', text: '看看这张图' });
    expect(content[1]).toEqual({ type: 'input_image', image_url: PNG_URL });
  });

  it('非图像附件沿用既有段形态；门禁在适配器装配面生效', () => {
    const doc = user('文档', { attachments: [new Attachment({ kind: 'document', url: 'https://e/x.pdf' })] });
    const items = to_input_items([doc]);
    const content = items[0]!['content'] as Record<string, unknown>[];
    expect(content[1]!['type']).toBe('document_url');
    expect(() => assert_images_supported(config(null), [imageMessage()])).toThrow(/不静默丢弃/);
    expect(() => assert_images_supported(config({ modalities: ['image'] }), [imageMessage()])).not.toThrow();
  });
});
