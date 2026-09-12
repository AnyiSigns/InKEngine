/**
 * scope_turn 图像分量装配测试（W8B：文本+图像列表的装配源形态）。
 *
 * 测什么：
 * - 零漂移：无附件/无图像时 build_turn_input 与旧行为逐字段一致（纯文本输入
 *   不受媒体分量逻辑影响）；
 * - 图像不进文本预算域：载荷 attachments 中的图像条目在文本投影前摘除——
 *   base64/data URL 不出现在 input 文本；document/video 条目保留既有文本
 *   投影语义；
 * - build_turn_input_with_media：text 与 build_turn_input 一致，images =
 *   载荷图像 + 调用点声明（opts.images）合并单列；
 * - 交棒投影：turn_image_ref 三引用归一（url > data 合成 data URL > path）、
 *   turn_image_to_attachment 落引擎 Attachment 数据面（kind=image + url +
 *   mime 回落推导）。
 */
import { describe, expect, it } from 'vitest';

import {
  build_turn_input,
  build_turn_input_with_media,
  collect_turn_images,
  split_turn_payload,
  turn_image_ref,
  turn_image_to_attachment,
} from '../../../src/loop/execution_runtime/scope_turn.js';
import type { TurnImageComponent } from '../../../src/loop/execution_runtime/scope_turn.js';

const BASE64 = 'iVBORw0KGgoAAAANSUhEUg==';

function imageDict(url: string | null = `data:image/png;base64,${BASE64}`): Record<string, unknown> {
  return url === null
    ? { kind: 'image', url: null, path: null, name: 'x.png' }
    : { kind: 'image', url, path: null, mime_type: 'image/png', name: 'x.png' };
}

describe('零漂移：无图像附件时与旧版逐字段一致', () => {
  it('纯文本载荷（无 attachments 键）投影不变', async () => {
    expect(await build_turn_input('做一件事', { note: '备注' }, undefined)).toBe('做一件事\nnote: 备注');
  });

  it('attachments 仅含非图像条目时文本投影保留原样（document 引用在场）', async () => {
    const payload = { attachments: [{ kind: 'document', url: null, path: 'docs/a.pdf', name: 'a.pdf' }] };
    const input = await build_turn_input('', payload, undefined);
    expect(input).toContain('a.pdf');
    expect(input).toContain('document');
  });

  it('attachments 键非数组 = 原样文本投影（宽松输入不击穿）', async () => {
    const input = await build_turn_input('', { attachments: 'oops' }, undefined);
    expect(input).toContain('attachments: oops');
  });
});

describe('图像分量进 turn 输入装配（不进文本预算域）', () => {
  it('载荷图像条目不进 input 文本：base64 与 attachments 回声缺席、task 文本在场', async () => {
    const payload = { task: '看图说话', attachments: [imageDict()] };
    const input = await build_turn_input('', payload, undefined);
    expect(input).toContain('看图说话');
    expect(input).not.toContain(BASE64);
    expect(input).not.toContain('attachments');
  });

  it('split_turn_payload 拆文本域与图像列表；无图像 = text_payload 直通', () => {
    const split = split_turn_payload({ task: 't', attachments: [imageDict(), { kind: 'document', url: 'x', path: 'p' }] });
    expect(split.images).toHaveLength(1);
    expect(split.images[0]!.type).toBe('image');
    expect(JSON.stringify(split.text_payload['attachments'])).toContain('document');
    const plain = { task: 't' };
    const none = split_turn_payload(plain);
    expect(none.images).toEqual([]);
    expect(none.text_payload).toBe(plain);
  });

  it('collect_turn_images：非法图像形态（无任何引用）留在文本域、不谎报媒体', () => {
    const payload = { attachments: [{ kind: 'image', url: null, path: null, data: null }, { kind: 'image', data: BASE64, media_type: 'image/png' }] };
    const images = collect_turn_images(payload);
    expect(images).toHaveLength(1);
    expect(images[0]!.data).toBe(BASE64);
    expect(split_turn_payload(payload).text_payload['attachments']).toHaveLength(1);
  });

  it('build_turn_input_with_media：text 与 build_turn_input 一致，images 合并调用点声明', async () => {
    const payload = { task: '看这张图', attachments: [imageDict()] };
    const extra: TurnImageComponent = { type: 'image', url: 'https://example.com/a.png', media_type: 'image/png' };
    const assembled = await build_turn_input_with_media('看这张图', payload, undefined, { images: [extra] });
    const textOnly = await build_turn_input('看这张图', payload, undefined);
    expect(assembled.text).toBe(textOnly);
    expect(assembled.text).toContain('看这张图');
    expect(assembled.text).not.toContain(BASE64);
    expect(assembled.images).toHaveLength(2);
    expect(assembled.images[1]).toBe(extra);
  });

  it('有白板块时媒体单列同样不进装配文本（预算域零污染）', async () => {
    const blocks = [{ kind: 'task' as const, owner: 'main', content: '分析季度数据', seq: 0 }];
    const withImages = await build_turn_input_with_media('任务', { attachments: [imageDict()] }, blocks);
    const withoutImages = await build_turn_input_with_media('任务', {}, blocks);
    expect(withImages.text).toBe(withoutImages.text);
    expect(withoutImages.text).toContain('分析季度数据');
    expect(withImages.images).toHaveLength(1);
  });
});

describe('交棒投影：图像分量 → 引擎 Attachment 数据面（随消息走）', () => {
  it('turn_image_ref：url 优先；裸 base64 按 media_type 合成 data URL（缺省 image/png）', () => {
    expect(turn_image_ref({ type: 'image', url: 'https://a/b.png', data: 'AAA' })).toBe('https://a/b.png');
    expect(turn_image_ref({ type: 'image', data: BASE64, media_type: 'image/jpeg' })).toBe(`data:image/jpeg;base64,${BASE64}`);
    expect(turn_image_ref({ type: 'image', data: BASE64 })).toBe(`data:image/png;base64,${BASE64}`);
    expect(turn_image_ref({ type: 'image', data: `data:image/gif;base64,R0lGOD` })).toBe('data:image/gif;base64,R0lGOD');
    expect(turn_image_ref({ type: 'image', path: 'shots/desktop.png' })).toBe('shots/desktop.png');
  });

  it('turn_image_to_attachment：kind=image + url 引用 + mime 回落 data URL 头推导', () => {
    const att = turn_image_to_attachment({ type: 'image', data: BASE64 });
    expect(att['kind']).toBe('image');
    expect(att['url']).toBe(`data:image/png;base64,${BASE64}`);
    expect(att['mime_type']).toBe('image/png');
    const withMime = turn_image_to_attachment({ type: 'image', url: `data:image/webp;base64,AAAA`, media_type: 'image/webp', name: 'a.webp' });
    expect(withMime['mime_type']).toBe('image/webp');
    expect(withMime['name']).toBe('a.webp');
  });
});
