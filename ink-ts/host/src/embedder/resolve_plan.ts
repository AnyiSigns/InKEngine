/**
 * 嵌入计划解析（embedder.rs resolve_plan 语义的 TS 同位镜像）。
 *
 * host 侧 AsyncEmbedder 适配器按环境三选一（infer client / 远端
 * openai_compatible / 确定性保底），解析规则与 infer 内一致——优先序：
 * 远端（INK_EMBEDDING_BASE_URL + INK_EMBEDDING_MODEL 配齐）→ 本地显式
 * 跳过（INK_EMBEDDING_LOCAL ∈ off/0/false/no/skip/disable）→ 本地模型
 * （目录 + config 维度 + onnx/tokenizer 齐备，source = local_infer →
 * infer 子进程承载推理）→ 确定性保底。任何一步失败带原因落保底。
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** 模型维度（config.json hidden_size=384；与 infer GRANITE_97M_DIM 对偶）。 */
export const GRANITE_97M_DIM = 384;

/** 模型目录默认位置（相对进程当前目录；可用 INK_EMBEDDING_MODEL_DIR 覆盖）。 */
export const GRANITE_MODEL_DIR_DEFAULT = 'inkling/models/granite-97m';

/** 本地 ONNX 图/分词器/配置文件约定名（与 infer 常量对偶）。 */
export const LOCAL_MODEL_FILES = ['model_quint8_avx2.onnx', 'tokenizer.json', 'config.json'] as const;

/** 远端适配器注册名默认值。 */
export const REMOTE_ADAPTER_DEFAULT = 'openai_compat';

/** 远端调用超时默认值（秒）。 */
export const REMOTE_TIMEOUT_DEFAULT_SECS = 60;

/** 嵌入来源（wire 名）。 */
export type EmbeddingSourceName = 'local_infer' | 'remote' | 'deterministic';

/** 远端端点描述（OpenAI 兼容 /embeddings）。 */
export interface RemoteEmbeddingEndpoint {
  base_url: string;
  model_id: string;
  adapter: string;
  api_key?: string | null;
  timeout_secs: number;
}

/** 嵌入计划（解析产物；来源/维度/降级原因可观测）。 */
export interface EmbeddingPlan {
  source: EmbeddingSourceName;
  dim: number;
  note: string | null;
  remote: RemoteEmbeddingEndpoint | null;
}

/** 环境读取面（注入便于纯函数测试）。 */
export type PlanEnvLookup = (key: string) => string | undefined;

function envLookupFrom(env: NodeJS.ProcessEnv): PlanEnvLookup {
  return (key) => env[key];
}

function isLocalSkip(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  return ['off', '0', 'false', 'no', 'skip', 'disable'].includes(value.toLowerCase());
}

/** 读取 config.json 的 hidden_size（缺失/非数 = null）。 */
function readHiddenSize(modelDir: string): { hidden_size: number | null; bos_token_id: number | null; error?: string } {
  try {
    const raw = readFileSync(path.join(modelDir, 'config.json'), 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const hidden = typeof config['hidden_size'] === 'number' ? (config['hidden_size'] as number) : null;
    const bos = typeof config['bos_token_id'] === 'number' ? (config['bos_token_id'] as number) : null;
    return { hidden_size: hidden, bos_token_id: bos };
  } catch (error) {
    return {
      hidden_size: null,
      bos_token_id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析嵌入计划（纯函数：环境经 lookup 注入，模型检查只读文件系统）。
 *
 * @param opts.modelDir 模型目录覆盖（缺省 GRANITE_MODEL_DIR_DEFAULT；
 *   INK_EMBEDDING_MODEL_DIR 高于两者——与 embedder.rs 同序）。
 */
export function resolveEmbeddingPlan(
  env: NodeJS.ProcessEnv = process.env,
  opts: { modelDir?: string; dim?: number } = {},
): EmbeddingPlan {
  const lookup = envLookupFrom(env);
  const defaultDim = opts.dim ?? GRANITE_97M_DIM;

  const baseUrl = lookup('INK_EMBEDDING_BASE_URL') ?? '';
  const modelId = lookup('INK_EMBEDDING_MODEL') ?? '';
  if (baseUrl !== '' && modelId !== '') {
    const timeoutRaw = lookup('INK_EMBEDDING_REQUEST_TIMEOUT') ?? '';
    const timeoutSecs =
      timeoutRaw !== '' && Number.isFinite(Number(timeoutRaw))
        ? Number(timeoutRaw)
        : REMOTE_TIMEOUT_DEFAULT_SECS;
    const adapterRaw = lookup('INK_EMBEDDING_ADAPTER') ?? '';
    const endpoint: RemoteEmbeddingEndpoint = {
      base_url: baseUrl,
      model_id: modelId,
      adapter: adapterRaw !== '' ? adapterRaw : REMOTE_ADAPTER_DEFAULT,
      timeout_secs: timeoutSecs,
    };
    const apiKey = lookup('INK_EMBEDDING_API_KEY');
    if (apiKey !== undefined && apiKey !== '') endpoint.api_key = apiKey;
    return { source: 'remote', dim: defaultDim, note: null, remote: endpoint };
  }

  const localSkip = lookup('INK_EMBEDDING_LOCAL');
  if (isLocalSkip(localSkip)) {
    return {
      source: 'deterministic',
      dim: defaultDim,
      note: '本地嵌入被 INK_EMBEDDING_LOCAL 显式跳过（确定性保底）',
      remote: null,
    };
  }

  const modelDir = lookup('INK_EMBEDDING_MODEL_DIR') ?? opts.modelDir ?? GRANITE_MODEL_DIR_DEFAULT;
  if (!isDirectory(modelDir)) {
    return {
      source: 'deterministic',
      dim: defaultDim,
      note: `模型目录不存在: ${modelDir}`,
      remote: null,
    };
  }

  const config = readHiddenSize(modelDir);
  if (config.error !== undefined || config.hidden_size === null) {
    return {
      source: 'deterministic',
      dim: defaultDim,
      note: config.error !== undefined ? `模型配置读取失败: ${config.error}` : '模型配置缺 hidden_size 字段',
      remote: null,
    };
  }
  if (config.hidden_size !== GRANITE_97M_DIM) {
    return {
      source: 'deterministic',
      dim: defaultDim,
      note: `模型维度 ${config.hidden_size} 与预期 ${GRANITE_97M_DIM} 不一致（配置文件声明）`,
      remote: null,
    };
  }
  for (const file of LOCAL_MODEL_FILES) {
    if (!isFile(path.join(modelDir, file))) {
      return {
        source: 'deterministic',
        dim: defaultDim,
        note: `模型文件缺失（缺 ${file}）`,
        remote: null,
      };
    }
  }

  return { source: 'local_infer', dim: config.hidden_size, note: null, remote: null };
}
