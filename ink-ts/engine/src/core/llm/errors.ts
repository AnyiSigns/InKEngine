/**
 * LLM 层异常体系（数据形态模块，零 IO）。
 *
 * 上游响应文本（detail）进入异常前在对象级统一规范化：控制字符剥离 →
 * 长度截断 → 敏感形态遮蔽。message 与 detail 双遮蔽，对象级不变量，
 * 调用方不再二次过滤。
 *
 * classify_llm_error 把 HTTP 状态码 / 传输异常名 / 上游文本关键词映射为
 * 语义化异常：retryable（瞬时）= 超时 / 限流 / 网络 / 5xx / 空流；
 * 确定性失败 = 认证 / 请求非法 / 模型不存在。瞬时集合供重试与备用切换
 * 策略判定，认证类不切备用（fail-closed，防密钥失效被静默掩盖）。
 *
 * 敏感的 redact 文本规范移植自 core.logging.redact（仅借用正则表达式与
 * 失败安全语义，不引入日志/控制台设施，core 保持零 IO）。
 */

import { EngineError } from '../errors.js';
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_SEGMENT_TYPES,
  ROLES,
  ROLE_ALIASES,
  type Role,
} from './_types.js';

// 内部常量化导出（保持文件 ≤350 行；上游响应文本规范化逻辑集中）。

/** 上游响应文本进入异常前的规范化上限。 */
const DETAIL_MAX_LEN = 200;

/** 控制字符剥离正则（C0 + DEL，防日志注入与终端干扰）。 */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g;

// 遮蔽规则镜像 core/logging.py：日志侧/出站侧共享同一份事实源；不引入
// logging 设施，仅借用正则与失败安全语义。
// 注：Python re 的内联 (?i) 在 JS 不支持，统一以 RegExp /i 标志承载。
const REDACT_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_\-]{8,}/g,
  /(?<![A-Za-z0-9])(?:gsk_|xai-|pplx-|sk-ant-|hf_|ghp_|github_pat_|glpat-)[A-Za-z0-9_\-]{8,}/g,
  /\bAIza[0-9A-Za-z_\-]{25,}\b/g,
  /(api[-_]?key|token|secret|password|authorization)\s*[=:]\s*\S+/gi,
  /\b(authorization|proxy-authorization)\b[^,;\r\n]*/gi,
  /\bbearer\s+[A-Za-z0-9._\-]+/gi,
  /"(api[-_]?key|token|secret|password|authorization)"\s*:\s*"[^"]*"/gi,
  /(?:postgres(?:ql)?|mysql|redis|amqp):\/\/[^@\s/]+@/g,
  /[?&](?:key|token|api_key|access_token|secret)=[^&\s]+/g,
];

/** 纯 redact：失败时不遮蔽也不崩溃（非字符串输入亦兜底返回 str 形态）。 */
export function redact(text: string): string {
  try {
    let out = text;
    for (const pattern of REDACT_PATTERNS) {
      out = out.replace(pattern, '[REDACTED]');
    }
    return out;
  } catch {
    return String(text);
  }
}

/** 规范化上游文本：先遮蔽后截断（边界切短时遮蔽规则不失配）。 */
function normalize(text: string): string {
  // 全局正则的 lastIndex 状态会污染后续调用，每次新建实例确保幂等。
  const stripped = text.replace(new RegExp(CONTROL_CHAR_RE.source, 'g'), ' ');
  const masked = redact(stripped);
  return masked.length > DETAIL_MAX_LEN ? masked.slice(0, DETAIL_MAX_LEN) : masked;
}

/** LLM 调用失败基类（重试/备用策略按子类语义判定）。 */
export class LLMError extends EngineError {
  readonly status_code: number | null;
  readonly detail: string | null;

  constructor(
    message: string = '',
    detail: string | null = null,
    status_code: number | null = null,
  ) {
    const normMessage = message ? normalize(message) : '';
    const normDetail = detail ? normalize(detail) : null;
    const base = normMessage || 'LLM 调用失败';
    super(normDetail ? `${base}（${normDetail}）` : base);
    this.name = 'LLMError';
    this.status_code = status_code;
    this.detail = normDetail;
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 请求超时', detail, status_code);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = 429) {
    super(message || 'LLM 请求被限流', detail, status_code);
    this.name = 'LLMRateLimitError';
  }
}

export class LLMNetworkError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 网络错误', detail, status_code);
    this.name = 'LLMNetworkError';
  }
}

export class LLMServerError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 服务端错误', detail, status_code);
    this.name = 'LLMServerError';
  }
}

export class LLMEmptyStreamError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 流为空', detail, status_code);
    this.name = 'LLMEmptyStreamError';
  }
}

