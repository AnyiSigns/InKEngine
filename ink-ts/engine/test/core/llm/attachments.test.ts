/** 附件多模态消息单测——对标 pytest test_llm_attachments.py 的纯数据形态部分。
 *
 *  Python 端 TestAttachmentEventCategory 依赖 EventTypeRegistry（宿主事件注册，
 *  非 LLM 数据形态），按规则视为 host-coupled 延后，不在此处复刻。
 */

import { describe, expect, it } from 'vitest';

import { LLMConfigError } from '../../../src/core/llm/errors.js';
import {
  Attachment,
  Message,
  ToolCall,
  assistant,
  system,
  tool_result,
  user,
} from '../../../src/core/llm/messages.js';

describe('Attachment（默认值/校验/序列化）', () => {
  it('defaults are complete（kind=image，其余 None）', () => {
    const att = new Attachment({ kind: 'image', url: 'https://x/a.png' });
    expect(att.kind).toBe('image');
    expect(att.url).toBe('https://x/a.png');
    expect(att.path).toBeNull();
    expect(att.mime_type).toBeNull();
    expect(att.alt).toBeNull();
    expect(att.width).toBeNull();
    expect(att.height).toBeNull();
    expect(att.duration).toBeNull();
    expect(att.name).toBeNull();
  });

  it('kind validated（非法附件类型抛错）', () => {
    expect(() => new Attachment({ kind: 'audio', url: 'u' })).toThrow(LLMConfigError);
    for (const k of ['image', 'video', 'document']) {
      expect(() => new Attachment({ kind: k, url: 'u' })).not.toThrow();
    }
  });

  it('ref requires url or path（引用缺失抛错）', () => {
    expect(() => new Attachment({ kind: 'image' })).toThrow(LLMConfigError);
  });

  it('ref prefers url, falls back to path', () => {
    expect(new Attachment({ kind: 'image', url: 'u', path: 'p' }).ref).toBe('u');
    expect(new Attachment({ kind: 'video', path: 'p' }).ref).toBe('p');
  });

  it('to_openai_segment shapes（image/video/document 各自收敛形态）', () => {
    expect(new Attachment({ kind: 'image', url: 'https://x/a.png' }).to_openai_segment()).toEqual({
      type: 'image_url',
      image_url: { url: 'https://x/a.png' },
    });
    expect(new Attachment({ kind: 'video', path: 'v.mp4' }).to_openai_segment()).toEqual({
      type: 'video_url',
      video_url: { url: 'v.mp4' },
    });
    expect(new Attachment({ kind: 'document', url: 'doc.pdf' }).to_openai_segment()).toEqual({
      type: 'document_url',
      document_url: { url: 'doc.pdf' },
    });
  });

  it('to_dict/from_dict round trip', () => {
    const att = new Attachment({
      kind: 'video',
      url: 'https://x/v.mp4',
      mime_type: 'video/mp4',
      alt: '演示视频',
      duration: 3.5,
      name: 'demo.mp4',
      width: 1920,
      height: 1080,
    });
    const restored = Attachment.from_dict(att.to_dict());
    expect(restored.kind).toBe(att.kind);
    expect(restored.url).toBe(att.url);
    expect(restored.mime_type).toBe(att.mime_type);
    expect(restored.alt).toBe(att.alt);
    expect(restored.duration).toBe(att.duration);
    expect(restored.name).toBe(att.name);
    expect(restored.width).toBe(att.width);
    expect(restored.height).toBe(att.height);
  });
});

describe('Message 多模态附件', () => {
  it('user message serializes multimodal content array', () => {
    const msg = user('描述这张图', {
      attachments: [
        new Attachment({ kind: 'image', url: 'https://x/a.png', alt: '示意图' }),
        new Attachment({ kind: 'video', path: 'v.mp4' }),
      ],
    });
    expect(msg.to_openai_dict()).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '描述这张图' },
        { type: 'image_url', image_url: { url: 'https://x/a.png' } },
        { type: 'video_url', video_url: { url: 'v.mp4' } },
      ],
    });
  });

  it('content empty omits text segment', () => {
    const msg = user('', { attachments: [new Attachment({ kind: 'image', url: 'u' })] });
    expect(msg.to_openai_dict()).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'u' } }],
    });
  });

  it('attachments only on user role（非 user 角色附件被忽略）', () => {
    const m = new Message('assistant', 'ok', null, null, null, null, [
      new Attachment({ kind: 'image', url: 'u' }),
    ]);
    expect(m.to_openai_dict()).toEqual({ role: 'assistant', content: 'ok' });
    const m2 = new Message('system', 's', null, null, null, null, [
      new Attachment({ kind: 'image', url: 'u' }),
    ]);
    expect(m2.to_openai_dict()).toEqual({ role: 'system', content: 's' });
  });

  it('no attachments byte-identical output（四角色输出形态与既往一致）', () => {
    expect(user('u').to_openai_dict()).toEqual({ role: 'user', content: 'u' });
    expect(system('s').to_openai_dict()).toEqual({ role: 'system', content: 's' });
    expect(assistant('a').to_openai_dict()).toEqual({ role: 'assistant', content: 'a' });
    expect(tool_result('r', 'c1').to_openai_dict()).toEqual({
      role: 'tool',
      content: 'r',
      tool_call_id: 'c1',
    });
    const m = assistant('', {
      tool_calls: [
        new ToolCall({ id: 'call_1', name: 'get_weather', arguments: '{"city": "北京"}' }),
      ],
    });
    expect(m.to_openai_dict()).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city": "北京"}' },
        },
      ],
    });
  });

  it('to_dict/from_dict preserves attachments', () => {
    const msg = user('看图', {
      attachments: [
        new Attachment({ kind: 'image', url: 'https://x/a.png' }),
        new Attachment({ kind: 'document', path: 'doc.pdf', name: 'doc.pdf' }),
      ],
    });
    const restored = Message.from_dict(msg.to_dict());
    expect(restored.to_openai_dict()).toEqual(msg.to_openai_dict());
  });

  it('positional construction compat（位置参数形态不受新字段影响）', () => {
    const m = new Message('user', 'hi', null, null, null, null);
    expect(m.role).toBe('user');
    expect(m.content).toBe('hi');
    expect(m.attachments.length).toBe(0);
    const m2 = new Message('user', 'hi', null, null, null, null, [
      new Attachment({ kind: 'image', url: 'u' }),
    ]);
    expect(m2.attachments[0]!.kind).toBe('image');
  });

  it('attachment sequence normalized to immutable array', () => {
    const m = user('u', { attachments: [new Attachment({ kind: 'image', url: 'u' })] });
    expect(Array.isArray(m.attachments)).toBe(true);
    expect(m.attachments.length).toBe(1);
  });
});