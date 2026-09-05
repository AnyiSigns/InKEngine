/**
 * host ↔ infer 进程级集成（S5/D10 验收：spawn → plan/embed → 响应）。
 *
 * 走确定性保底路径（INK_EMBEDDING_LOCAL=off）不必载模型；断言来源
 * deterministic、384 维单位向量、与 TS 侧确定性保底算法跨语言对拍
 * （同文同向量，容差内）。infer 二进制经 binary.ts 定位，定位不到 =
 * 未构建 → 整组跳过（须先 `cargo build -p ink_ts_infer`）。
 */

import { describe, expect, it } from 'vitest';

import { locateNativeBinary } from '../../src/exec/binary.js';
import { deterministicVector } from '../../src/embedder/deterministic.js';
import { InferClient } from '../../src/embedder/infer_client.js';
import { GRANITE_97M_DIM } from '../../src/embedder/resolve_plan.js';

const inferBinary = locateNativeBinary('infer');
const describeOrSkip = inferBinary === null ? describe.skip : describe;

function assertClose(a: number, b: number, eps: number): void {
  expect(Math.abs(a - b)).toBeLessThan(eps);
}

describeOrSkip('host ↔ infer 进程级集成（确定性保底路径）', () => {
  it('plan 来源 deterministic（LOCAL=off），不载模型', async () => {
    const client = new InferClient({
      binary: inferBinary!,
      env: { INK_EMBEDDING_LOCAL: 'off' },
    });
    try {
      expect(await client.healthCheck()).toBe(true);
      const plan = await client.plan();
      expect(plan.source).toBe('deterministic');
      expect(plan.dim).toBe(GRANITE_97M_DIM);
      expect(plan.note).not.toBeNull();
    } finally {
      await client.close();
    }
  });

  it('embed 返回 384 维单位向量且与 TS 保底算法对拍一致', async () => {
    const client = new InferClient({
      binary: inferBinary!,
      env: { INK_EMBEDDING_LOCAL: 'off' },
    });
    try {
      const sample = ['语义检索测试输入', 'another query here'];
      const wire = await client.embed(sample);
      expect(wire.source).toBe('deterministic');
      expect(wire.vectors).toHaveLength(sample.length);
      for (const [i, vector] of wire.vectors.entries()) {
        expect(vector).toHaveLength(GRANITE_97M_DIM);
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
        const expected = deterministicVector(sample[i]!, GRANITE_97M_DIM);
        for (let j = 0; j < expected.length; j += 1) {
          assertClose(vector[j]!, expected[j]!, 1e-9);
        }
      }
    } finally {
      await client.close();
    }
  });
});
