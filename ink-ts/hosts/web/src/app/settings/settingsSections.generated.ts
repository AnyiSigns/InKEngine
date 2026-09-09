/**
 * 生成文件勿手改：设置页段清单派生视图（真源 = plugins/ui_features/<id>/spec.json
 * 的 data.settings_section：key/label/order/icon + faces.ui）。由
 * plugins/scripts/sync_plugin_manifest.mjs 生成（order 升序）；hosts/web 设置浮层
 * 壳读本清单渲染导航与内容（DynamicComponent name=插件 id）；verify:plugin-manifest
 * 强制逐字一致。
 */

export interface SettingsSectionEntry {
  id: string;
  type: string;
  key: string;
  label: string;
  order: number;
  icon?: string;
}

export const SETTINGS_SECTIONS: SettingsSectionEntry[] = [
  { id: 'settings_general', type: 'settings_general', key: 'general', label: '通用', order: 1, icon: 'settings2' },
  { id: 'settings_model', type: 'settings_model', key: 'model', label: '模型', order: 2, icon: 'model' },
  { id: 'settings_connect', type: 'settings_connect', key: 'connect', label: '连接', order: 3, icon: 'plug_zap' },
  { id: 'settings_knowledge', type: 'settings_knowledge', key: 'knowledge_set', label: '知识集', order: 5, icon: 'book_open' },
  { id: 'settings_architecture', type: 'settings_architecture', key: 'architecture', label: '架构', order: 6, icon: 'network' },
  { id: 'plugins', type: 'plugins', key: 'plugins', label: '插件', order: 10, icon: 'package' },
  { id: 'workspace_auth', type: 'workspace_auth', key: 'workspace_auth', label: '工作区授权', order: 40, icon: 'shield' },
  { id: 'ui_editor_host', type: 'ui_editor_host', key: 'ui_editor', label: '界面编辑器', order: 50, icon: 'pencil_ruler' },
  { id: 'settings_memory', type: 'settings_memory', key: 'memory', label: '记忆', order: 73, icon: 'database' },
  { id: 'settings_insights', type: 'settings_insights', key: 'insights', label: '洞察', order: 74, icon: 'eye' },
  { id: 'settings_audit_recovery', type: 'settings_audit_recovery', key: 'audit_recovery', label: '审计与恢复', order: 75, icon: 'file_clock' },
  { id: 'settings_backup', type: 'settings_backup', key: 'backup', label: '备份', order: 76, icon: 'shield_check' },
];
