/**
 * 远端 OpenAI 兼容 /embeddings（embedder.rs remote_embed 的 TS 同位）。
 *
 * 只发协议级 HTTP（厂商仅是端点配置）；单/多输入同批次语义与 Rust
 * 一致（data 数组按 index 排序、逐项 L2 归一保持单位球面、维度与计划
 * 不符拒绝）。超时经 AbortController（秒）。fetch 可注入（测试）。
 */

import { l2Normalize } from './deterministic.js';
import type { RemoteEmbeddingEndpoint } from './resolve_plan.js';

/** fetch 实现形态（缺省 = 全局 fetch）。 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

/** 远端嵌入（OpenAI 兼容 /embeddings）。 */
export async function remoteEmbed(
  endpoint: RemoteEmbeddingEndpoint,
  texts: readonly string[],
  fetchImpl: FetchLike = defaultFetch,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const input: unknown = texts.length === 1 ? texts[0] : texts;
  const base = endpoint.base_url.replace(/\/+$/, '');
  const url = `${base}/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, endpoint.timeout_secs) * 1000);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.api_key !== undefined && endpoint.api_key !== null && endpoint.api_key !== '') {
    headers['authorization'] = `Bearer ${endpoint.api_key}`;
  }
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: endpoint.model_id, input }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`远端 embedding 请求失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`远端 embedding 返回 ${response.status}（endpoint: ${url}）`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`远端 embedding 响应解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return coerceRemoteVectors(payload);
}

/** 远端响应 → 向量列表（data 数组按 index 排序；逐项 L2 归一）。 */
export function coerceRemoteVectors(payload: unknown): number[][] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new Error('远端 embedding 响应缺 data 数组');
  }
  const indexed: { index: number; vector: number[] }[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as { index?: unknown; embedding?: unknown };
    const index =
      typeof obj.index === 'number' && Number.isInteger(obj.index) ? obj.index : indexed.length;
    const raw = obj.embedding;
    if (!Array.isArray(raw)) {
      throw new Error('远端 embedding 响应缺 embedding 数组');
    }
    const vector: number[] = new Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      const value = raw[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('远端 embedding 含非数值元素');
      }
      vector[i] = value;
    }
    indexed.push({ index, vector });
  }
  indexed.sort((a, b) => a.index - b.index);
  for (const entry of indexed) l2Normalize(entry.vector);
  return indexed.map((entry) => entry.vector);
}
