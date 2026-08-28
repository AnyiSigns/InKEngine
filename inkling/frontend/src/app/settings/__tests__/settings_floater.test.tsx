/**
 * 设置浮窗交互测试：打开/关闭/切换节/保存。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SettingsFloater } from '@/app/settings/settings_floater';
import { registerSettingsSection, resetSettingsRegistry } from '@/app/settings/registry';
import type { SettingsSectionSpec } from '@/app/settings/types';

function makeSection(key: string, label: string, order = 1): SettingsSectionSpec {
  return {
    key,
    label,
    icon: <span data-testid={`icon-${key}`}>{label}图标</span>,
    order,
    items: [
      {
        key: `${key}_item`,
        label: `${label}项`,
        kind: 'text',
        read: vi.fn(async () => ''),
        write: vi.fn(async () => {}),
      },
    ],
  };
}

describe('SettingsFloater', () => {
  it('打开浮窗后展示节导航与首节内容', async () => {
    resetSettingsRegistry();
    registerSettingsSection(makeSection('alpha', 'Alpha', 1));
    registerSettingsSection(makeSection('beta', 'Beta', 2));

    const onClose = vi.fn();
    render(
      <SettingsFloater
        open
        onClose={onClose}
        backend={{ available: true, status: async () => ({ engine_ready: true }), firstRunDismiss: async () => ({ dismissed: false }) }}
      />,
    );

    expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByTestId('icon-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('icon-beta')).toBeInTheDocument();
  });

  it('切换节导航后右侧内容跟随', async () => {
    const user = userEvent.setup();
    resetSettingsRegistry();
    registerSettingsSection(makeSection('alpha', 'Alpha', 1));
    registerSettingsSection(makeSection('beta', 'Beta', 2));

    render(
      <SettingsFloater
        open
        onClose={() => {}}
        backend={{ available: true, status: async () => ({ engine_ready: true }), firstRunDismiss: async () => ({ dismissed: false }) }}
      />,
    );

    await user.click(screen.getByTestId('icon-beta'));
    expect(screen.getByText('Beta项')).toBeInTheDocument();
  });

  it('关闭按钮触发 onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    resetSettingsRegistry();
    registerSettingsSection(makeSection('alpha', 'Alpha', 1));

    render(
      <SettingsFloater
        open
        onClose={onClose}
        backend={{ available: true, status: async () => ({ engine_ready: true }), firstRunDismiss: async () => ({ dismissed: false }) }}
      />,
    );

    await user.click(screen.getByRole('button', { name: '关闭设置' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
