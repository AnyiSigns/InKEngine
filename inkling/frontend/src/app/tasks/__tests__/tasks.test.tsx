import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TaskCapsule } from '../TaskCapsule';
import { RoundTaskSummary } from '../RoundTaskSummary';
import type { TaskCapsuleData, RoundTaskSummaryData } from '../types';

describe('TaskCapsule', () => {
  const sampleTask: TaskCapsuleData = {
    goal: '测试任务',
    status: 'running',
    step: 3,
    total: 7,
  };

  it('渲染任务胶囊', () => {
    render(<TaskCapsule task={sampleTask} />);
    expect(screen.getByText(/步骤 3\/7/)).toBeInTheDocument();
  });

  it('取消按钮触发回调', () => {
    const onCancel = vi.fn();
    const { container } = render(<TaskCapsule task={sampleTask} onCancel={onCancel} />);
    const cancelBtn = container.querySelector('[data-ui="task_capsule_cancel"]');
    expect(cancelBtn).toBeInTheDocument();
    (cancelBtn as HTMLElement).click();
    expect(onCancel).toHaveBeenCalled();
  });

  it('非运行态不显示取消按钮', () => {
    const completedTask: TaskCapsuleData = { ...sampleTask, status: 'completed' };
    const { container } = render(<TaskCapsule task={completedTask} onCancel={vi.fn()} />);
    expect(container.querySelector('[data-ui="task_capsule_cancel"]')).not.toBeInTheDocument();
  });
});

describe('RoundTaskSummary', () => {
  const sampleData: RoundTaskSummaryData = {
    goal: '测试目标',
    status: 'completed',
    changed_files: ['src/a.ts', 'src/b.ts'],
    next_step: '继续下一步',
    summary_ref: 'ref-001',
  };

  it('渲染任务摘要', () => {
    render(<RoundTaskSummary data={sampleData} />);
    expect(screen.getByText('任务摘要')).toBeInTheDocument();
    expect(screen.getByText('测试目标')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts, src/b.ts')).toBeInTheDocument();
  });
});
