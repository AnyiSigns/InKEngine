/** LLM 错误规范化与分类——对标 pytest TestLLMErrorSanitization。
 *
 *  与 Python 差异：传输异常在 TS 端走 duck-typing（按异常构造函数名判定），
 *  不依赖 httpx；状态码与文本关键词判定与 Python 完全对齐。
 */

import { describe, expect, it } from 'vitest';

import {
  LLMAuthError,
  LLMError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
  classify_llm_error,
} from '../../../src/core/llm/errors.js';

describe('LLM 错误规范化（对象级不变量）', () => {
  it('detail redacted in message and detail', () => {
    const exc = new LLMAuthError('', 'Incorrect API key provided: sk-abcdef1234567890xyz');
    expect(String(exc)).not.toContain('sk-abcdef1234567890xyz');
    expect(exc.detail ?? '').not.toContain('sk-abcdef1234567890xyz');
    expect(exc.detail ?? '').toContain('[REDACTED]');
  });

  it('control chars stripped（C0 + DEL）', () => {
    const exc = new LLMError('', 'line1\r\nline2\x1b[31mANSI\x07');
    expect(exc.detail ?? '').not.toContain('\r');
    expect(exc.detail ?? '').not.toContain('\n');
    expect(exc.detail ?? '').not.toContain('\x1b');
    expect(exc.detail ?? '').not.toContain('\x07');
  });

  it('detail truncated to 200 chars', () => {
    const exc = new LLMError('', 'x'.repeat(500));
    expect(exc.detail).not.toBeNull();
    expect((exc.detail ?? '').length).toBeLessThanOrEqual(200);
  });

  it('default message when empty（LLMTimeoutError 默认「超时」）', () => {
    expect(String(new LLMTimeoutError())).toContain('超时');
  });

  it('status code written to instance', () => {
    expect(classify_llm_error(429).status_code).toBe(429);
    expect(classify_llm_error(401).status_code).toBe(401);
    expect(classify_llm_error(503).status_code).toBe(503);
    expect(new LLMRateLimitError().status_code).toBe(429);
  });

  it('classify 408 → LLMTimeoutError', () => {
    const exc = classify_llm_error(408);
    expect(exc).toBeInstanceOf(LLMTimeoutError);
    expect(exc.status_code).toBe(408);
  });

  it('keyword fallback classification（中文文案「服务繁忙」→ LLMServerError）', () => {
    const exc = classify_llm_error(null, '服务繁忙，请稍后重试');
    expect(exc).toBeInstanceOf(LLMServerError);
    expect(exc).toBeInstanceOf(LLMError);
  });

  it('exc with Timeout suffix → LLMTimeoutError', () => {
    class ReadTimeout extends Error {}
    const exc = classify_llm_error(null, null, new ReadTimeout('timed out'));
    expect(exc).toBeInstanceOf(LLMTimeoutError);
  });

  it('exc with ConnectError → LLMNetworkError', () => {
    class ConnectError extends Error {}
    const exc = classify_llm_error(null, null, new ConnectError('refused'));
    expect(exc.constructor.name).toBe('LLMNetworkError');
  });

  it('exc with unknown name → LLMUnknownError', () => {
    class WeirdError extends Error {}
    const exc = classify_llm_error(null, null, new WeirdError('???'));
    expect(exc.constructor.name).toBe('LLMUnknownError');
    expect((exc as LLMError).detail).toBe('WeirdError: ???');
  });

  it('no status code and no keywords → LLMUnknownError', () => {
    const exc = classify_llm_error();
    expect(exc.constructor.name).toBe('LLMUnknownError');
  });
});