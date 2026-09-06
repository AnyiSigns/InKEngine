/**
 * SSE/错误体解析共享模块（openai_compat / openai_responses / anthropic
 * 三协议复用）：data 帧解码、HTTP 错误体 detail 提取、SSE error 值拆分、
 * 上游错误码 → HTTP 状态码提示。三协议的解析层只保留各自事件分派与
 * 增量形态转换，公共原语不再各自复制。
 *
 * 状态码提示词汇覆盖 openai 兼容族（code 关键词）与 anthropic 族
 * （error type 枚举字符串），任一协议的错误帧 code/type 字段均可分类；
 * 404 特殊规则（"not" + "exist" 短语）保留 openai_compat 既有口径。
 */
import { classify_llm_error } from '../../core/llm/errors.js';

/** 请求默认超时（秒；三协议共享常量，对齐 Python DEFAULT_REQUEST_TIMEOUT）。 */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 120;

/** 超时换算共享原语：秒 → ms（非正/非法收敛到最小 1ms，与 anthropic 口径）。 */
export function request_timeout_ms(request_timeout?: number | null): number {
  const raw = request_timeout ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
  return Math.max(1, Math.round(raw * 1000));
}

/** 普通对象判定（非 null 非数组对象）。 */
export function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从 JSON 记录取字符串字段（缺省 null）。 */
export function get_str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * 解析一条 SSE 行：data 帧载荷 JSON 化返回；注释/非 data 行/空帧/
 * [DONE]/坏 JSON 一律返回 null（调用方跳过——坏帧容错不中断整个流）。
 */
export function sse_data_json(line: string): unknown | null {
  const text = line.trim();
  if (!text.startsWith('data:')) return null;
  const data = text.slice('data:'.length).trim();
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * 从 HTTP 错误响应体提取 detail（error.message / error 字符串 / error 对象
 * 序列化；JSON 解析失败或无 error 段返回 null）。
 */
export function error_detail_from_body(body: string): string | null {
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  if (!is_record(obj)) return null;
  const error = obj['error'];
  return error_parts(error).detail;
}

/**
 * SSE error 值拆分：dict 形态取 message（缺省整体序列化）与 code/type
 * 分类码；字符串/其他形态整值作 detail。Anthropic 以 type 承载分类
 * （authentication_error 等），openai 族以 code 承载——两字段都读取。
 */
export function error_parts(error: unknown): { detail: string | null; code: unknown } {
  if (is_record(error)) {
    const message = error['message'];
    const detail = typeof message === 'string' ? message : JSON.stringify(error);
    const code = error['code'] ?? error['type'] ?? null;
    return { detail, code };
  }
  return { detail: typeof error === 'string' ? error : String(error), code: null };
}

// 状态码提示桶：按 code/type 词汇命中（下划线分隔，lower 后 includes 匹配）
const _HINT_400 = [
  'invalid_request',
  'invalid_parameter',
  'invalid_params',
  'context_length',
  'context_overflow',
  'max_tokens',
  'max_output_tokens',
  'length',
  'bad_request',
  'request_error',
  'request_too_large',
] as const;
const _HINT_429 = ['rate', 'quota', 'limit', 'throttl'] as const;
const _HINT_403 = ['permission'] as const;
const _HINT_401 = [
  'auth',
  'api_key',
  'apikey',
  'key invalid',
  'invalid key',
  'invalid_key',
  'key_invalid',
  'authentication',
] as const;
const _HINT_408 = ['timeout', 'timed'] as const;
const _HINT_500 = ['api_error', 'internal'] as const;
const _HINT_503 = ['overload', 'unavailable', 'server error', 'server_error', 'service', 'busy'] as const;

/** 从上游错误 code/type 猜测 HTTP 状态码（分类提示，无则 null）。 */
export function status_hint(code: unknown): number | null {
  if (typeof code !== 'string') return null;
  const lowered = code.toLowerCase();
  const hits = (markers: readonly string[]): boolean =>
    markers.some((marker) => lowered.includes(marker));
  if (hits(_HINT_400)) return 400;
  if (hits(_HINT_429)) return 429;
  // openai_compat 404 口径：not_found 或 "not"+“exist” 短语
  if (
    lowered.includes('not_found') ||
    (lowered.includes('not') && lowered.includes('exist'))
  ) {
    return 404;
  }
  if (hits(_HINT_403)) return 403;
  if (hits(_HINT_401)) return 401;
  if (hits(_HINT_408)) return 408;
  if (hits(_HINT_500)) return 500;
  if (hits(_HINT_503)) return 503;
  return null;
}

/** 按状态码提示分类抛 LLMError（SSE error 帧共用入口）。 */
export function raise_error_frame(error: unknown): never {
  const parts = error_parts(error);
  throw classify_llm_error(status_hint(parts.code), parts.detail);
}

/** HTTP 状态检查共享入口（三协议统一）：≥400 读错误体分类抛 LLMError；
 *  错误体读取失败不阻断（状态码本身足以分类）。 */
export async function raise_for_status(response: {
  readonly status: number;
  body_text(): Promise<string>;
}): Promise<void> {
  if (response.status < 400) return;
  let body = '';
  try {
    body = await response.body_text();
  } catch {
    // 读错误体失败：状态码分类不受影响
  }
  throw classify_llm_error(response.status, error_detail_from_body(body));
}
