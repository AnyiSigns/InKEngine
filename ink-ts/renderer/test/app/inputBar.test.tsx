import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputBar } from '@/app/input/InputBar';
import type { ModelArchiveSnapshot } from '@/shared/backend/backendAdapter';

describe('InputBar', () => {
  it('allows typing and sending without configured models', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    const textarea = screen.getByPlaceholderText('给智能体发消息') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('hello', [], undefined);
  });

  it('shows model chip when model selected', () => {
    const models: ModelArchiveSnapshot = { archives: [{ model_id: 'kimi-k2', context_window: 128 * 1024, multimodal: true }] };
    render(<InputBar disabled={false} streaming={false} models={models} onSend={() => {}} onAbort={() => {}} onAttachments={() => {}} />);
    expect(screen.getByText('kimi-k2')).toBeTruthy();
    expect(screen.getByText('多模态')).toBeTruthy();
  });

  it('shows route plan preview', () => {
    render(<InputBar disabled={false} streaming={false} routePlan={{ chainLabel: '研究链', quota: 10, tier: 'light' }} onSend={() => {}} onAbort={() => {}} onAttachments={() => {}} />);
    expect(screen.getByText(/将走 研究链/)).toBeTruthy();
  });

  it('shows reasoning tier chip and carries chosen tier on send', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'qwen3-max' }] }} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    const chip = screen.getByRole('button', { name: '推理档位' });
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole('menuitem', { name: '高' }));
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('hi', [], { model_id: 'qwen3-max', reasoning_effort: 'high' });
  });

  it('hides reasoning tier chip for non-reasoning models', () => {
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'deepseek-chat' }] }} onSend={() => {}} onAbort={() => {}} onAttachments={() => {}} />);
    expect(screen.queryByRole('button', { name: '推理档位' })).toBeNull();
  });

  it('sends on Enter', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} models={{ archives: [{ model_id: 'm1' }] }} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: 'hello' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('hello', [], { model_id: 'm1' });
  });

  it('回合档位切换已取消：无标准/组装下拉，发送恒为组装', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} onSend={onSend} onAbort={() => {}} onAttachments={() => {}} />);
    expect(screen.queryByRole('button', { name: /标准|组装/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('给智能体发消息'), { target: { value: 'ok' } });
    fireEvent.keyDown(screen.getByPlaceholderText('给智能体发消息'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('ok', [], undefined);
  });
});
