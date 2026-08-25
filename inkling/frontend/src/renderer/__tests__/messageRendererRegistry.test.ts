/**
 * 自定义消息渲染器注册表测试：新事件类型绑定生效 + 白名单外拒绝 +
 * 形态未声明 fail-closed + 产物清单 renderer_key 注入。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import type { ComponentType } from 'react';

import {
  isRendererKeyAllowed,
  registerMessageRenderer,
  registerRendererKey,
  resetMessageRendererRegistry,
  resolveMessageRenderer,
} from '@/renderer/messageRendererRegistry';
import { registerArtifactManifest } from '@/renderer/artifactLoader';
import type { ArtifactManifestEntry } from '@/shared/backend/backendAdapter';

const NullRenderer: ComponentType<{ event?: unknown }> = () => null;

describe('渲染器键白名单', () => {
  beforeEach(() => resetMessageRendererRegistry());

  it('出厂基线含事件类型名（reply_token 可绑定）', () => {
    expect(isRendererKeyAllowed('reply_token')).toBe(true);
    expect(registerMessageRenderer('reply_token', NullRenderer, ['mini'])).toBe(true);
  });

  it('新事件类型先登记键再绑定生效', () => {
    expect(registerRendererKey('custom_telemetry')).toBe(true);
    expect(isRendererKeyAllowed('custom_telemetry')).toBe(true);
    expect(registerMessageRenderer('custom_telemetry', NullRenderer, ['mini'])).toBe(true);
    expect(resolveMessageRenderer('custom_telemetry', 'mini')).not.toBeNull();
  });

  it('非法键名（大写/空/超长）登记拒绝', () => {
    expect(registerRendererKey('BadName')).toBe(false);
    expect(registerRendererKey('')).toBe(false);
    expect(registerRendererKey('x'.repeat(80))).toBe(false);
  });
});

describe('渲染器绑定 fail-closed', () => {
  beforeEach(() => resetMessageRendererRegistry());

  it('白名单外键拒绝绑定', () => {
    expect(registerMessageRenderer('not_in_whitelist', NullRenderer)).toBe(false);
    expect(resolveMessageRenderer('not_in_whitelist', 'mini')).toBeNull();
  });

  it('缺失渲染器拒绝绑定', () => {
    registerRendererKey('ghost');
    expect(registerMessageRenderer('ghost', null as unknown as ComponentType<{ event?: unknown }>)).toBe(false);
  });

  it('形态未声明拒绝（不回落任意渲染器）', () => {
    registerRendererKey('custom_telemetry');
    registerMessageRenderer('custom_telemetry', NullRenderer, ['mini']);
    expect(resolveMessageRenderer('custom_telemetry', 'mini')).not.toBeNull();
    expect(resolveMessageRenderer('custom_telemetry', 'overlay')).toBeNull();
  });
});

describe('产物清单 renderer_key 注入注册表', () => {
  beforeEach(() => resetMessageRendererRegistry());

  it('清单条目带 renderer_key + view_forms 登记为自定义渲染器', () => {
    const entries: ArtifactManifestEntry[] = [
      {
        name: 'artifact_chart',
        url: 'http://localhost:4321/chart.js',
        hash: 'h1',
        version: '0.1.0',
        renderer_key: 'custom_chart',
        view_forms: ['mini', 'overlay'],
      },
    ];
    registerArtifactManifest(entries);
    expect(isRendererKeyAllowed('custom_chart')).toBe(true);
    expect(resolveMessageRenderer('custom_chart', 'mini')).not.toBeNull();
    expect(resolveMessageRenderer('custom_chart', 'overlay')).not.toBeNull();
  });

  it('无 renderer_key 的清单条目不污染渲染器键白名单', () => {
    const entries: ArtifactManifestEntry[] = [
      { name: 'plain_artifact', url: 'http://localhost:4321/plain.js', hash: 'h', version: '0.1.0' },
    ];
    registerArtifactManifest(entries);
    expect(isRendererKeyAllowed('plain_artifact')).toBe(false);
  });
});
