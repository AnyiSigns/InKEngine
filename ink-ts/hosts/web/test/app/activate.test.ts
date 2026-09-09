import { describe, it, expect } from 'vitest';

import { registerBuiltinComponents } from '@/components';
import { registerPluginFaces } from '@app/pluginFaces.generated';
import { isComponentRegistered } from '@/renderer/componentRegistry';
import { SETTINGS_SECTIONS } from '@app/settings/settingsSections.generated';

/**
 * 设置浮层装配（派生清单 SETTINGS_SECTIONS 单一真源）：段清单键序/order 来自
 * 各面板插件 spec（data.settings_section），内容 = 面板插件真 ui 面 id；
 * settings_floater 为 overlay canonical 叶子，装配期经 registerPluginFaces
 * 与各面板一并注册，永不落「未注册组件」占位。
 */
describe('设置浮层装配（SETTINGS_SECTIONS 派生清单 + 真 ui 面注册）', () => {
  it('全量 12 段 key 与 order 符合扁平清单（B4 合并 plugins 段，卸载 mcp_market/tools_panel）', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.key)).toEqual([
      'general',
      'model',
      'connect',
      'knowledge_set',
      'architecture',
      'plugins',
      'workspace_auth',
      'ui_editor',
      'memory',
      'insights',
      'audit_recovery',
      'backup',
    ]);
    const orders = SETTINGS_SECTIONS.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('每段携带内容插件 id 与声明 label', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.id.length).toBeGreaterThan(0);
      expect(section.label.length).toBeGreaterThan(0);
    }
  });

  it('registerPluginFaces 后每段内容 id 与 settings_floater 均可解析', () => {
    registerBuiltinComponents();
    registerPluginFaces();
    for (const section of SETTINGS_SECTIONS) {
      expect(isComponentRegistered(section.id)).toBe(true);
    }
    expect(isComponentRegistered('settings_floater')).toBe(true);
  });
});
