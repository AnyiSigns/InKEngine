/**
 * 设置节注册表（对外固定签名，集成 agent 按此对接）。
 *
 * 注册契约：
 *   SettingsSectionSpec = { key, label, icon, order, items? | render? }
 *   SettingsItemSpec   = { key, label, hint?, kind, options?, read, write?, disabledReason?, validate? }
 */

import type { SettingsSectionSpec } from './types';

const registry = new Map<string, SettingsSectionSpec>();

export function registerSettingsSection(spec: SettingsSectionSpec): void {
  registry.set(spec.key, spec);
}

export function getSettingsSection(key: string): SettingsSectionSpec | undefined {
  return registry.get(key);
}

export function listSettingsSections(): SettingsSectionSpec[] {
  return Array.from(registry.values()).sort((a, b) => a.order - b.order);
}

export function resetSettingsRegistry(): void {
  registry.clear();
}
