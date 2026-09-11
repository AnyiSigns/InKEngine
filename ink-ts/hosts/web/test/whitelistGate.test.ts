import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerBuiltinComponents } from '@/components';
import { registerPluginFaces, PLUGIN_UI_FACES } from '@app/pluginFaces.generated';
import { isComponentRegistered } from '@/renderer/componentRegistry';

/**
 * 渲染器白名单双向门禁：canonical 组件集单一派生真源 = plugins/ui_features
 * 布局树引用组件并集（plugins/manifest.json `ui_features.components`，升序）。
 * 旧侧身份 manifest contracts.renderer_components 须与其逐项一致——前端注册表
 * 必须对清单内每个名字都可解析（spec 渲染/组件 tab 永不落「未注册拒绝」）。
 * 注册表侧为清单超集允许（executionTree 等运行时装配名不在出厂清单）。
 */
describe('出厂渲染器白名单对码', () => {
  const derived = JSON.parse(
    readFileSync(resolve(__dirname, '../../../plugins/manifest.json'), 'utf8'),
  ) as { ui_features?: { components?: string[] } };
  const canonical = derived.ui_features?.components ?? [];
  const legacyManifest = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../inkling/manifest.json'), 'utf8'),
  ) as { contracts?: { renderer_components?: string[] } };
  const factory = legacyManifest.contracts?.renderer_components ?? [];

  it('派生 canonical 与旧侧身份 manifest renderer_components 逐项一致', () => {
    expect(canonical).toEqual(factory);
  });

  it('manifest 声明的出厂组件全部有前端实现或占位注册', () => {
    registerBuiltinComponents();
    registerPluginFaces();
    const missing = factory.filter((name) => !isComponentRegistered(name));
    expect(missing).toEqual([]);
    const missingDerived = canonical.filter((name) => !isComponentRegistered(name));
    expect(missingDerived).toEqual([]);
  });

  it('真 ui 面插件 entry 与本文件类型一致且均已注册（派生视图自洽）', () => {
    for (const face of PLUGIN_UI_FACES) {
      expect(face.type.length).toBeGreaterThan(0);
      expect(face.entry.startsWith('../../../../plugins/ui_features/')).toBe(true);
    }
    registerBuiltinComponents();
    registerPluginFaces();
    for (const face of PLUGIN_UI_FACES) {
      expect(isComponentRegistered(face.id)).toBe(true);
    }
  });
});
