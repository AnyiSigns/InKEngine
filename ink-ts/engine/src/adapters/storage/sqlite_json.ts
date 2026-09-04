/**
 * sqlite 落库前的严格 JSON 序列化（镜像 Python json.dumps 的拒绝语义）。
 *
 * checkpoint/records 落库列是 TEXT（JSON），Python 侧 json.dumps 遇到
 * 不可序列化对象（类实例/循环引用等）抛 TypeError → 后端统一包成
 * StorageError。TS 的 JSON.stringify 对类实例静默容错（无自有键 → "{}"），
 * 若不先做形态断言，含非 JSON 对象的状态会在切库后悄悄丢数据——本模块
 * 在 stringify 前递归断言 JSON 安全形态，非法值显式抛 TypeError。
 *
 * 与 storage_records.jsonableStrip 的关系：marker（PatchChain/Message/
 * ToolCall）已内联为普通 dict，本模块只兜底残余的非 JSON 叶值。
 */

/** 普通对象判定（仅 dict 形态参与 JSON 递归）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertJsonSafe(value: unknown, seen: Set<object>): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return;
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new TypeError('值不可 JSON 序列化');
  }
  const obj = value as object;
  if (seen.has(obj)) throw new TypeError('循环引用不可 JSON 序列化');
  if (Array.isArray(value)) {
    seen.add(value);
    try {
      for (const item of value) assertJsonSafe(item, seen);
    } finally {
      seen.delete(value);
    }
    return;
  }
  if (isPlainObject(value)) {
    seen.add(value);
    try {
      for (const key of Object.keys(value)) assertJsonSafe(value[key], seen);
    } finally {
      seen.delete(value);
    }
    return;
  }
  throw new TypeError('对象不可 JSON 序列化');
}

/**
 * JSON.stringify 前先做形态断言（循环引用/类实例等不可序列化形态抛
 * TypeError，与 Python json.dumps 同口径），再序列化为紧凑 JSON 文本。
 */
export function strictDumps(value: unknown): string {
  assertJsonSafe(value, new Set<object>());
  return JSON.stringify(value) ?? 'null';
}

/** 断言值 JSON 安全；不安全时抛 TypeError（写前校验用，不产出文本）。 */
export function assertJsonSafeValue(value: unknown): void {
  assertJsonSafe(value, new Set<object>());
}
