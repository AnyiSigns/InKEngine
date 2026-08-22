/**
 * 域加载器契约测试：清单键名（renderer_components）与真实 manifest 同源。
 *
 * 回归防线：前端加载器键名与种子 manifest 契约段（renderer_components）
 * 一旦分叉，本文件用真实 manifest 断言注册集，漂移即红。
 */

import { describe, expect, it, vi } from 'vitest';

import manifest from '../../../../manifest.json';
import type { DomainManifest } from '@/domains/loader';

/** 每次取全新模块实例（重置加载一次语义），避免用例间状态串扰。 */
async function loadFresh() {
  vi.resetModules();
  return import('@/domains/loader');
}

describe('域加载器清单契约（renderer_components 单一事实源）', () => {
  it('真实 manifest 清单 ∩ 实现表 = 注册集（同源断言）', async () => {
    const contracts = (manifest as DomainManifest).contracts;
    expect(contracts?.renderer_components).toContain('knowledge_row');

    const { loadDomainComponents } = await loadFresh();
    const registered = loadDomainComponents(manifest as DomainManifest);
    expect(registered).toEqual(['knowledge_row']);

    const { isComponentRegistered } = await import('@/renderer/componentRegistry');
    for (const name of contracts?.renderer_components ?? []) {
      if (name === 'knowledge_row') {
        expect(isComponentRegistered(name)).toBe(true);
      } else {
        expect(isComponentRegistered(name)).toBe(false);
      }
    }
  });

  it('清单声明但实现缺失的组件跳过注册（不注册 = 渲染侧拒绝）', async () => {
    const { loadDomainComponents } = await loadFresh();
    const registered = loadDomainComponents({
      id: 'probe',
      contracts: { renderer_components: ['knowledge_row', 'not_implemented'] },
    });
    expect(registered).toEqual(['knowledge_row']);

    const { isComponentRegistered } = await import('@/renderer/componentRegistry');
    expect(isComponentRegistered('not_implemented')).toBe(false);
  });

  it('清单缺省/为空的 manifest 不注册任何组件（不崩）', async () => {
    const { loadDomainComponents } = await loadFresh();
    expect(loadDomainComponents(null)).toEqual([]);
    expect(loadDomainComponents({ id: 'x' })).toEqual([]);
  });

  it('幂等：二次调用返回已注册集，不重复注册', async () => {
    const { loadDomainComponents } = await loadFresh();
    const first = loadDomainComponents(manifest as DomainManifest);
    const second = loadDomainComponents(manifest as DomainManifest);
    expect(second).toEqual(first);
    expect(second).toEqual(['knowledge_row']);
  });
});
