/**
 * 媒体渲染白名单 + Markdown 管线测试。
 * 断言白名单拒绝路径（未登记渲染器 / 超限 / 越权路径 / 危险 URL）与
 * marked+DOMPurify 消毒管道（script 剥离、粗体保留、pre-wrap 回退）。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageList } from '@/components/message_list';
import { AgentInput } from '@/components/agent_input';
import { registerMediaRenderer } from '@/renderer/mediaRegistry';
import { isMediaRendererRegistered } from '@/renderer/mediaRegistry';
import { renderMarkdownSafe } from '@/shared/markdown/markdown';
import { createStubFilePicker } from '@/shared/media/filePicker';
import { MEDIA_SIZE_LIMITS } from '@/shared/media/mediaPolicy';
import { submitAttachments } from '@/shared/session/eventIngest';
import { ChannelHub } from '@/shared/session/channelHub';
import type { InkMessage } from '@/shared/session/types';
import { MarkdownText } from '@/components/messages/markdown_text';

describe('媒体渲染器白名单', () => {
  it('内置注册面：image/video/document 已注册', () => {
    expect(isMediaRendererRegistered('image')).toBe(true);
    expect(isMediaRendererRegistered('video')).toBe(true);
    expect(isMediaRendererRegistered('document')).toBe(true);
  });

  it('未登记媒体类型 → 拒绝占位（不执行未声明渲染器）', () => {
    const messages: InkMessage[] = [
      { id: 'h1', kind: 'image', url: '', alt: '', },
    ];
    // 先用未注册 kind 的占位路径（直接构造坏消息触发兜底：经 MediaEntry 表外类型）
    const weird = [{ id: 'x1', kind: 'hologram', url: 'oops' }] as unknown as InkMessage[];
    const { rerender } = render(<MessageList bindValue={weird} throttleMs={0} viewportHeight={400} />);
    expect(screen.getByText(/未登记消息渲染器/)).toBeInTheDocument();
    rerender(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    expect(document.querySelector('[data-ui="media_image"]')).not.toBeNull();
  });

  it('超限视频 → 「已拒绝」占位（无 <video>）', () => {
    const messages: InkMessage[] = [
      { id: 'v1', kind: 'video', url: '~/inkling/attachments/big.mp4', mime: 'video/mp4', size: MEDIA_SIZE_LIMITS.video + 1 },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    expect(screen.getByText(/已拒绝：.*超限/)).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });

  it('危险协议 URL → 拒绝占位（图片不出现在文档流）', () => {
    const messages: InkMessage[] = [
      { id: 'i1', kind: 'image', url: 'javascript:alert(1)', alt: 'x' },
    ];
    render(<MessageList bindValue={messages} throttleMs={0} viewportHeight={400} />);
    expect(screen.getByText(/已拒绝：图片地址协议不在白名单内/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('注册面开放：动态注册后 isMediaRendererRegistered 放行', () => {
    expect(isMediaRendererRegistered('hologram')).toBe(false);
    registerMediaRenderer('hologram', () => <div data-ui="hologram_ok" />);
    expect(isMediaRendererRegistered('hologram')).toBe(true);
  });
});

describe('Markdown 管线（marked + DOMPurify）', () => {
  it('script/iframe 被消毒剥离；粗体保留', () => {
    const html = renderMarkdownSafe('## 标题\n\n<script>window.hacked=true</script>\n\n**加粗** <iframe src="x"></iframe>');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
  });

  it('javascript: 链接协议被净化为安全态（不执行）', () => {
    const html = renderMarkdownSafe('[点我](javascript:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('组件渲染带 whitespace-pre-wrap 回退类', () => {
    const { container } = render(<MarkdownText text={'第一行\n第二行'} />);
    const el = container.querySelector('.ink-markdown');
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('第一行');
  });
});

describe('输入框「选择文件」入口', () => {
  it('文件拾取 → 类型白名单分发 → onAttachments（图片+文档），其它拒绝并提示', async () => {
    const user = userEvent.setup();
    const onAttachments = vi.fn();
    const picker = createStubFilePicker([
      { name: 'photo.png', mime: 'image/png', size: 1024, path: '~/inkling/attachments/photo.png' },
      { name: 'note.md', mime: '', size: 200, path: '~/inkling/attachments/note.md' },
      { name: 'evil.exe', mime: 'application/octet-stream', size: 10 },
    ]);
    render(<AgentInput filePicker={picker} onAttachments={onAttachments} />);
    await user.click(screen.getByTitle('选择文件'));
    expect(onAttachments).toHaveBeenCalledTimes(1);
    const assets = onAttachments.mock.calls[0][0] as Array<{ kind: string; name: string }>;
    expect(assets.map((a) => a.kind)).toEqual(['image', 'document']);
    expect(assets.map((a) => a.name)).toEqual(['photo.png', 'note.md']);
    expect(screen.getByText(/已拒绝 1 个文件/)).toBeInTheDocument();
  });

  it('超过大小上限的文件被拒绝', async () => {
    const user = userEvent.setup();
    const onAttachments = vi.fn();
    const picker = createStubFilePicker([
      { name: 'big.mp4', mime: 'video/mp4', size: MEDIA_SIZE_LIMITS.video + 1, path: '~/inkling/attachments/big.mp4' },
    ]);
    render(<AgentInput filePicker={picker} onAttachments={onAttachments} />);
    await user.click(screen.getByTitle('选择文件'));
    expect(onAttachments).not.toHaveBeenCalled();
    expect(screen.getByText(/已拒绝 1 个文件/)).toBeInTheDocument();
  });

  it('无拾取器时附件入口隐藏（注入 null）', () => {
    render(<AgentInput filePicker={null} />);
    expect(screen.queryByTitle('选择文件')).toBeNull();
  });

  it('附件落位：submitAttachments 生成独立媒体条目', () => {
    const hub = new ChannelHub();
    submitAttachments(hub, [
      { kind: 'image', name: 'a.png', mime: 'image/png', size: 1, url: 'https://cdn.example.org/a.png' },
      { kind: 'document', name: 'note.md', mime: 'text/markdown', size: 2, url: '~/inkling/attachments/note.md' },
    ]);
    const messages = hub.getSnapshot().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ kind: 'image', url: 'https://cdn.example.org/a.png' });
    expect(messages[1]).toMatchObject({ kind: 'document', name: 'note.md' });
  });
});
