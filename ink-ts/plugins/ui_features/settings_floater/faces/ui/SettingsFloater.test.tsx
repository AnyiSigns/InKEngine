/**
 * settings_floater 真面测试：派生清单驱动导航 + DynamicComponent 面板内容 +
 * 打开/关闭/切换节交互。内容段以 stub 组件注册（settings_general / plugins），
 * 不耦合具体面板插件实现。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { SettingsFloater } from './SettingsFloater';
import { registerComponent } from '@/renderer/componentRegistry';
import { SETTINGS_SECTIONS } from '@app/settings/settingsSections.generated';

function registerPanelStubs(): void {
  registerComponent('settings_general', () => <div>通用面板内容</div>);
  registerComponent('plugins', () => <div>插件面板内容</div>);
}

describe('SettingsFloater（派生清单 SETTINGS_SECTIONS 驱动）', () => {
  it('关闭态不渲染浮层', () => {
    render(<SettingsFloater open={false} onClose={() => { }} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开态渲染 dialog + 全量节导航（SETTINGS_SECTIONS order 升序）', () => {
    registerPanelStubs();
    const { container } = render(<SettingsFloater open onClose={() => { }} />);
    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument();
    for (const section of SETTINGS_SECTIONS) {
      expect(container.querySelector(`[data-ui="settings_nav_${section.key}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-ui="settings_nav_general"]')?.getAttribute('data-active')).toBe('true');
  });

  it('默认打开渲染首个段内容（settings_general）', () => {
    registerPanelStubs();
    render(<SettingsFloater open onClose={() => { }} />);
    expect(screen.getByText('通用面板内容')).toBeInTheDocument();
  });

  it('点击节导航切换右侧内容（DynamicComponent name=面板插件 id）', () => {
    registerPanelStubs();
    render(<SettingsFloater open onClose={() => { }} />);
    fireEvent.click(screen.getByText('插件'));
    expect(screen.getByText('插件面板内容')).toBeInTheDocument();
    expect(screen.queryByText('通用面板内容')).toBeNull();
  });

  it('关闭按钮触发 onClose', () => {
    registerPanelStubs();
    const onClose = vi.fn();
    render(<SettingsFloater open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('遮罩点击关闭（内容区点击不关闭）', () => {
    registerPanelStubs();
    const onClose = vi.fn();
    const { container } = render(<SettingsFloater open onClose={onClose} />);
    fireEvent.click(container.querySelector('[data-ui="settings_floater"]') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('[data-ui="settings_floater_overlay"]') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