export class LLMAuthError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 认证失败', detail, status_code);
    this.name = 'LLMAuthError';
  }
}

export class LLMBadRequestError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 请求被拒绝', detail, status_code);
    this.name = 'LLMBadRequestError';
  }
}

export class LLMNotFoundError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 模型不存在', detail, status_code);
    this.name = 'LLMNotFoundError';
  }
}

export class LLMConfigError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 配置非法', detail, status_code);
    this.name = 'LLMConfigError';
  }
}

export class LLMFormatError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 响应格式非法', detail, status_code);
    this.name = 'LLMFormatError';
  }
}

export class LLMUnknownError extends LLMError {
  constructor(message: string = '', detail: string | null = null, status_code: number | null = null) {
    super(message || 'LLM 未知错误', detail, status_code);
    this.name = 'LLMUnknownError';
  }
}

// 上游错误响应文本关键词 → 瞬时故障分类（吸收 core/errors.classify_model_error
// 的文本兜底：国内 MaaS 常见「服务繁忙/过载」等文案错误帧无状态码可依）。
type LLMErrorCtor = new (message?: string, detail?: string | null, status_code?: number | null) => LLMError;

type KeywordRule = readonly [readonly string[], LLMErrorCtor];

const TRANSIENT_KEYWORDS: readonly KeywordRule[] = [
  [['timeout', 'timed out', '读超时', '连接超时'], LLMTimeoutError],
  [['quota', 'rate limit', 'too many', '限流', '频率', '额度'], LLMRateLimitError],
  [
    ['connection', 'network', 'refused', '连接失败', '网络错误', '网络异常'],
    LLMNetworkError,
  ],
  [
    [
      'overload',
      'server error',
      'server_error',
      'unavailable',
      'service busy',
      '繁忙',
      '过载',
      '服务暂时不可用',
      '服务不可用',
      '暂时不可用',
      '稍后再试',
    ],
    LLMServerError,
  ],
];

function classifyByKeywords(detail: string | null): LLMErrorCtor | null {
  if (!detail) return null;
  const lowered = detail.toLowerCase();
  for (const [keywords, cls] of TRANSIENT_KEYWORDS) {
    if (keywords.some((k) => lowered.includes(k))) return cls;
  }
  return null;
}

/** HTTP 状态码 / 传输异常 / 上游文本关键词 → 语义化 LLMError。 */
export function classify_llm_error(
  status_code: number | null = null,
  detail: string | null = null,
  exc: Error | null = null,
): LLMError {
  if (exc !== null) {
    const name = exc.constructor.name;
    if (exc instanceof Error && exc.name === 'TimeoutError') {
      return new LLMTimeoutError('', detail, null);
    }
    if (name.endsWith('Timeout')) return new LLMTimeoutError('', detail, null);
    const networkNames = new Set([
      'ConnectError',
      'RemoteProtocolError',
      'ReadError',
      'StreamError',
      'BrokenStreamError',
      'TransportError',
      'NetworkError',
      'HTTPError',
      'RequestError',
    ]);
    if (networkNames.has(name)) return new LLMNetworkError('', detail, null);
    return new LLMUnknownError('', `${name}: ${exc.message}`, null);
  }
  if (status_code === null) {
    const cls = classifyByKeywords(detail);
    return cls ? new cls('', detail, null) : new LLMUnknownError('', detail, null);
  }
  if (status_code === 408) return new LLMTimeoutError('', detail, status_code);
  if (status_code === 429 || status_code === 402) return new LLMRateLimitError('', detail, status_code);
  if (status_code === 401 || status_code === 403) return new LLMAuthError('', detail, status_code);
  if (status_code === 404) return new LLMNotFoundError('', detail, status_code);
  if (status_code === 400 || status_code === 422) return new LLMBadRequestError('', detail, status_code);
  if (status_code >= 500 && status_code <= 599) return new LLMServerError('', detail, status_code);
  return new LLMUnknownError('', detail, status_code);
}

/** 瞬时故障判定：超时 / 限流 / 网络 / 5xx / 空流。 */
export function is_transient_llm_error(exc: unknown): boolean {
  return (
    exc instanceof LLMTimeoutError ||
    exc instanceof LLMRateLimitError ||
    exc instanceof LLMNetworkError ||
    exc instanceof LLMServerError ||
    exc instanceof LLMEmptyStreamError
  );
}

// 内部导出：仅供 messages.ts 复用（不在 __all__ 公开列表中）。
export { ROLES, ATTACHMENT_KINDS, ATTACHMENT_SEGMENT_TYPES, ROLE_ALIASES };
export type { Role };