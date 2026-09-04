/**
 * 纯 TS SHA-256（hashlib.sha256(...).hexdigest() 的镜像，64 位小写 hex）。
 *
 * core 禁 node:* / 第三方依赖（graph 模块 FNV-1a 的同一选型约束）——产物
 * 内容寻址依赖 sha256 契约（算法引擎内置，不交宿主定制，防跨宿主 artifact
 * id 漂移），故以纯函数实现：输入 Uint8Array → 64 字符小写 hex。实现按
 * FIPS 180-4 编排，块内 64 轮压缩，消息长度按 64 位拆高低 32 位字写入
 * 填充尾部（大输入不溢出）。
 */

/** 每轮常量（前 64 个素数立方根的小数部分取高 32 位）。 */
const _K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 循环右移（JS 移位按 32 位语义，>>> 保无符号）。 */
function _rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 大端读 32 位字（填充后消息的调度字来源）。 */
function _word_at(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  ) >>> 0;
}

/** sha256 摘要：Uint8Array → 64 字符小写 hex。 */
export function sha256_hex(data: Uint8Array): string {
  const len = data.length;
  // 消息位长（64 位）拆高低字：2^29 字节 = 2^32 位为进位界
  const bit_hi = Math.floor(len / 0x20000000);
  const bit_lo = ((len % 0x20000000) * 8) >>> 0;
  // 填充：追加 0x80 → 补零到 56 字节对齐 → 尾部 8 字节位长
  const block_count = Math.floor((len + 8) / 64) + 1;
  const padded = new Uint8Array(block_count * 64);
  padded.set(data);
  padded[len] = 0x80;
  const tail = padded.length - 8;
  padded[tail] = (bit_hi >>> 24) & 0xff;
  padded[tail + 1] = (bit_hi >>> 16) & 0xff;
  padded[tail + 2] = (bit_hi >>> 8) & 0xff;
  padded[tail + 3] = bit_hi & 0xff;
  padded[tail + 4] = (bit_lo >>> 24) & 0xff;
  padded[tail + 5] = (bit_lo >>> 16) & 0xff;
  padded[tail + 6] = (bit_lo >>> 8) & 0xff;
  padded[tail + 7] = bit_lo & 0xff;

  // 初始哈希值（前 8 个素数平方根的小数部分取高 32 位）
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let block = 0; block < block_count; block++) {
    const base = block * 64;
    for (let t = 0; t < 16; t++) {
      W[t] = _word_at(padded, base + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15]!;
      const w2 = W[t - 2]!;
      const s0 = _rotr(w15, 7) ^ _rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = _rotr(w2, 17) ^ _rotr(w2, 19) ^ (w2 >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
    }

    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!;
    let e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + _K[t]! + W[t]!) >>> 0;
      const S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i++) {
    out += H[i]!.toString(16).padStart(8, '0');
  }
  return out;
}
