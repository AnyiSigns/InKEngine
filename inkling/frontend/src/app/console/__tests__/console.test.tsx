import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConsolePanel } from '../ConsolePanel';
import { TaskCapsule } from '../../tasks/TaskCapsule';

describe('ConsolePanel', () => {
  it('渲染所有导航项', () => {
    const { container } = render(<ConsolePanel />);
    expect(container.querySelector('[data-ui="console_nav_registry"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_tasks"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_ledger"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_memory"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_backup"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_audit"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_lifecycle"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_insights"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_voice"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_appearance"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui="console_nav_about"]')).toBeInTheDocument();
  });

  it('默认显示注册表节', () => {
    const { container } = render(<ConsolePanel />);
    expect(container.querySelector('[data-ui="console_nav_registry"]')).toBeInTheDocument();
    expect(screen.getAllByText('注册表').length).toBeGreaterThan(0);
  });
});

describe('TaskCapsule 仅长任务期间', () => {
  it('运行态显示取消按钮', () => {
    const { container } = render(<TaskCapsule task={{ goal: '长任务', status: 'running', step: 1, total: 5 }} onCancel={vi.fn()} />);
    expect(container.querySelector('[data-ui="task_capsule_cancel"]')).toBeInTheDocument();
  });
});
