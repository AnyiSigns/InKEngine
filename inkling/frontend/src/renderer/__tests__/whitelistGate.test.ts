import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerBuiltinComponents } from '@/components';
import { isComponentRegistered } from '@/renderer/componentRegistry';

/**
 * 渲染器白名单双向门禁（）：manifest.json contracts.renderer_components
 * 是出厂组件清单的单一事实源——前端注册表必须对清单内每个名字都可解析
 * （spec 渲染/组件 tab 永不落「未注册拒绝」）。注册表侧为清单超集允许
 * （pathAssembly 等运行时装配名不在出厂清单）。
 */
describe('出厂渲染器白名单对码', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../manifest.json'), 'utf8'),
  ) as { contracts?: { renderer_components?: string[] } };
  const factory = manifest.contracts?.renderer_components ?? [];

  it('manifest 声明的出厂组件全部有前端实现或占位注册', () => {
    registerBuiltinComponents();
    const missing = factory.filter((name) => !isComponentRegistered(name));
    expect(missing).toEqual([]);
  });
});
