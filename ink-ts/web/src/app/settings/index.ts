export { activate, registerSettingsSections } from './activate';
export type { SettingsSectionSpec, SettingsItemSpec, SettingsItemKind } from './types';
export { listSettingsSections, getSettingsSection, registerSettingsSection, resetSettingsRegistry } from './registry';
export { SettingsFloater } from './settings_floater';
export { SettingsItemRenderer } from './settings_item_renderer';
export { createSettingsBackend, type SettingsBackend } from './backend';
