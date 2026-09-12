/**
 * 读侧校验内核（`data/store.ts` 按 ≤350 行纪律拆出；外部边界唯一校验口径）。
 *
 * `parseLine`：所有盘上回读共用——JSON 可解析 + 顶层字段集恰为 F.2 九字段 +
 * 类型正确 + meta 坐标齐全 + style/family 值域（fail-fast，错误信息带 `where`
 * 定位）；load 与 append 都过这条。
 * `verifyForLoad`：`load()` 在此之上追加 `meta.c_hash` 重算复核（篡改/寻址错误
 * 即抛）。c_hash 复核只在 load 做：append 回读旧行只为算去重键，且写侧必重算
 * 寻址，提前拒读反伤正常追加路径。写侧包裹与读侧复核共用本文件的唯一寻址公式。
 */

import { hashObj } from '../world/hash.js';
import type { Family, Style } from '../schema.js';
import type { StoreRecord } from './store.js';

export const SPLIT_VALUES: readonly string[] = ['train', 'val', 'heldout'];
export const STYLE_VALUES: readonly Style[] = ['follow', 'goal'];
export const FAMILY_VALUES: readonly Family[] = ['value', 'verify', 'goal', 'goal_verify'];

const TOP_FIELDS = ['style', 'family', 'instruction', 'x', 'state', 'hist', 'candidates', 'target', 'meta'];

function metaWithoutHash(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta };
  delete out.c_hash;
  return out;
}

/** 内容寻址唯一公式：meta 去 `c_hash` 后整条记录 `hashObj`（canonical 规范序列化）。 */
function contentHashOf(rec: StoreRecord, bareMeta: Record<string, unknown>): string {
  return hashObj({ ...rec, meta: bareMeta });
}

/** 写侧包裹：补/刷 meta.c_hash；自身不参与重算，故幂等。 */
export function withContentHash(rec: StoreRecord): StoreRecord {
  const bare = metaWithoutHash(rec.meta);
  return { ...rec, meta: { ...bare, c_hash: contentHashOf(rec, bare) } };
}

/** 读侧复核：declared c_hash 与重算值逐字比对，不匹配 fail-fast 带定位。 */
function verifyContentHash(rec: StoreRecord, where: string): void {
  const declared = rec.meta.c_hash;
  const actual = contentHashOf(rec, metaWithoutHash(rec.meta));
  if (typeof declared !== 'string' || declared !== actual) {
    throw new Error(
      `store schema: ${where} meta.c_hash 复核失败（declared=${String(declared)} actual=${actual}，内容被篡改或寻址错误）`,
    );
  }
}

/** 外部边界校验：字段集恰为 F.2 + meta 坐标齐全 + style/family 值域 + c_hash 复核。 */
export function validateRecord(raw: unknown, where: string): StoreRecord {
  const r = raw as Partial<StoreRecord> & { meta?: Record<string, unknown> };
  if (r === null || typeof r !== 'object') throw new Error(`store schema: ${where} 不是对象`);
  if (Object.keys(r).sort().join(',') !== [...TOP_FIELDS].sort().join(',')) {
    throw new Error(`store schema: ${where} 字段集不符 F.2（实际：${Object.keys(r).sort().join(',')}）`);
  }
  if (typeof r.instruction !== 'string' || typeof r.target !== 'string') {
    throw new Error(`store schema: ${where} instruction/target 类型错误`);
  }
  if (!Array.isArray(r.hist) || !Array.isArray(r.candidates)) {
    throw new Error(`store schema: ${where} hist/candidates 必须为数组`);
  }
  const st = r.state as Record<string, unknown> | undefined;
  if (st === undefined || st === null || typeof st !== 'object' || Array.isArray(st)) {
    throw new Error(`store schema: ${where} state 必须为对象`);
  }
  const meta = r.meta as Record<string, unknown>;
  for (const field of ['task_hash', 'split', 'composition_id', 'plan_hash']) {
    if (typeof meta[field] !== 'string') {
      throw new Error(`store schema: ${where} meta.${field} 缺失或非字符串`);
    }
  }
  if (typeof meta.step_index !== 'number' || !Number.isInteger(meta.step_index)) {
    throw new Error(`store schema: ${where} meta.step_index 缺失或非整数`);
  }
  if (typeof r.style !== 'string' || !STYLE_VALUES.includes(r.style)) {
    throw new Error(`store schema: ${where} style=${String(r.style)} 不在 {follow,goal}`);
  }
  if (typeof r.family !== 'string' || !FAMILY_VALUES.includes(r.family)) {
    throw new Error(`store schema: ${where} family=${String(r.family)} 不在 {value,verify,goal,goal_verify}`);
  }
  return r as StoreRecord;
}

/**
 * `load()` 的读侧复核：style/family 值域已由 `validateRecord` 统一挡住，这里只
 * 补 `meta.c_hash`——用写侧同一公式对整条重算比对，篡改即抛，报错含 `分片#行号`。
 * 独立于 append 回读路径：append 只需结构校验即可算去重键，写侧必重算寻址，
 * 提前按 hash 拒读反伤正常追加（见文件头）。
 */
export function verifyForLoad(rec: StoreRecord, where: string): StoreRecord {
  verifyContentHash(rec, where);
  return rec;
}

/** JSON 行解析 + 全链校验（load 与 append 的盘上回读共用同一入口）。 */
export function parseLine(line: string, where: string): StoreRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`store schema: ${where} 不是合法 JSON 行`);
  }
  return validateRecord(raw, where);
}
