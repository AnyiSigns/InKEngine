/**
 * 模型选择器测试：档案平铺列表（输入框只设默认值，不按挡位分组——
 * inkling.ui.input_box_model_selection_default_only 决策）+ 切换联动占用/上限。
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AgentInput } from '@/components/agent_input';
import type { ModelProfile } from '@/components/agent_input';

const PROFILES: ModelProfile[] = [
  { id: 'm1', name: '主·专业', tier: 'main', occupancy: 4, limit: 10 },
  { id: 'r1', name: '制片·快', tier: 'router', occupancy: 1, limit: 5 },
];

describe('模型选择器', () => {
  it('平铺渲染全部模型选项（不按挡位分组）', () => {
    const { container } = render(<AgentInput models={PROFILES} />);
    expect(screen.getByRole('option', { name: '主·专业' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '制片·快' })).toBeInTheDocument();
    // 决策回归：输入框模型选择只设默认值，禁止 main/audit/router 挡位分组
    expect(container.querySelectorAll('optgroup')).toHaveLength(0);
    expect(container.textContent).not.toContain('挡位');
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
});
