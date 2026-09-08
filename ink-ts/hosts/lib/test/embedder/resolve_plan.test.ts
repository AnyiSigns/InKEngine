/**
 * 嵌入计划解析三态规则测试（resolve_plan 镜像 embedder.rs resolve_plan）。
 *
 * 优先级：远端（BASE_URL+MODEL 配齐）> 本地显式跳过 > 本地模型（目录 +
 * config 384 维 + onnx/tokenizer 齐备）> 确定性保底（原因可观测）。
 * 半配置远端（只配 base_url）不生效回落后续规则。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GRANITE_97M_DIM,
  REMOTE_ADAPTER_DEFAULT,
  resolveEmbeddingPlan,
} from '../../src/embedder/resolve_plan.js';

function envOf(record: Record<string, string>): NodeJS.ProcessEnv {
  return { ...record };
}

function fakeModelDir(hiddenSize: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-model-'));
  writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ hidden_size: hiddenSize, bos_token_id: 179934, model_type: 'modernbert' }),
  );
  writeFileSync(path.join(dir, 'model_quint8_avx2.onnx'), 'onnx-placeholder');
  writeFileSync(path.join(dir, 'tokenizer.json'), 'tokenizer-placeholder');
  return dir;
}

describe('resolve_plan 三态解析', () => {
  it('远端配齐 = remote（端点字段解析；adapter 缺省 openai_compat）', () => {
    const plan = resolveEmbeddingPlan(
      envOf({
        INK_EMBEDDING_BASE_URL: 'http://embed.local/v1',
        INK_EMBEDDING_MODEL: 'text-embedding-3-small',
        INK_EMBEDDING_API_KEY: 'sekret',
        INK_EMBEDDING_REQUEST_TIMEOUT: '12',
      }),
      { modelDir: path.join(tmpdir(), 'does-not-exist') },
    );
    expect(plan.source).toBe('remote');
    expect(plan.remote?.model_id).toBe('text-embedding-3-small');
    expect(plan.remote?.adapter).toBe(REMOTE_ADAPTER_DEFAULT);
    expect(plan.remote?.api_key).toBe('sekret');
    expect(plan.remote?.timeout_secs).toBe(12);
  });

  it('半配置远端（只 base_url）不生效 → 回落模型/保底路径', () => {
    const plan = resolveEmbeddingPlan(envOf({ INK_EMBEDDING_BASE_URL: 'http://x/v1' }), {
      modelDir: path.join(tmpdir(), 'missing'),
    });
    expect(plan.source).toBe('deterministic');
  });

  it('INK_EMBEDDING_LOCAL=off 显式跳过 = deterministic（含 note）', () => {
    const plan = resolveEmbeddingPlan(envOf({ INK_EMBEDDING_LOCAL: 'off' }), {
      modelDir: fakeModelDir(GRANITE_97M_DIM),
    });
    expect(plan.source).toBe('deterministic');
    expect(plan.note).toContain('显式跳过');
  });

  it('模型目录齐备 = local_infer（dim 384）', () => {
    const plan = resolveEmbeddingPlan({}, { modelDir: fakeModelDir(GRANITE_97M_DIM) });
    expect(plan.source).toBe('local_infer');
    expect(plan.dim).toBe(GRANITE_97M_DIM);
    expect(plan.note).toBeNull();
  });

  it('config 维度与预期不符 = deterministic（原因带维度）', () => {
    const plan = resolveEmbeddingPlan({}, { modelDir: fakeModelDir(512) });
    expect(plan.source).toBe('deterministic');
    expect(plan.note).toContain('512');
  });

  it('模型目录缺失 = deterministic（原因可观测）', () => {
    const plan = resolveEmbeddingPlan({}, { modelDir: path.join(tmpdir(), 'nope-model') });
    expect(plan.source).toBe('deterministic');
    expect(plan.note).not.toBeNull();
  });

  it('INK_EMBEDDING_MODEL_DIR 优先于 opts.modelDir（同 embedder.rs 序）', () => {
    const real = fakeModelDir(GRANITE_97M_DIM);
    const plan = resolveEmbeddingPlan(
      { INK_EMBEDDING_MODEL_DIR: real },
      { modelDir: path.join(tmpdir(), 'opts-ignored') },
    );
    expect(plan.source).toBe('local_infer');
  });
});
