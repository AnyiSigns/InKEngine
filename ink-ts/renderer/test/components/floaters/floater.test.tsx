/**
 * 悬浮窗工厂测试：拖拽 / 缩放 / 关闭 / 层级 token / 三态反馈。
 */

import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';

import { FloaterWindow } from '@/components/floaters/floater_window';
import { Feedback } from '@/components/floaters/feedback';
import { Z_VARIANTS } from '@/renderer/designTokens';

describe('悬浮窗工厂', () => {
  it('渲染标题/关闭回调/浮层语义（dialog + z-index token）', () => {
    const onClose = vi.fn();
    render(
      <FloaterWindow title="测试窗" onClose={onClose}>
        <div>内容</div>
      </FloaterWindow>,
    );
    expect(screen.getByRole('dialog', { name: '测试窗' })).toBeInTheDocument();
    expect(screen.getByText('内容')).toBeInTheDocument();
    expect(screen.getByRole('dialog').className).toContain(Z_VARIANTS.floater);
    fireEvent.click(screen.getByTitle('关闭'));
    expect(onClose).toHaveBeenCalled();
  });

  it('拖拽移动（mouse 事件驱动位移；pointer 监听在 browser 生效）', () => {
    render(
      <FloaterWindow title="拖拽窗" initialRect={{ x: 100, y: 100, width: 340, height: 240 }}>
        <div>内容</div>
      </FloaterWindow>,
    );
    const windowEl = screen.getByRole('dialog');
    expect(windowEl.style.left).toBe('100px');
    const header = windowEl.querySelector('[data-ui="floater_header"]') as HTMLElement;
    fireEvent.mouseDown(header, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(header, { clientX: 160, clientY: 130 });
    fireEvent.mouseUp(header, { clientX: 160, clientY: 130 });
    expect(windowEl.style.left).toBe('160px');
    expect(windowEl.style.top).toBe('130px');
  });

  it('缩放（右下角手柄）', () => {
    render(
      <FloaterWindow title="缩放窗" initialRect={{ x: 0, y: 0, width: 340, height: 240 }}>
        <div>内容</div>
      </FloaterWindow>,
    );
    const windowEl = screen.getByRole('dialog');
    const handle = screen.getByLabelText('拖拽改变大小');
    fireEvent.mouseDown(handle, { clientX: 340, clientY: 240 });
    fireEvent.mouseMove(handle, { clientX: 400, clientY: 300 });
    fireEvent.mouseUp(handle, { clientX: 400, clientY: 300 });
    expect(windowEl.style.width).toBe('400px');
    expect(windowEl.style.height).toBe('300px');
  });

  it('缩放最小值限制', () => {
    render(
      <FloaterWindow title="最小窗" initialRect={{ x: 0, y: 0, width: 340, height: 240 }}>
        <div>内容</div>
      </FloaterWindow>,
    );
    const windowEl = screen.getByRole('dialog');
    const handle = screen.getByLabelText('拖拽改变大小');
    fireEvent.mouseDown(handle, { clientX: 340, clientY: 240 });
    fireEvent.mouseMove(handle, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(handle, { clientX: 10, clientY: 10 });
    expect(Number.parseInt(windowEl.style.width, 10)).toBeGreaterThanOrEqual(280);
  });
});

describe('三态反馈（无静默变化）', () => {
  it('loading / success / fail 三态可见', () => {
    const { rerender } = render(<Feedback phase="loading" okText="完成" failText="失败" />);
    expect(screen.getByText('处理中…')).toBeInTheDocument();
    rerender(<Feedback phase="success" okText="完成" failText="失败" />);
    expect(screen.getByText('完成')).toBeInTheDocument();
    rerender(<Feedback phase="fail" okText="完成" failText="失败" />);
    expect(screen.getByText('失败')).toBeInTheDocument();
  });

  it('idle 不占位', () => {
    const { container } = render(<Feedback phase="idle" okText="完成" failText="失败" />);
    expect(container.querySelector('[data-ui="feedback"]')).toBeNull();
  });
});
