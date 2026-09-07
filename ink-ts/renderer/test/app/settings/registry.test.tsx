/**
 * 设置节注册表单测：注册/查询/列举/重置。
 */

import { describe, expect, it } from 'vitest';

import { registerSettingsSection, listSettingsSections, resetSettingsRegistry, getSettingsSection } from '@/app/settings/registry';
import type { SettingsSectionSpec } from '@/app/settings/types';

function makeSection(overrides: Partial<SettingsSectionSpec> = {}): SettingsSectionSpec {
  return {
    key: 'test_section',
    label: '测试节',
    icon: <span>图标</span>,
    order: 99,
    ...overrides,
  };
}

describe('设置节注册表', () => {
  it('注册后可按 key 查询、按 order 排序列举', () => {
    resetSettingsRegistry();
    registerSettingsSection(makeSection({ key: 'a', order: 2 }));
    registerSettingsSection(makeSection({ key: 'b', order: 1 }));
    expect(getSettingsSection('a')?.label).toBe('测试节');
    const list = listSettingsSections();
    expect(list.map((s) => s.key)).toEqual(['b', 'a']);
  });

  it('重复注册同一 key 覆盖', () => {
    resetSettingsRegistry();
    registerSettingsSection(makeSection({ key: 'x', label: '旧' }));
    registerSettingsSection(makeSection({ key: 'x', label: '新' }));
    expect(getSettingsSection('x')?.label).toBe('新');
  });

  it('重置后 registry 清空', () => {
    resetSettingsRegistry();
    registerSettingsSection(makeSection({ key: 'z' }));
    resetSettingsRegistry();
    expect(listSettingsSections()).toHaveLength(0);
    expect(getSettingsSection('z')).toBeUndefined();
  });
});
