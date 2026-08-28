import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputBar } from '../input/InputBar';
import type { ModelArchiveSnapshot } from '@/shared/backend/backendAdapter';

describe('InputBar', () => {
  it('shows no-model prompt when no models', () => {
    render(<InputBar disabled={false} streaming={false} onSend={() => {}} onAbort={() => {}} onOpenSettings={() => {}} onAttachments={() => {}} />);
    expect(screen.getByText('请先配置模型')).toBeTruthy();
  });

  it('shows model chip when model selected', () => {
    const models: ModelArchiveSnapshot = { profiles: [{ id: 'm1', name: 'TestModel', tier: 'main', occupancy: 0, limit: 100, multimodal: true }] };
    render(<InputBar disabled={false} streaming={false} models={models} onSend={() => {}} onAbort={() => {}} onOpenSettings={() => {}} onAttachments={() => {}} />);
    expect(screen.getByText('TestModel')).toBeTruthy();
    expect(screen.getByText('多模态')).toBeTruthy();
  });

  it('shows route plan preview', () => {
    render(<InputBar disabled={false} streaming={false} routePlan={{ chainLabel: '研究链', quota: 10, tier: 'light' }} onSend={() => {}} onAbort={() => {}} onOpenSettings={() => {}} onAttachments={() => {}} />);
    expect(screen.getByText(/将走 研究链/)).toBeTruthy();
  });

  it('sends on Enter', () => {
    const onSend = vi.fn();
    render(<InputBar disabled={false} streaming={false} models={{ profiles: [{ id: 'm1', name: 'M', tier: 'main', occupancy: 0, limit: 100 }] }} onSend={onSend} onAbort={() => {}} onOpenSettings={() => {}} onAttachments={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('输入消息…'), { target: { value: 'hello' } });
    fireEvent.keyDown(screen.getByPlaceholderText('输入消息…'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('hello', [], 'standard');
  });

  it('switches mode via segmented control', () => {
    render(<InputBar disabled={false} streaming={false} onSend={() => {}} onAbort={() => {}} onOpenSettings={() => {}} onAttachments={() => {}} />);
    const assemblyBtn = screen.getByText('组装');
    fireEvent.click(assemblyBtn);
    expect(assemblyBtn.getAttribute('data-active')).toBe('true');
  });
});
