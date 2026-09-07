/**
 * 结构化日志：耗时/事件流指标记录，避免噪音。
 *
 * 纪律：
 * - 高频事件（reply_token）只记批次级聚合，不逐 token 记录；
 * - 每行带前缀 [inkling] 与字段，便于检索与自动化消费；
 * - debug 级默认静默，指标（event_count/token_count/耗时）按批次输出。
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ENABLED: Record<LogLevel, boolean> = {
  // 高频调试默认关闭；指标与警告常开
  debug: false,
  info: true,
  warn: true,
  error: true,
};

function emit(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (!ENABLED[level]) return;
  const line = fields && Object.keys(fields).length > 0
    ? `${message} ${JSON.stringify(fields)}`
    : message;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
  // eslint-disable-next-line no-console
  console[method](`[inkling:${level}] [${scope}] ${line}`);
}

export const logger = {
  debug: (scope: string, message: string, fields?: Record<string, unknown>) => emit('debug', scope, message, fields),
  info: (scope: string, message: string, fields?: Record<string, unknown>) => emit('info', scope, message, fields),
  warn: (scope: string, message: string, fields?: Record<string, unknown>) => emit('warn', scope, message, fields),
  error: (scope: string, message: string, fields?: Record<string, unknown>) => emit('error', scope, message, fields),
};

/** 耗时计时：返回 stop() 后输出「耗时」指标（毫秒）。 */
export function timer(scope: string, label: string): () => void {
  const start = performance.now();
  return () => {
    emit('debug', scope, `${label} 耗时`, { elapsed_ms: Math.round(performance.now() - start) });
  };
}

/** 事件流批次计数器：按批次 flush 输出，避免高频噪音。 */
export class BatchCounter {
  private count = 0;
  private tokens = 0;

  constructor(
    private scope: string,
    private label: string,
  ) {}

  add(_eventType: string, tokenLength = 0): void {
    this.count += 1;
    this.tokens += tokenLength;
  }

  flush(force = false): void {
    if (this.count === 0) return;
    // 批次不足且未到强制点时静默（聚合输出在批次末执行）
    if (!force && this.count < 8) return;
    emit('debug', this.scope, this.label, {
      batch_events: this.count,
      batch_tokens: this.tokens,
    });
    this.count = 0;
    this.tokens = 0;
  }
}
