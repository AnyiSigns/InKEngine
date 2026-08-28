import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EnvironmentContainer } from '../EnvironmentContainer';

describe('EnvironmentContainer (W5.5)', () => {
  it('渲染环境容器标题', () => {
    render(<EnvironmentContainer />);

    expect(screen.getByText('环境容器')).toBeTruthy();
  });

  it('显示禁用态文案', () => {
    render(<EnvironmentContainer />);

    expect(screen.getByText('桌面以 OS 沙箱为主；容器域标记。')).toBeTruthy();
  });

  it('创建容器按钮为禁用状态', () => {
    render(<EnvironmentContainer />);

    const createBtn = screen.getByText('创建容器');
    expect(createBtn).toBeDisabled();
  });

  it('幂等销毁按钮为禁用状态', () => {
    render(<EnvironmentContainer />);

    const destroyBtn = screen.getByText('全部销毁');
    expect(destroyBtn).toBeDisabled();
  });

  it('容器创建策略显示为暂未启用', () => {
    render(<EnvironmentContainer />);

    expect(screen.getByText('（暂未启用）')).toBeTruthy();
  });

  it('域标记渲染（当传入 domainMark 时）', () => {
    render(<EnvironmentContainer domainMark="os_sandbox" />);

    expect(screen.getByText('容器域标记：os_sandbox')).toBeTruthy();
  });

  it('镜像清单显示默认值', () => {
    render(<EnvironmentContainer />);

    expect(screen.getByText('inkling-workspace:0.1.0')).toBeTruthy();
  });
});
