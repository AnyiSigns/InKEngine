/**
 * 模型选择器测试：档案按挡位分组 + 切换联动占用/上限；无宿主回落假数据。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AgentInput } from '@/components/agent_input';
import type { ModelProfile } from '@/shared/backend/backendAdapter';

const PROFILES: ModelProfile[] = [
  { id: 'm1', name: '主·专业', tier: 'main', occupancy: 4, limit: 10 },
  { id: 'r1', name: '制片·快', tier: 'router', occupancy: 1, limit: 5 },
];

describe('模型选择器', () => {
  it('按挡位分组渲染选项', () => {
    const { container } = render(<AgentInput models={PROFILES} />);
    expect(screen.getByRole('option', { name: '主·专业' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '制片·快' })).toBeInTheDocument();
    // optgroup 标签按挡位分组
    const groups = Array.from(container.querySelectorAll('optgroup')).map((g) => g.getAttribute('label'));
    expect(groups).toContain('挡位 main');
    expect(groups).toContain('挡位 router');
  });

  it('选中模型联动占用/上限显示', () => {
    render(<AgentInput models={PROFILES} selectedModel="m1" />);
    expect(screen.getByText('占用 4/10')).toBeInTheDocument();
  });

  it('切换触发 onModelSelect 回调并更新占用', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<AgentInput models={PROFILES} onModelSelect={onSelect} />);
    await user.selectOptions(screen.getByRole('combobox'), 'r1');
    expect(onSelect).toHaveBeenCalledWith('r1');
    expect(screen.getByText('占用 1/5')).toBeInTheDocument();
  });

  it('无档案回落假数据（不崩）', () => {
    render(<AgentInput />);
    expect(screen.getByText(/占用/)).toBeInTheDocument();
  });
});
