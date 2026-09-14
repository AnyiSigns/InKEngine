/**
 * sqlite 落库前的严格 JSON 序列化（严格判定收敛于 _serialize.ts 的
 * assertStrictJson 单实现——内存后端与 sqlite 后端同口径，杜绝「内存后端
 * 静默通过、切 sqlite 即错」的三后端漂移）。
 *
 * checkpoint/records 落库列是 TEXT（JSON），Python 侧 json.dumps 遇到
 * 不可序列化对象（类实例/循环引用等）抛 TypeError → 后端统一包成
 * StorageError。TS 的 JSON.stringify 对类实例静默容错（无自有键 → "{}"），
 * 若不先做形态断言，含非 JSON 对象的状态会在切库后悄悄丢数据——本模块
 * 只做「断言（复用共享判定）→ stringify」两步，无第二套判定逻辑。
 */

import { assertStrictJson } from './_serialize.js';

/**
 * JSON.stringify 前先做形态断言（循环引用/类实例/非有限数值等不可序列化
 * 形态显式拒绝，与 Python json.dumps 同口径），再序列化为紧凑 JSON 文本。
 */
export function strictDumps(value: unknown): string {
  assertStrictJson(value);
  return JSON.stringify(value) ?? 'null';
}
