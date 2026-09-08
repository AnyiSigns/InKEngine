/**
 * host logic-face 装配期装载器测试（阶段 7a：doc_parse 首个真面样板）。
 *
 * 覆盖：声明列举（manifest plugins[] faces.logic.target='host' → doc_parse）；
 * 装配装载返回模块 + 默认工厂契约（default(init) => DocParser 实例）；
 * 缺插件源 = 空集（不报错，消费方降级）。
 */

import { describe, expect, it } from 'vitest';

import { listHostLogicFaces, loadHostLogicFaces } from '../../src/face/loader.js';

describe('host logic-face loader', () => {
  it('列出 host logic face：doc_parse faces.logic（target=host）', () => {
    const rows = listHostLogicFaces(undefined);
    const doc = rows.find((r) => r.pluginId === 'doc_parse');
    expect(doc).toBeDefined();
    expect(doc?.dir).toBe('tools/doc_parse');
    expect(doc?.entry).toBe('./faces/logic/index.ts');
  });

  it('按声明装载：doc_parse 模块默认导出工厂产出 DocParser（binary=null 降级实例）', async () => {
    const faces = await loadHostLogicFaces(undefined);
    const mod = faces['doc_parse'] as { default?: (init: { binary?: string | null }) => { available(): boolean } } | undefined;
    const factory = mod?.default;
    expect(typeof factory).toBe('function');
    const parser = (factory as (init: { binary?: string | null }) => { available(): boolean })({ binary: null });
    expect(typeof parser.available).toBe('function');
    expect(parser.available()).toBe(false);
  });

  it('无插件源（不存在目录）返回空集不抛', async () => {
    const faces = await loadHostLogicFaces('Z:/no-such-seed-dir-xyz');
    expect(Object.keys(faces)).toHaveLength(0);
  });
});
