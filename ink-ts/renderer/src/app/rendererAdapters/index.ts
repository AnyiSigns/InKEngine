/**
 * 产品 canonical 适配器装配（componentRegistry 白名单放行面）。
 *
 * 产品主壳（plugins/ui_features 装配生成物）引用的 canonical 组件名 → 产品实现
 * （薄适配器）：binding 载荷与宿主 product chrome 在此映射为产品组件 props。message_list
 * 等四个 gate 锚点名保持注册（映射到新适配器，勿留死注册）；热装 artifact
 * 经 registerArtifactManifest 同名覆盖仍可接管。
 */

import { registerComponent, type PlainComponent } from '@/renderer/componentRegistry';
import { layoutAdapterRegistry } from './layoutAdapters';

/** 注册剩余产品 canonical 适配器（settings_floater；其余叶子已真面化随插件
 *  faces/ui 同住，pluginFaces.generated.ts 注册——message_list 后 renderer
 *  adapter 层仅剩 settings_floater，settings 组迁移后本层整体退役）。 */
export function registerProductComponents(): void {
  for (const [name, Comp] of Object.entries(layoutAdapterRegistry)) {
    registerComponent(name, Comp as PlainComponent);
  }
}

/** canonical 适配器清单（注册 = 白名单放行面）。 */
export const productCanonicalComponents = [...Object.keys(layoutAdapterRegistry)] as const;
