/**
 * 规范序列化与确定性哈希（G0.1 的地基）。
 *
 * JS 标准库既没有可复现的整型哈希，`JSON.stringify` 的键序也依赖对象插入顺序；
 * 因此本模块是唯一的序列化/哈希口径，禁止在别处直接 `JSON.stringify` 参与
 * `task_hash`/`signature`/`_skel_id`/`state_digest`。Python 侧不复刻本实现：
 * 跨语言只经 `records.jsonl`/`weights.json`，canonical 序列化由 TS 独占。
 */

import { createHash } from 'node:crypto';

/** IEEE 802.3（zlib.crc32）多项式 0xEDB88320，与 Python `zlib.crc32` 逐位一致。 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 无符号 32 位循环冗余校验（UTF-8 字节流）。 */
export function crc32(s: string): number {
  const bytes = new TextEncoder().encode(s);
  let c = 0xffffffff;
  for (const b of bytes) {
    c = CRC32_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 规范数字格式：整数不带小数点，`-0` 归一为 `0`，非有限值 fail-fast。
 * 小数走 JS 最短往返表示（`0.1`→"0.1"、`1e-7`→"1e-7"），保证同值同串。
 */
export function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`canonicalJson: non-finite number ${String(n)}`);
  }
  if (Number.isInteger(n)) return Object.is(n, -0) ? '0' : String(n);
  return n.toString();
}

function canonicalInner(o: unknown): string {
  if (o === null || o === undefined) return 'null';
  switch (typeof o) {
    case 'boolean':
      return o ? 'true' : 'false';
    case 'number':
      return canonicalNumber(o);
    case 'string':
      return JSON.stringify(o);
    case 'object':
      break;
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof o}`);
  }
  if (Array.isArray(o)) {
    return `[${o.map((v) => canonicalInner(v)).join(',')}]`;
  }
  const rec = o as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalInner(rec[k])}`).join(',')}}`;
}

/** 键排序、数字格式固定、UTF-8 直出（不转义非 ASCII）的规范 JSON。 */
export function canonicalJson(o: unknown): string {
  return canonicalInner(o);
}

/** sha1 前 16 个十六进制字符；与算法规格的 `hashlib.sha1(...).hexdigest()[:16]` 对齐。 */
export function hashObj(o: unknown): string {
  const s = canonicalJson(o);
  return createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16);
}
