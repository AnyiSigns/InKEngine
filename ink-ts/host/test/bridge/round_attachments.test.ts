/**
 * rounds 附件载荷归一与文档文本注入（round_attachments 纯逻辑对标）。
 */

import { describe, expect, it } from 'vitest';

import { normalizeAttachment, prepareRoundInput } from '../../src/bridge/round_attachments.js';
import type { DocParser } from '../../src/doc/_types.js';

function stubParser(result: 'ok' | 'fail', opts: { truncated?: boolean; text?: string; code?: string } = {}): DocParser {
  return {
    async parseDocument(path, root, _maxChars) {
      expect(path).toBe('/attach/a.pdf');
      expect(root).toBe('/attach');
      if (result === 'fail') {
        return { ok: false as const, code: opts.code ?? 'format', message: 'bad pdf' };
      }
      return {
        ok: true as const,
        format: 'pdf',
        text: opts.text ?? '文档正文内容',
        page_count: 1,
        truncated: opts.truncated ?? false,
      };
    },
  };
}

describe('normalizeAttachment', () => {
  it('非法形态（未知 kind/无引用）返回 null', () => {
    expect(normalizeAttachment(null)).toBeNull();
    expect(normalizeAttachment({ kind: 'audio' })).toBeNull();
    expect(normalizeAttachment({ kind: 'image' })).toBeNull();
    expect(normalizeAttachment('x')).toBeNull();
  });

  it('归一 url/path/mime 到引擎数据面键名', () => {
    const got = normalizeAttachment({ kind: 'document', url: 'u', path: 'p', name: 'n', mime: 'application/pdf' });
    expect(got).toEqual({ kind: 'document', url: 'u', path: 'p', mime_type: 'application/pdf', name: 'n' });
    const got2 = normalizeAttachment({ kind: 'image', url: 'data:image/png;base64,x' });
    expect(got2?.path).toBeNull();
    expect(got2?.mime_type).toBeNull();
  });
});

describe('prepareRoundInput', () => {
  it('无附件 = 原样透传', async () => {
    const out = await prepareRoundInput('你好', undefined, {});
    expect(out.input).toBe('你好');
    expect(out.attachments).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('image/video 直发不解析；document 解析成功注入文本并保留载荷', async () => {
    const out = await prepareRoundInput('问题', [
      { kind: 'image', url: 'data:image/png;base64,abc', name: 'pic.png' },
      { kind: 'document', url: '/attach/a.pdf', path: '/attach/a.pdf', name: 'a.pdf', mime: 'application/pdf' },
    ], { docParse: stubParser('ok'), attachmentDir: '/attach', docTextCap: 1000 });
    expect(out.attachments.length).toBe(2);
    expect(out.input).toContain('[文档附件 a.pdf]');
    expect(out.input).toContain('文档正文内容');
    expect(out.warnings).toEqual([]);
  });

  it('解析失败 = 文件名引用 + 可见告警', async () => {
    const out = await prepareRoundInput('问题', [
      { kind: 'document', url: '/attach/a.pdf', path: '/attach/a.pdf', name: 'a.pdf' },
    ], { docParse: stubParser('fail', { code: 'format' }), attachmentDir: '/attach' });
    expect(out.input).toContain('[附件 a.pdf：文档内容解析失败，仅附文件名引用]');
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toContain('解析失败');
  });

  it('解析文本超上限记截断告警', async () => {
    const out = await prepareRoundInput('问题', [
      { kind: 'document', path: '/attach/a.pdf', name: 'a.pdf' },
    ], { docParse: stubParser('ok', { truncated: true }), attachmentDir: '/attach' });
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toContain('已截断');
  });

  it('无解析执行体 = 跳过解析（文档不注入）', async () => {
    const out = await prepareRoundInput('问题', [
      { kind: 'document', path: '/attach/a.pdf', name: 'a.pdf' },
    ], { attachmentDir: '/attach' });
    expect(out.input).toBe('问题');
    expect(out.attachments.length).toBe(1);
  });

  it('非法附件项记告警并忽略', async () => {
    const out = await prepareRoundInput('问题', [{ kind: 'garbage' }], {});
    expect(out.attachments.length).toBe(0);
    expect(out.warnings.length).toBe(1);
  });
});
