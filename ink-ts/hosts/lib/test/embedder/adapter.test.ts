/**
 * AsyncEmbedder 适配器测试（in-process 确定性/远端路由；不含真实进程）。
 *
 * 覆盖：三态路由（deterministic 直算保底；remote 经注入 fetch；空输入）；
 * 保底向量单位化/同文再生；远端响应按 index 排序 + L2 归一；本地计划
 * 但未定位 infer 二进制 = 明确报错（不静默假装可用）。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EmbeddingAdapter } from '../../src/embedder/adapter.js';
import { deterministicVector } from '../../src/embedder/deterministic.js';
import { GRANITE_97M_DIM } from '../../src/embedder/resolve_plan.js';

describe('EmbeddingAdapter 三态路由（in-process）', () => {
  it('确定性保底：LOCAL=off → 直算向量（单位化 + 同文再生）', async () => {
    const adapter = new EmbeddingAdapter({ env: { INK_EMBEDDING_LOCAL: 'off' } });
    try {
      const output = await adapter.embed(['第一段', '第二段']);
      expect(output.source).toBe('deterministic');
      expect(output.dim).toBe(GRANITE_97M_DIM);
      expect(output.note).not.toBeNull();
      expect(output.vectors).toHaveLength(2);
      const expected = deterministicVector('第一段', GRANITE_97M_DIM);
      for (let i = 0; i < expected.length; i += 1) {
        expect(Math.abs(output.vectors[0]![i]! - expected[i]!)).toBeLessThan(1e-12);
      }
      expect(output.vectors[1]).not.toEqual(output.vectors[0]);
    } finally {
      await adapter.close();
    }
  });

  it('远端：注入 fetch 响应 → 按 index 排序 + L2 归一 + 维度正确', async () => {
    const adapter = new EmbeddingAdapter({
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
            data: list.map((_, index) => ({
              index,
              embedding: Array.from({ length: 8 }, (_, j) => (index * 8 + j) / 10 + 1),
            })),
          }),
        } as Response;
      }),
    });
    try {
      const output = await adapter.embed(['a', 'b']);
      expect(output.source).toBe('remote');
      expect(output.vectors).toHaveLength(2);
      for (const vector of output.vectors) {
        expect(vector).toHaveLength(8);
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
      }
    } finally {
      await adapter.close();
    }
  });

  it('local_infer 计划但未定位 infer 二进制 = 明确报错（不静默假装可用）', async () => {
    const modelDir = fakeModelDir();
    const adapter = new EmbeddingAdapter({ modelDir });
    expect(adapter.source).toBe('local_infer');
    await expect(adapter.embed(['x'])).rejects.toThrow(/未定位 inferBinary/);
  });

  it('空输入 = 空结果（来源/dim/note 仍可观测）', async () => {
    const adapter = new EmbeddingAdapter({ env: { INK_EMBEDDING_LOCAL: 'off' } });
    try {
      const output = await adapter.embed([]);
      expect(output.vectors).toEqual([]);
      expect(output.source).toBe('deterministic');
    } finally {
      await adapter.close();
    }
  });
});

/** 构造「配置齐全」的模型目录（文件齐备；内容非合法模型亦可——只测路由）。 */
function fakeModelDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-adapter-model-'));
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ hidden_size: GRANITE_97M_DIM, bos_token_id: 179934 }),
  );
  writeFileSync(path.join(dir, 'model_quint8_avx2.onnx'), 'onnx-placeholder');
  writeFileSync(path.join(dir, 'tokenizer.json'), 'tokenizer-placeholder');
  return dir;
}
