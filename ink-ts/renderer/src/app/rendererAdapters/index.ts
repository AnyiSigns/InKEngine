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
import { sessionAdapterRegistry } from './sessionAdapters';

/** 注册全部产品 canonical 适配器（幂等：注册表同名覆盖语义天然幂等）。 */
export function registerProductComponents(): void {
  for (const [name, Comp] of Object.entries({ ...layoutAdapterRegistry, ...sessionAdapterRegistry })) {
    registerComponent(name, Comp as PlainComponent);
  }
}

/** canonical 组件清单（spec/白名单/manifest 同步用：注册 = 白名单放行）。 */
export const productCanonicalComponents = [
  ...Object.keys(layoutAdapterRegistry),
  ...Object.keys(sessionAdapterRegistry),
] as const;
