import { describe, it, expect, beforeEach } from 'vitest';

import { registerSettingsSections } from '@/app/settings/activate';
import { listSettingsSections, resetSettingsRegistry } from '@/app/settings/registry';

describe('settings 段注册（阶段 7b：wave4 面板扁平为独立段，面板插件真面化）', () => {
  beforeEach(() => {
    resetSettingsRegistry();
    registerSettingsSections();
  });

  it('全量段含布局内核 9 节 + wave4 4 面板，共 13 段', () => {
    const sections = listSettingsSections();
    const keys = sections.map((s) => s.key);
    expect(keys).toEqual([
      'general',
      'model',
      'connect',
      'knowledge_set',
      'architecture',
      'mcp_market',
      'tools_panel',
      'workspace_auth',
      'ui_editor',
      'memory',
      'insights',
      'audit_recovery',
      'backup',
    ]);
  });

  it('settings sections 按 order 升序', () => {
    const sections = listSettingsSections();
    const orders = sections.map((s) => s.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('每段都带 render（DynamicComponent/直渲），无 items 残留', () => {
    const sections = listSettingsSections();
    for (const section of sections) {
      expect(typeof section.render).toBe('function');
    }
  });

  it('wave4 四面板独立成段（key 即插件段引用）', () => {
    const sections = listSettingsSections();
    const wave4 = sections.filter((s) =>
      ['mcp_market', 'tools_panel', 'workspace_auth', 'ui_editor'].includes(s.key),
    );
    expect(wave4.map((s) => s.key)).toEqual(['mcp_market', 'tools_panel', 'workspace_auth', 'ui_editor']);
    expect(wave4.map((s) => s.order)).toEqual([10, 20, 40, 50]);
  });
});
