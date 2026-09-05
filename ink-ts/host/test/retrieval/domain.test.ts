/**
 * 宿主检索域测试：确定性/远端两态路由 + 文档库持久化 + 引擎检索注册表
 * 注入 + tool_index AsyncEmbedder seam 接通；本地 infer 冒烟在有二进制与
 * 模型时跑（无则跳过，与 exec 测试同纪律）。
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { buildHostRetrieval, attachToolIndexEmbedder } from '../../src/index.js';
import { EmbeddingAdapter } from '../../src/embedder/adapter.js';
import { GRANITE_97M_DIM } from '../../src/embedder/resolve_plan.js';
import { locateNativeBinary } from '../../src/exec/binary.js';
import { echoGraphRecipe } from '../_graphs.js';

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

const Q_TEXT = '语义检索：如何把一个新工具接入工具索引';

describe('宿主检索域（确定性保底 + 文档库持久化）', () => {
  it('LOCAL=off：文档索引 + vector/fts 检索 + note 来源可观测', async () => {
    const dir = tempDir('ink-retrieval-');
    const domain = buildHostRetrieval(dir, { env: { INK_EMBEDDING_LOCAL: 'off' } });
    try {
      await domain.store.upsert('doc-1', Q_TEXT, { level: 'model', meta: { kind: 'fixture' } });
      await domain.store.upsert('doc-2', '完全没有关系的另一段内容', { level: 'model' });
      const describe = domain.describe();
      expect(describe.source).toBe('deterministic');
      expect(describe.dim).toBe(GRANITE_97M_DIM);
      expect(describe.note).not.toBeNull();
      expect(describe.docs).toBe(2);
      expect(describe.vectors).toBe(2);

      const hits = await domain.vector.retrieve(Q_TEXT, { limit: 4 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.doc_id).toBe('doc-1');
      expect(hits[0]!.source).toBe('vector');
      expect(hits[0]!.meta['note']).not.toBeNull();

      const fts = await domain.fts.retrieve('工具索引', { limit: 4 });
      expect(fts.length).toBeGreaterThan(0);
    } finally {
      await domain.close();
    }
  });

  it('文档库跨实例持久化（落 data_dir/retrieval/index.json）', async () => {
    const dir = tempDir('ink-retrieval-persist-');
    const first = buildHostRetrieval(dir, { env: { INK_EMBEDDING_LOCAL: 'off' } });
    await first.store.upsert('p-1', Q_TEXT);
    await first.close();

    const second = buildHostRetrieval(dir, { env: { INK_EMBEDDING_LOCAL: 'off' } });
    try {
      expect(second.store.size()).toBe(1);
      const rows = second.store.rows();
      expect(rows[0]!.doc_id).toBe('p-1');
      expect(rows[0]!.vector!.length).toBe(GRANITE_97M_DIM);
    } finally {
      await second.close();
    }
  });
});

describe('宿主检索域（远端 openai_compat 路由）', () => {
  it('注入 fetch：向量库按远端嵌入（L2 归一 + 维度透传）', async () => {
    const dir = tempDir('ink-retrieval-remote-');
    const domain = buildHostRetrieval(dir, {
      env: {
        INK_EMBEDDING_BASE_URL: 'http://embed.test/v1',
        INK_EMBEDDING_MODEL: 'text-embedding-3-small',
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const parsed = JSON.parse(String(init.body)) as { input: string[] };
        const list = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: list.map((text, index) => ({
              index,
              embedding: Array.from({ length: 8 }, (_, j) => text.length + index * 8 + j + 1),
            })),
          }),
        } as Response;
      }) as never,
    });
    try {
      await domain.store.upsert('r-1', Q_TEXT);
      const describe = domain.describe();
      expect(describe.source).toBe('remote');
      expect(describe.note).toBeNull();
      expect(describe.vectors).toBe(1);
      expect(domain.store.rows()[0]!.vector!.length).toBe(8);
    } finally {
      await domain.close();
    }
  });
});

describe('检索源注入契约（createHost → AssemblyRecipe → runtime registry）', () => {
  let handle: HostHandle;

  it('vector/fts 检索源注册进引擎注册表并参与多源检索', async () => {
    const dir = tempDir('ink-registry-');
    handle = await createHost({ data_dir: dir }, { graph_recipe: echoGraphRecipe });
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
    handle = await createHost({ data_dir: dir }, { graph_recipe: echoGraphRecipe });
    try {
      const index = handle.runtime.tool_index;
      expect(index).not.toBeNull();
      expect(index!.uses_vectors()).toBe(false);

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

describe('本地 infer 嵌入冒烟（有二进制 + 模型目录才跑）', () => {
  const inferBinary = locateNativeBinary('infer');
  const modelCandidates = [
    path.resolve(process.cwd(), '..', 'models', 'granite-97m'),
    path.resolve(process.cwd(), 'models', 'granite-97m'),
  ];
  const envDir = process.env['INK_EMBEDDING_MODEL_DIR'];
  const found = envDir
    ? envDir
    : modelCandidates.find((candidate) => existsSync(path.join(candidate, 'config.json'))) ?? '';
  const hasModel =
    found !== ''
    && existsSync(path.join(found, 'config.json'))
    && existsSync(path.join(found, 'model_quint8_avx2.onnx'))
    && existsSync(path.join(found, 'tokenizer.json'));
  const describeOrSkip = inferBinary !== null && hasModel ? describe : describe.skip;

  describeOrSkip('本地嵌入真实推理', () => {
    it('infer 子进程嵌入：向量非空 + 维度 384 + 来源可观测', async () => {
      const dir = tempDir('ink-infer-');
      const domain = buildHostRetrieval(dir, {
        modelDir: found,
        inferBinary: inferBinary!,
      });
      try {
        expect(domain.describe().source).toBe('local_infer');
        await domain.store.upsert('l-1', Q_TEXT);
        const rows = domain.store.rows();
        expect(rows[0]!.vector).not.toBeNull();
        expect(rows[0]!.vector!.length).toBe(GRANITE_97M_DIM);
      } finally {
        await domain.close();
      }
    }, 120_000);
  });
});
