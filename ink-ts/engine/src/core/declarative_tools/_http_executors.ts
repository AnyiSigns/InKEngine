/**
 * 声明式工具的网络执行体默认工厂（declarative_tools.py
 * make_http_fetch_executor / make_controlled_fetch_executor 移植）。
 *
 * Python 端这两工厂以可选依赖 httpx 惰性导入（缺失时调用即显式报错）；
 * TS core 零 IO、零第三方——网络实现在宿主侧，经 HttpStreamClient seam
 * 注入（构造工厂时可选传入；缺省 = 调用时显式报错，与 Python 缺装
 * httpx 同语义，绝不静默）。执行体本身只做受控流式读取：
 *
 * - make_http_fetch_executor：超时 + 文本流式读取 + 字符上限截断
 *   （ENG6-9：不再整读响应再截断——响应流式消费，超限即停，防超大
 *   响应 OOM）；域名白名单经 build_declarative_pipeline 的
 *   network_policy 并入沙箱环节（守卫在前，执行在后，执行体不自行
 *   判断域名）。
 * - make_controlled_fetch_executor：collect_material url 档受控取回
 *   （契约对齐 旧侧 exec collect.rs url 分支产物：``{ok, source:"url",
 *   url, status, content_type, bytes, truncated, content}``）——字节封顶
 *   截断 + 溢出标记 + UTF-8 文本（lossy 解码）。仅 http/https 出网。
 *
 * 执行体为宿主可覆盖默认：经 DeclarativeToolExecutors.register 按端点
 * 类型（或 RETRIEVAL_CONTROLLED_FETCH 键）注入自定义实现后即生效。
 */
import { isRecord } from '../json.js';
import { DEFAULT_MAX_RESULT_CHARS } from '../tool_pipeline/_types.js';
import { url_split } from './_url.js';
import type { DeclarativeExecutor } from './executors.js';

/** 流式 HTTP 响应 seam（httpx.stream().aiter_text/aiter_bytes 的镜像）。 */
export interface HttpStreamResponse {
  readonly status_code: number;
  readonly headers: Readonly<Record<string, unknown>>;
  /** 文本块异步迭代（字符级；http_fetch 用）。 */
  aiter_text(): AsyncIterable<string>;
  /** 字节块异步迭代（受控取回用）。 */
  aiter_bytes(): AsyncIterable<Uint8Array>;
}

/** 网络执行 seam（httpx.AsyncClient.stream 的镜像；真实网络实现由宿主注入）。 */
export interface HttpStreamClient {
  stream(
    method: string,
    url: string,
    headers: Readonly<Record<string, unknown>>,
  ): Promise<HttpStreamResponse>;
}

export interface MakeHttpFetchOptions {
  timeout?: number;
  max_chars?: number;
  client?: HttpStreamClient | null;
}

/**
 * 默认 http_fetch 执行体（网络 seam 未注入时调用即显式报错）。
 *
 * 仅做受控抓取：超时 + 流式读取 + 字节上限截断（响应流式消费，超限即
 * 停，防超大响应 OOM）；域名白名单经流水线 network_policy 并入沙箱
 * 环节（守卫在前，执行在后）。
 */
