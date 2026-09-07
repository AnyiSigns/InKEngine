/**
 * milestone_reached 渲染器测试（自举实证产物）。
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetMessageRendererRegistry, resolveMessageRenderer } from '@/renderer/messageRendererRegistry';
import { registerMilestoneEntry } from '@/renderer/milestone_entry';

describe('milestone_entry 渲染器', () => {
  beforeEach(() => {
    resetMessageRendererRegistry();
  });

  it('milestone_reached 可解析到自定义渲染器并渲染标题', () => {
    expect(registerMilestoneEntry()).toBe(true);
    const Renderer = resolveMessageRenderer('milestone_reached');
    expect(Renderer).not.toBeNull();
    if (Renderer === null) return;
    render(<Renderer event={{ title: '首章完成', detail: '第一章已写完' }} />);
    expect(screen.getByText('首章完成')).toBeInTheDocument();
    expect(screen.getByText('第一章已写完')).toBeInTheDocument();
  });
});
