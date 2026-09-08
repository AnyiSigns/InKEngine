/**
 * 生成文件勿手改：设置页段清单派生视图（真源 = plugins/ui_features/<id>/spec.json
 * 的 data.settings_section：key/label/order/icon + faces.ui）。由
 * plugins/scripts/sync_plugin_manifest.mjs 生成（order 升序）；renderer 设置浮层
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
];
