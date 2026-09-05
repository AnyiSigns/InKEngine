/**
 * 媒体白名单策略测试：类型白名单 / 大小上限 / 路径白名单 / URL 协议。
 */

import {
  classifyMediaAsset,
  formatByteSize,
  isMediaRenderAllowed,
  isSafeMediaUrl,
  MEDIA_SIZE_LIMITS,
} from '@/shared/media/mediaPolicy';

describe('类型白名单分发', () => {
  it('图片/视频/文档按 MIME 与扩展名归类', () => {
    expect(classifyMediaAsset({ name: 'a.png', mime: 'image/png' })).toEqual({ ok: true, kind: 'image' });
    expect(classifyMediaAsset({ name: 'clip.mp4', mime: 'video/mp4' })).toEqual({ ok: true, kind: 'video' });
    expect(classifyMediaAsset({ name: 'note.md', mime: '' })).toEqual({ ok: true, kind: 'document' });
  });

  it('白名单外类型拒绝（带理由）', () => {
    const verdict = classifyMediaAsset({ name: 'rootkit.exe', mime: 'application/x-msdownload' });
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining('不支持的文件类型') });
  });
});

describe('大小上限', () => {
  it('超限拒绝（图片 8MB / 视频 100MB）', () => {
    const overImage = classifyMediaAsset({ name: 'huge.png', mime: 'image/png', size: MEDIA_SIZE_LIMITS.image + 1 });
    expect(overImage.ok).toBe(false);
    const overVideo = classifyMediaAsset({ name: 'huge.mp4', mime: 'video/mp4', size: MEDIA_SIZE_LIMITS.video + 1 });
    expect(overVideo.ok).toBe(false);
    const ok = classifyMediaAsset({ name: 'big.png', mime: 'image/png', size: MEDIA_SIZE_LIMITS.image });
    expect(ok).toEqual({ ok: true, kind: 'image' });
  });
});

describe('路径白名单', () => {
  it('白名单前缀内放行，越权拒绝', () => {
    const inRange = classifyMediaAsset({ name: 'clip.mp4', mime: 'video/mp4', path: '~/inkling/attachments/clip.mp4' });
    expect(inRange).toEqual({ ok: true, kind: 'video' });
    const outOfRange = classifyMediaAsset({ name: 'clip.mp4', mime: 'video/mp4', path: 'C:\\Windows\\System32\\clip.mp4' });
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange).toMatchObject({ ok: false, reason: expect.stringContaining('路径越权') });
  });

  it('注入自定义白名单前缀', () => {
    const custom = ['/data/attachments'];
    const allowed = classifyMediaAsset({ name: 'v.mp4', mime: 'video/mp4', path: '/data/attachments/v.mp4' }, { pathAllowlist: custom });
    expect(allowed.ok).toBe(true);
    const denied = classifyMediaAsset({ name: 'v.mp4', mime: 'video/mp4', path: '~/inkling/attachments/v.mp4' }, { pathAllowlist: custom });
    expect(denied.ok).toBe(false);
  });
});

describe('媒体 URL 协议（渲染二次防线）', () => {
  it('http(s) 放行；javascript:/data: 拒绝；本地路径须白名单', () => {
    expect(isSafeMediaUrl('https://cdn.example.org/a.mp4')).toBe(true);
    expect(isSafeMediaUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeMediaUrl('data:text/html;base64,x')).toBe(false);
    expect(isSafeMediaUrl('~/inkling/attachments/a.mp4')).toBe(true);
    expect(isSafeMediaUrl('C:/Users/x/a.mp4')).toBe(false);
  });
});

describe('渲染放行与超限占位判定', () => {
  it('超限视频判定拒绝（渲染面不出现 <video>）', () => {
    const verdict = isMediaRenderAllowed({ mime: 'video/mp4', size: MEDIA_SIZE_LIMITS.video + 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringContaining('超限') });
  });

  it('未知媒体类型拒绝', () => {
    expect(isMediaRenderAllowed({ mime: '' })).toMatchObject({ ok: false });
  });

  it('大小摘要格式化', () => {
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(2048)).toBe('2 KB');
    expect(formatByteSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
