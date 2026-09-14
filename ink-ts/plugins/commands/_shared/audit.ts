/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/audit.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * audit.export/list 两命令共享限流/排序/参数校验。
 */

import { BridgeError } from '@ink-ts/host';

/** 导出窗口上限（默认 500；超出显式给参限流）。 */
export const DEFAULT_EXPORT_LIMIT = 500;

export function parseLimit(raw: unknown, fallback: number): number {
  const params = raw as { limit?: unknown } | null;
  if (params === null || params.limit === undefined || params.limit === null) {
    return fallback;
  }
  const limit = Number(params.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new BridgeError('audit.export limit 须为正数', 'invalid_params');
  }
  return Math.min(Math.floor(limit), 10_000);
}

/** 记录时间戳排序（ts 数值为主，无 ts 排末尾）。 */
export function sortByTs(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return [...records].sort((a, b) => {
    const aTs = typeof a['ts'] === 'number' ? a['ts'] : -1;
    const bTs = typeof b['ts'] === 'number' ? b['ts'] : -1;
    return bTs - aTs;
  });
}

/** audit.list 窗口参数（limit/after/kind；形态非法显式拒绝）。 */
export function parseListParams(raw: unknown): { limit: number; after: number | null; kind: string | null } {
  const params = raw as { limit?: unknown; after?: unknown; kind?: unknown } | null;
  let limit = DEFAULT_EXPORT_LIMIT;
  if (params !== null && params.limit !== undefined && params.limit !== null) {
    const value = Number(params.limit);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BridgeError('audit.list limit 须为正数', 'invalid_params');
    }
    limit = Math.min(Math.floor(value), 10_000);
  }
  let after: number | null = null;
  if (params !== null && params.after !== undefined && params.after !== null) {
    const value = Number(params.after);
    if (!Number.isFinite(value)) {
      throw new BridgeError('audit.list after 须为 epoch 秒数值', 'invalid_params');
    }
    after = value;
  }
  let kind: string | null = null;
  if (params !== null && params.kind !== undefined && params.kind !== null) {
    if (typeof params.kind !== 'string' || params.kind === '') {
      throw new BridgeError('audit.list kind 须为非空字符串', 'invalid_params');
    }
    kind = params.kind;
  }
  return { limit, after, kind };
}

/** 记录 kind 判定（审计记录按 kind 字段归类；type 为历史兼容别名）。 */
export function recordKind(record: Record<string, unknown>): string {
  const kind = record['kind'];
  if (typeof kind === 'string' && kind !== '') return kind;
  const type = record['type'];
  return typeof type === 'string' ? type : '';
}
