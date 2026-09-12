/**
 * JSON 兼容值与工具（core 统一数据形态）。深层值操作保证确定性：
 * stableStringify 排序键（对齐 Python json.dumps(sort_keys=True)），
 * deepEqual 做结构比较（状态回流/补丁前缀去重用）。
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonRecord = { [key: string]: Json };

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function typeName(value: unknown): string {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (isRecord(value)) return 'dict';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'number') return 'int';
  if (typeof value === 'boolean') return 'bool';
  return typeof value;
}

export function deepCopy(value: Json): Json {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value !== null && typeof value === 'object') {
    const out: JsonRecord = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepCopy(v as Json);
    return out;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const k of keysA) {
      if (!(k in b)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}
