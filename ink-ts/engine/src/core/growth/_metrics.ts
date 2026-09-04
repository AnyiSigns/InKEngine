/**
 * 成长指标时序（复利实证数据面：观测层，纯 append 不碰机制）。
 *
 * 独立集合 growth_metrics、单键滚动缓冲（METRICS_CAP 条上限防无限膨胀），
 * 与审计 set_audit 严格分离（不污染审计历史）。指标存储为 duck-typed 的
 * records 两原语（get_record/put_record），core 零 IO——实现由宿主注入。
 *
 * TS seam 差异：Python time.time() 的时间戳改为注入的 now（缺省确定值，
 * 纯函数可复现）；Python logging.warning 留痕属可观测性副作用，core 不落
 * ——写入失败一律跳过不抛（观测不阻断沉淀）。
 */

import type { JsonRecord } from '../json.js';
import { METRICS_CAP, METRICS_COLLECTION, METRICS_KEY } from './_constants.js';

/** 指标存储的最小契约（duck-typed 两原语；与知识集/审计存储同构）。 */
export interface MetricStore {
  get_record(collection: string, key: string): Promise<Record<string, unknown> | null>;
  put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void>;
}

/** 读取记录中的 items 清单（非法/缺失形态一律回落空表）。 */
function items_of(record: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (record === null || record === undefined) return [];
  const items = record['items'];
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

/** 追加一条成长指标快照（单键滚动缓冲，上限 METRICS_CAP 条）。 */
export async function append_metric_snapshot(
  store: MetricStore | null | undefined,
  snapshot_of: () => Record<string, unknown>,
  now: () => number,
): Promise<void> {
  if (store === null || store === undefined) return;
  try {
    const snapshot: Record<string, unknown> = { ...snapshot_of(), ts: now() };
    const record = await store.get_record(METRICS_COLLECTION, METRICS_KEY);
    const items = items_of(record);
    items.push(snapshot);
    const capped = items.length > METRICS_CAP ? items.slice(-METRICS_CAP) : items;
    await store.put_record(METRICS_COLLECTION, METRICS_KEY, { items: capped });
  } catch {
    // 成长指标快照写入失败只跳过（Python 记 warning；core 零 IO 不落）
  }
}

/** 读取成长指标时序（按 ts 升序，取最近 limit 条；无存储 = 空）。 */
export async function read_metric_series(
  store: MetricStore | null | undefined,
  limit: number = 120,
): Promise<Array<Record<string, unknown>>> {
  if (store === null || store === undefined) return [];
  try {
    const record = await store.get_record(METRICS_COLLECTION, METRICS_KEY);
    const items = items_of(record);
    const sorted = [...items].sort(
      (left, right) => Number(left['ts'] || 0) - Number(right['ts'] || 0),
    );
    return sorted.slice(-limit);
  } catch {
    return [];
  }
}
