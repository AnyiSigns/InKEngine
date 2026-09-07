import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpawnPanel } from '@/app/session/SpawnPanel';
import type { SpawnInstance } from '@/app/session/SpawnPanel';

describe('SpawnPanel', () => {
  const instances: SpawnInstance[] = [
    { index: 0, label: '子任务 1', status: 'running', duration: 1000 },
    { index: 1, label: '子任务 2', status: 'completed', duration: 2000 },
  ];

  it('renders instances list', () => {
    render(<SpawnPanel open={true} onClose={() => {}} instances={instances} selectedIndex={0} onSelectIndex={() => {}} onSendInstruction={() => {}} streaming={false} />);
    expect(screen.getAllByText('子任务 1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('子任务 2')).toBeTruthy();
  });

  it('renders instruction input', () => {
    render(<SpawnPanel open={true} onClose={() => {}} instances={instances} selectedIndex={0} onSelectIndex={() => {}} onSendInstruction={() => {}} streaming={false} />);
    expect(screen.getByPlaceholderText('补充指令：让这个子代理…')).toBeTruthy();
  });

  it('calls onSendInstruction on submit', () => {
    const onSend = vi.fn();
    render(<SpawnPanel open={true} onClose={() => {}} instances={instances} selectedIndex={0} onSelectIndex={() => {}} onSendInstruction={onSend} streaming={false} />);
    fireEvent.change(screen.getByPlaceholderText('补充指令：让这个子代理…'), { target: { value: '继续' } });
    fireEvent.keyDown(screen.getByPlaceholderText('补充指令：让这个子代理…'), { key: 'Enter', code: 'Enter', charCode: 13 });
    expect(onSend).toHaveBeenCalledWith('继续');
  });

  it('calls onClose on Escape key when open', () => {
    const onClose = vi.fn();
    render(<SpawnPanel open={true} onClose={onClose} instances={instances} selectedIndex={0} onSelectIndex={() => {}} onSendInstruction={() => {}} streaming={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not react to Escape when closed', () => {
    const onClose = vi.fn();
    render(<SpawnPanel open={false} onClose={onClose} instances={instances} selectedIndex={0} onSelectIndex={() => {}} onSendInstruction={() => {}} streaming={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
