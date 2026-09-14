/**
 * 宿主检索域装配集成测试（createHost 链）：引擎检索注册表注入 + tool_index
 * AsyncEmbedder seam 接通。域行为测试（buildHostRetrieval 文档库/远端/本地
 * infer）已随迁插件同住（plugins/domains/retrieval/faces/logic/store.test.ts）；
 * 本文件只留涉 createHost 的装配面，取域工厂经跨树相对 import（S3 先例）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
// 域实现位 = 插件（S4 域组2）：取域工厂经跨树相对 import
import {
  EmbeddingAdapter,
  attachToolIndexEmbedder,
} from '../../../../plugins/domains/retrieval/faces/logic/index.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

const Q_TEXT = '语义检索：如何把一个新工具接入工具索引';

describe('检索源注入契约（createHost → AssemblyRecipe → runtime registry）', () => {
  let handle: HostHandle;

  it('vector/fts 检索源注册进引擎注册表并参与多源检索', async () => {
    const dir = tempDir('ink-registry-');
    handle = await createHost({ data_dir: dir });
    try {
      const registry = handle.runtime.retriever_registry;
      expect(registry).not.toBeNull();
      expect(registry!.names()).toContain('vector');
      expect(registry!.names()).toContain('fts');

      await handle.retrieval.store.upsert('registry-1', Q_TEXT);
      const chunks = (await registry!.retrieve(Q_TEXT, { limit: 8 })) as Array<{ source: string; doc_id: string }>;
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((chunk) => chunk.doc_id === 'registry-1')).toBe(true);
    } finally {
      await handle.dispose();
    }
  });
});

describe('tool_index 语义检索（AsyncEmbedder seam 接通）', () => {
  let handle: HostHandle;

  it('attach 后向量构建 + 预热查询命中（引擎 search 走向量路径）', async () => {
    const dir = tempDir('ink-attach-');
    handle = await createHost({ data_dir: dir });
    try {
      const index = handle.runtime.tool_index;
      expect(index).not.toBeNull();

      const adapter = new EmbeddingAdapter({
        env: { INK_EMBEDDING_LOCAL: 'off' },
      });
      const seam = await attachToolIndexEmbedder(handle.runtime, adapter);
      expect(index!.uses_vectors()).toBe(true);
      expect(seam.lastOutput()!.source).toBe('deterministic');

      const specs = handle.runtime.merged_specs();
      const target = specs.find((spec) => spec.name === 'search_tools') ?? specs[0]!;
      const text = index!.embed_text(target);
      await seam.warmQuery(text);
      const results = index!.search(text, 8);
      expect(results.length).toBeGreaterThan(0);
      expect(index!.degraded_reason).toBeNull();
      await adapter.close();
    } finally {
      await handle.dispose();
    }
  });
});
