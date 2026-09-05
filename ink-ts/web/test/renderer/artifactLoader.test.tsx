/**
 * 产物组件动态加载测试：清单注册/哈希 URL 惰性 import/错误边界灰化/
 * 挂载后刷新（数据源 = mock 后端清单）。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { act } from 'react-dom/test-utils';

import {
  ArtifactBoundary,
  lazyArtifactComponent,
  refreshArtifactManifest,
  registerArtifactManifest,
  registerArtifactComponent,
} from '@/renderer/artifactLoader';
import type { BackendAdapter, ArtifactManifestEntry } from '@/shared/backend/backendAdapter';

describe('产物组件注册', () => {
  it('合法名注册放行；非法名/空名拒绝', () => {
    expect(registerArtifactComponent('ok_component', () => null)).toBe(true);
    expect(registerArtifactComponent('', () => null)).toBe(false);
    expect(registerArtifactComponent('Bad-Name!', () => null)).toBe(false);
    expect(registerArtifactComponent('x'.repeat(80), () => null)).toBe(false);
  });

  it('清单注册：合法条目入表，缺字段/非法 URL/坏哈希跳过', () => {
    const entries: ArtifactManifestEntry[] = [
      { name: 'artifact_a', url: 'http://localhost:4321/a.js', hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', version: '0.1.0' },
      { name: '', url: 'http://x/b.js', hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', version: '0.1.0' },
      { name: 'artifact_b', url: 'http://localhost:4321/b.js', hash: 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', version: '0.1.0' },
      { name: 'artifact_bad_hash', url: 'http://localhost:4321/x.js', hash: 'not-a-hex-hash', version: '0.1.0' },
      { name: 'artifact_bad_scheme', url: 'javascript:alert(1)', hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', version: '0.1.0' },
    ];
    const registered = registerArtifactManifest(entries);
    expect(registered).toBe(2);
  });
});

describe('宿主清单刷新（挂载后注册表刷新）', () => {
  it('宿主不可用 = 零注册不报错', async () => {
    await expect(refreshArtifactManifest(null)).resolves.toBe(0);
  });

  it('宿主可用 = 拉取清单并注册', async () => {
    const backend = {
      available: true,
      componentsManifest: vi.fn(async () => ({
        artifacts: [
          { name: 'artifact_c', url: 'http://localhost:4321/c.js', hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', version: '0.1.0' },
        ],
      })),
    } as unknown as BackendAdapter;
    const count = await refreshArtifactManifest(backend);
    expect(count).toBe(1);
  });
});

describe('惰性加载与错误边界', () => {
  it('惰性组件装载失败 = 灰化占位（不抛穿）', async () => {
    const Failed = lazyArtifactComponent('http://localhost:1/missing.js', 'missing');
    render(
      <ArtifactBoundary name="missing">
        <Suspense fallback={<div>loading</div>}>
          <Failed />
        </Suspense>
      </ArtifactBoundary>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await screen.findByText(/missing 加载失败/)).toBeInTheDocument();
  });

  it('错误边界捕获子组件崩溃 = 灰化', () => {
    const Bomb = (): never => {
      throw new Error('boom');
    };
    render(
      <ArtifactBoundary name="bomb">
        <Bomb />
      </ArtifactBoundary>,
    );
    expect(screen.getByText(/bomb 渲染失败/)).toBeInTheDocument();
  });
});
