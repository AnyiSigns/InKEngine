/**
 * 附件理解闭环测试（前端管线 + 多模态联动 + 降级）。
 *
 * 组件测试不起真实后端：文件拾取器与发送回调均经 mock 注入；多模态能力
 * 经 models 档案 props 注入。断言面：
 *   · 选择文件 → 暂存预览 → 发送时消息载荷含引擎 Attachment 契约形态附件；
 *   · 多模态模型：附件随载荷直发；
 *   · 非多模态模型：附件降级为文本引用 + 界面提示需切多模态模型（断言点）；
 *   · 健壮性：空附件/非法路径拒绝并提示。
 */

import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AgentInput } from '@/components/agent_input';
import type { ModelProfile } from '@/components/agent_input';
import { createStubFilePicker } from '@/shared/media/filePicker';
import { MEDIA_SIZE_LIMITS } from '@/shared/media/mediaPolicy';
import type { AttachmentAsset } from '@/shared/session/eventIngest';

const MULTIMODAL: ModelProfile[] = [
  { id: 'mm', name: '多模态·专业', tier: 'main', occupancy: 0, limit: 10, multimodal: true },
  { id: 'plain', name: '文本·轻量', tier: 'main', occupancy: 0, limit: 10, multimodal: false },
];

describe('附件管线：选择 → 预览 → 载荷含附件 → 发送', () => {
  it('选择图片后经媒体策略分发暂存预览，发送时载荷携带引擎 Attachment 形态附件', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const picker = createStubFilePicker([
      { name: 'photo.png', mime: 'image/png', size: 1024, path: '~/inkling/attachments/photo.png' },
    ]);
    render(<AgentInput filePicker={picker} models={MULTIMODAL} selectedModel="mm" onSend={onSend} />);

    await user.click(screen.getByTitle('选择文件'));

    const preview = screen.getByText('photo.png');
    expect(preview).toBeInTheDocument();
    expect(screen.getByText(/已暂存 1 个文件/)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox'), '看这张图');
    await user.click(screen.getByTitle('发送'));

    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, attachments] = onSend.mock.calls[0] as [string, AttachmentAsset[]];
    expect(text).toBe('看这张图');
    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe('image');
    expect(attachments[0].url).toBe('~/inkling/attachments/photo.png');
    expect(attachments[0].name).toBe('photo.png');
  });

  it('粘贴图片进入暂存预览（不依赖文件选择入口）', () => {
    const onSend = vi.fn();
    render(<AgentInput models={MULTIMODAL} selectedModel="mm" onSend={onSend} />);
    const textarea = screen.getByRole('textbox');
    const file = new File([new Uint8Array([1, 2, 3])], 'pasted.png', { type: 'image/png' });
    fireEvent.paste(textarea, { clipboardData: { files: [file] } });
    expect(screen.getByText('pasted.png')).toBeInTheDocument();
  });
});

describe('多模态联动', () => {
  it('多模态模型：附件随消息载荷直发，不出现降级提示', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const picker = createStubFilePicker([
      { name: 'photo.png', mime: 'image/png', size: 1024, path: 'https://cdn.example.org/photo.png' },
    ]);
    render(<AgentInput filePicker={picker} models={MULTIMODAL} selectedModel="mm" onSend={onSend} />);

    await user.click(screen.getByTitle('选择文件'));
    await user.type(screen.getByRole('textbox'), '描述这张图');
    await user.click(screen.getByTitle('发送'));

    expect(screen.queryByTestId('attach_hint')).toBeNull();
    expect(screen.queryByText(/非多模态/)).toBeNull();
    const [, attachments] = onSend.mock.calls[0] as [string, AttachmentAsset[]];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe('image');
  });

  it('非多模态模型：附件降级为文本引用并提示需切多模态模型（断言点）', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const picker = createStubFilePicker([
      { name: 'photo.png', mime: 'image/png', size: 1024, path: 'https://cdn.example.org/photo.png' },
    ]);
    const { container } = render(<AgentInput filePicker={picker} models={MULTIMODAL} selectedModel="plain" onSend={onSend} />);

    await user.click(screen.getByTitle('选择文件'));
    await user.type(screen.getByRole('textbox'), '描述这张图');
    await user.click(screen.getByTitle('发送'));

    const hint = screen.getByText(/非多模态/);
    expect(hint).toBeInTheDocument();
    const hintEl = container.querySelector('[data-ui="attach_hint"]');
    expect(hintEl).not.toBeNull();
    expect(hintEl?.getAttribute('data-mode')).toBe('degraded');

    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, attachments] = onSend.mock.calls[0] as [string, AttachmentAsset[]];
    expect(attachments).toHaveLength(0);
    expect(text).toContain('[附件·image]');
    expect(text).toContain('https://cdn.example.org/photo.png');
  });

  it('非多模态模型降级提示仅在携带附件时出现，纯文本发送不提示', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<AgentInput models={MULTIMODAL} selectedModel="plain" onSend={onSend} />);
    await user.type(screen.getByRole('textbox'), '普通提问');
    await user.click(screen.getByTitle('发送'));
    expect(screen.queryByText(/非多模态/)).toBeNull();
    expect(onSend).toHaveBeenCalledWith('普通提问', []);
  });
});

describe('健壮性', () => {
  it('空内容且无附件时发送被抑制（不触发 onSend）', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<AgentInput models={MULTIMODAL} selectedModel="mm" onSend={onSend} />);
    await user.click(screen.getByTitle('发送'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('越权路径的文档被媒体策略拒绝并提示，不入载荷', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onAttachments = vi.fn();
    const picker = createStubFilePicker([
      { name: 'secret.pdf', mime: 'application/pdf', size: 1024, path: 'C:\\secret\\secret.pdf' },
    ]);
    render(<AgentInput filePicker={picker} models={MULTIMODAL} selectedModel="mm" onSend={onSend} onAttachments={onAttachments} />);

    await user.click(screen.getByTitle('选择文件'));

    expect(onAttachments).not.toHaveBeenCalled();
    expect(screen.getByText(/已拒绝 1 个文件/)).toBeInTheDocument();
    expect(screen.queryByText('secret.pdf')).toBeNull();
  });

  it('超大小文件被拒绝并提示', async () => {
    const user = userEvent.setup();
    const onAttachments = vi.fn();
    const picker = createStubFilePicker([
      { name: 'big.mp4', mime: 'video/mp4', size: MEDIA_SIZE_LIMITS.video + 1, path: '~/inkling/attachments/big.mp4' },
    ]);
    render(<AgentInput filePicker={picker} models={MULTIMODAL} selectedModel="mm" onAttachments={onAttachments} />);
    await user.click(screen.getByTitle('选择文件'));
    expect(onAttachments).not.toHaveBeenCalled();
    expect(screen.getByText(/已拒绝 1 个文件/)).toBeInTheDocument();
  });
});