export function make_http_fetch_executor(
  options: MakeHttpFetchOptions = {},
): DeclarativeExecutor {
  const timeout = options.timeout ?? 30.0;
  const max_chars = options.max_chars ?? DEFAULT_MAX_RESULT_CHARS;
  const client: HttpStreamClient | null = options.client ?? null;

  const execute: DeclarativeExecutor = async (ctx, definition, args, approval) => {
    if (client === null) {
      throw new Error(
        'http_fetch 执行体需宿主注入网络 seam（HttpStreamClient）——core 零 IO，网络实现在宿主侧',
      );
    }
    const config = definition.endpoint_config;
    const method = String(config['method'] ?? args['method'] ?? 'GET').toUpperCase();
    const url = args['url'];
    if (typeof url !== 'string' || !url) {
      throw new Error(`工具 ${definition.name} 缺 url 参数`);
    }
    const headers = config['headers'] ?? args['headers'] ?? {};
    if (!isRecord(headers)) throw new Error('headers 须为 dict');
    const response = await client.stream(method, url, headers);
    // 流式读取 + 上限（ENG6-9）：响应不整读进内存——按 max_chars 消费
    // 字符流，超出即停（溢出标记与整读语义一致）
    let body = '';
    let overflow = false;
    for await (const chunk of response.aiter_text()) {
      const room = max_chars - body.length;
      if (room <= 0) {
        overflow = true;
        break;
      }
      const take = chunk.slice(0, room);
      body += take;
      if (chunk.length > room) {
        overflow = true;
        break;
      }
    }
    if (overflow) body += '\n…（溢出截断）';
    return `HTTP ${response.status_code}\n${body}`;
  };
  return execute;
}

export interface MakeControlledFetchOptions {
  timeout?: number;
  default_max_bytes?: number;
  client?: HttpStreamClient | null;
}

/**
 * collect_material url 档受控取回执行体（引擎默认；宿主可注入覆盖）。
 *
 * 契约对齐 = 旧侧 exec collect.rs url 分支产物（exec 为真源，本执行体
 * 与 exec 出参同形态）：``{ok, source:"url", url, status, content_type,
 * bytes, truncated, content}``——体积上限（缺省 1 MiB）、字节封顶截断 +
 * 溢出标记、UTF-8 文本（字节截断后 lossy 解码，与 exec 代理契约同口径）。
 * 仅 http/https 出网；域名策略/审批在门禁与沙箱环节先行（执行体不再
 * 自行判定域名）。
 */
export function make_controlled_fetch_executor(
  options: MakeControlledFetchOptions = {},
): DeclarativeExecutor {
  const default_max_bytes = options.default_max_bytes ?? 1024 * 1024;
  const client: HttpStreamClient | null = options.client ?? null;

  const execute: DeclarativeExecutor = async (ctx, definition, args, approval) => {
    const url = args['url'];
    if (typeof url !== 'string' || !url) {
      throw new Error(`工具 ${definition.name} url 档缺 url 参数`);
    }
    const text = args['text'];
    if (typeof text === 'string' && text) {
      throw new Error('url 与 text 二选一（一次调用只采一个来源）');
    }
    const { scheme } = url_split(url);
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error('仅支持 http(s):// 取回');
    }
    if (client === null) {
      throw new Error(
        'collect_material url 档执行体需宿主注入网络 seam（HttpStreamClient）——core 零 IO，网络实现在宿主侧',
      );
    }
    const rawMax = args['max_bytes'];
    let max_bytes = default_max_bytes;
    if (typeof rawMax === 'number' && Number.isFinite(rawMax)) {
      max_bytes = Math.max(1, Math.trunc(rawMax));
    } else if (
      typeof rawMax === 'string' &&
      rawMax.trim() !== '' &&
      Number.isFinite(Number(rawMax))
    ) {
      max_bytes = Math.max(1, Math.trunc(Number(rawMax)));
    }
    const response = await client.stream('GET', url, {});
    const raw: number[] = [];
    let overflow = false;
    for await (const chunk of response.aiter_bytes()) {
      const room = max_bytes - raw.length;
      if (room <= 0) {
        overflow = true;
        break;
      }
      const take = chunk.slice(0, room);
      raw.push(...take);
      if (chunk.length > room) {
        overflow = true;
        break;
      }
    }
    const content = new TextDecoder('utf-8').decode(new Uint8Array(raw));
    return JSON.stringify({
      ok: true,
      source: 'url',
      url,
      status: response.status_code,
      content_type: String(response.headers['content-type'] ?? ''),
      bytes: raw.length,
      truncated: overflow,
      content,
    });
  };
  return execute;
}
